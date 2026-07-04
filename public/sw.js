// Service worker: lazy-spend anonymous tokens against points-metered sessions.
//
// A gated request first tries riding the session cookie (sent automatically by
// the browser). Only when the server challenges (401) do we spend one token,
// which opens a fresh session worth many requests. Static assets and /pp/* are
// never gated. Tokens are pre-formatted base64url strings; no crypto here.

'use strict';

const DB_NAME = 'pp-tokens';
const STORE = 'tokens';

// Assets nginx serves without auth_request — don't waste a token on them.
const STATIC_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)(?:\?|$)/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Transactionally remove and return the oldest token, or null if empty.
// The delete happens inside the same transaction as the read, so two tabs
// cannot pop the same token.
function popToken(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cursorReq = tx.objectStore(STORE).openCursor();
    let value = null;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        value = cursor.value;
        cursor.delete();
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

function countTokens(db) {
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(-1);
  });
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll();
  for (const c of clients) c.postMessage(msg);
}

// Graceful exhaustion: only one navigation should fire even if many sub-resources
// hit the empty pool at once.
let redirecting = false;

async function navigateOwner(clientId) {
  try {
    const client = clientId ? await self.clients.get(clientId) : null;
    if (client && typeof client.navigate === 'function') {
      await client.navigate('/pp/activate?exhausted=1');
    }
  } catch {
    /* client gone / navigation not allowed — ignore */
  }
}

// Re-issue a request carrying the marker header so nginx meters it (and answers
// a missing/drained session with 401 instead of an activate redirect). Cookies
// ride automatically. SW-initiated fetches don't re-enter this fetch handler.
function ride(request) {
  const headers = new Headers(request.headers);
  headers.set('X-PP-SW', '1');
  return fetch(new Request(request, { headers }));
}

// Open a fresh session by spending exactly one token. Coalesced: when a session
// drains mid page-load, the flood of concurrent 401s all share this one attempt
// instead of each burning a token. Kept as a settled promise so late-arriving
// 401s from the same drain ride it too; replaced only when a session drains
// again. Returns true if a session was opened, false if the pool is empty.
let sessionRenewal = null;

function renewSession() {
  if (!sessionRenewal) {
    sessionRenewal = (async () => {
      const db = await openDB();
      const token = await popToken(db);
      if (!token) return false;
      const headers = new Headers();
      headers.set('X-PP-SW', '1');
      headers.set('Authorization', `PrivateToken token="${token}"`);
      // One minimal gated request the verifier meters — it mints the session
      // cookie. Body ignored.
      await fetch(new Request('/', { headers, redirect: 'manual' })).catch(() => {});
      broadcast({ type: 'pp-remaining', remaining: await countTokens(db) });
      return true;
    })();
  }
  return sessionRenewal;
}

// Metering config (requests-per-token, refill buffer), fetched once and cached.
let configPromise = null;
function getConfig() {
  if (!configPromise) {
    configPromise = fetch('/pp/config')
      .then((r) => r.json())
      .catch(() => null);
  }
  return configPromise;
}

// True when the token pool is within the refill buffer, so a new page should be
// steered to re-activate (the buffer is left to finish already-started loads).
async function withinRefillBuffer() {
  const cfg = await getConfig();
  if (!cfg || !cfg.requestsPerToken) return false;
  const reserveTokens = Math.ceil(cfg.refillBufferRequests / cfg.requestsPerToken);
  const tokens = await countTokens(await openDB());
  return tokens <= reserveTokens;
}

function exhausted(request, event) {
  broadcast({ type: 'pp-remaining', remaining: 0 });
  if (request.mode === 'navigate') {
    return Response.redirect('/pp/activate?exhausted=1', 302);
  }
  // Out of tokens on a sub-resource mid-page: navigate the owning tab to the
  // activation page rather than leaving a half-broken page.
  if (!redirecting) {
    redirecting = true;
    event.waitUntil(navigateOwner(event.clientId).finally(() => (redirecting = false)));
  }
  return new Response('privacy-pass: no tokens on this device', {
    status: 429,
    headers: { 'X-PP': 'empty' },
  });
}

async function handle(event) {
  const request = event.request;

  // 0. Refill buffer: steer NEW page loads to re-activate once low, but keep
  //    serving sub-resources so an in-flight load can finish from the buffer.
  if (request.mode === 'navigate' && (await withinRefillBuffer())) {
    return Response.redirect('/pp/activate?refill=1', 302);
  }

  // 1. Try riding the current session cookie.
  let res = await ride(request);
  if (res.status !== 401) return res;

  // 2. No live session (first request, or it drained). Renew (coalesced across
  //    the concurrent herd — one token per session) and re-ride, at most twice.
  for (let i = 0; i < 2; i++) {
    const attempt = renewSession();
    const opened = await attempt;
    if (!opened) return exhausted(request, event);
    res = await ride(request);
    if (res.status !== 401) return res;
    // Still 401: the session we rode is already drained — drop this settled
    // attempt so the next renewSession() opens another, then retry once more.
    if (sessionRenewal === attempt) sessionRenewal = null;
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return; // same-origin only
  if (request.headers.get('X-PP-SW')) return; // our own ride/renew fetch — pass through
  if (url.pathname.startsWith('/pp/')) return; // never gate the pp endpoints
  if (request.method !== 'GET') return; // initial version: gate GET only
  if (STATIC_RE.test(url.pathname)) return; // static assets: no token

  event.respondWith(handle(event));
});
