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
// Scripts, styles, fonts, and UI vector/icon assets ONLY. Images and streaming
// media are deliberately excluded so they meter: scrapers were fetching reddit
// image/video links directly through us, bypassing the gate. Images go through
// the SW like any GET (per-request ride/spend); video/audio bypass the SW
// entirely, so they ride a session the SW keeps topped up (see topUp()).
const STATIC_RE = /\.(?:css|js|mjs|map|svg|ico|woff2?|ttf|eot)(?:\?|$)/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Console stats, enabled by the server's PP_DEBUG (surfaced as `debug` in
// /pp/config). Logs land in the page DevTools console (Chrome) or the worker
// console (Firefox about:debugging). Never log token VALUES — they are bearer
// credentials; counts and balances only.
let DBG = false;
function dbg(...args) {
  if (DBG) console.log('[pp-sw]', ...args);
}

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
    if (!client || typeof client.navigate !== 'function') return;
    // Never bounce a tab that's already on a /pp/ page (the activation page).
    // Otherwise a gated sub-resource OF that page — e.g. /favicon.ico when the
    // pool is empty — navigates it to itself, reloading forever and making the
    // activation page unreachable.
    if (new URL(client.url).pathname.startsWith('/pp/')) return;
    await client.navigate('/pp/activate?exhausted=1');
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
  // Force cookies on EVERY metered fetch. Some resources — notably the web app
  // manifest — are fetched credential-less by the browser; without this they
  // reach the gate cookieless, 401, and trick the SW into "renewing" a session
  // that was actually fine, popping (and losing) a token the server ignores.
  // Same-origin only here (cross-origin returns early), so include == same-origin.
  return fetch(new Request(request, { headers, credentials: 'include' }));
}

// Open a fresh session by spending exactly one token. Single-flight: when a
// session drains, the flood of concurrent 401s from that same drain all attach
// to this one in-flight attempt (during its network RTT) instead of each burning
// a token. It is CLEARED as soon as it settles — so the very next drain boundary
// renews immediately rather than riding a stale "already renewed" promise. (An
// earlier version kept it settled for the whole session lifetime, which made the
// first 401 after every exact drain do a wasted no-op renewal + re-ride before
// the real one — a visible hiccup when a video segment burst lands on the
// boundary. Clearing on settle removes that: the same-drain herd still coalesces
// because it attaches before the RTT completes.) True if a session opened, false
// if the pool is empty.
let sessionRenewal = null;

function renewSession() {
  if (!sessionRenewal) {
    sessionRenewal = (async () => {
      const db = await openDB();
      // Pop tokens until one opens a session. Already-spent tokens (e.g. from an
      // imported, partially-used pool) make the verifier answer 401 — discard
      // and try the next, bounded so a fully-spent pool can't spin forever.
      for (let tries = 0; tries < 16; tries++) {
        const token = await popToken(db);
        if (!token) {
          dbg('renew: pool empty');
          return false;
        }
        const headers = new Headers();
        headers.set('X-PP-SW', '1');
        headers.set('Authorization', `PrivateToken token="${token}"`);
        // One minimal gated request the verifier meters — it mints the session
        // cookie. Body ignored.
        const r = await fetch(new Request('/', { headers, redirect: 'manual' })).catch(() => null);
        const remaining = await countTokens(db);
        broadcast({ type: 'pp-remaining', remaining });
        if (r && r.status === 401) {
          dbg(`renew: token rejected (spent/stale), ${remaining} left, retrying`);
          continue; // token was spent/invalid — next
        }
        dbg(`renew: new session opened, 1 token spent, ${remaining} left`);
        return true;
      }
      return false;
    })().finally(() => {
      // Clear on settle so the next drain triggers a real renewal, not a no-op
      // ride of this now-stale promise.
      sessionRenewal = null;
    });
  }
  return sessionRenewal;
}

// Proactive session top-up. Media (video/audio) bypasses the SW and rides the
// session directly at the nginx gate, but can't trigger the reactive renewal
// above — so we keep the session FUNDED ahead of time. When a metered response
// reports the balance dropping below sessionTopUpThreshold, spend one token to
// ADD points to the live session (POST /pp/refill, which keeps the same cookie).
// Single-flight so a burst of low-balance responses coalesces into one token.
let sessionTopUp = null;

function topUp() {
  if (!sessionTopUp) {
    sessionTopUp = (async () => {
      const db = await openDB();
      for (let tries = 0; tries < 16; tries++) {
        const token = await popToken(db);
        if (!token) {
          dbg('topup: pool empty');
          return false; // pool empty — nothing to top up with
        }
        const headers = new Headers();
        headers.set('X-PP-SW', '1');
        headers.set('Authorization', `PrivateToken token="${token}"`);
        const r = await fetch('/pp/refill', { method: 'POST', headers }).catch(() => null);
        const remaining = await countTokens(db);
        broadcast({ type: 'pp-remaining', remaining });
        if (r && r.status === 401) {
          dbg(`topup: token rejected (spent/stale), ${remaining} left, retrying`);
          continue; // dead/spent token — try the next
        }
        if (r && r.ok) {
          const body = await r
            .clone()
            .json()
            .catch(() => null);
          dbg(`topup: session now ${body ? body.points : '?'} pts, 1 token spent, ${remaining} left`);
        }
        return !!(r && r.ok);
      }
      return false;
    })().finally(() => {
      sessionTopUp = null;
    });
  }
  return sessionTopUp;
}

// If a metered response shows the session running low, fund it (non-blocking so
// the current response isn't delayed). Exempt assets have no X-PP-Points header.
async function maybeTopUp(res, event) {
  const hdr = res.headers.get('X-PP-Points');
  if (!hdr) return; // absent/empty => not a metered response
  const points = Number(hdr);
  if (!Number.isFinite(points)) return;
  const cfg = await getConfig();
  const threshold = (cfg && cfg.sessionTopUpThreshold) || 200000;
  if (points >= threshold) return;
  dbg(`session ${points} pts < threshold ${threshold}, topping up`);
  event.waitUntil(topUp());
}

// Metering config (requests-per-token, refill buffer), fetched once and cached.
let configPromise = null;
function getConfig() {
  if (!configPromise) {
    configPromise = fetch('/pp/config')
      .then((r) => r.json())
      .then((cfg) => {
        DBG = !!(cfg && cfg.debug);
        return cfg;
      })
      .catch(() => null);
  }
  return configPromise;
}

// Fetch the config early so DBG is set for this SW lifetime, and log a
// startup line with the pool/session state (each browser wake of the SW is a
// fresh lifetime, so this also marks restarts in the console).
getConfig().then(async (cfg) => {
  if (!cfg || !cfg.debug) return;
  const tokens = await countTokens(await openDB()).catch(() => -1);
  const pts = await fetch('/pp/points')
    .then((r) => r.json())
    .catch(() => null);
  dbg(`started: ${tokens} tokens pooled, session=${pts ? pts.points : '?'} pts`);
});

// True when the token pool is within the refill buffer, so a new page should be
// steered to re-activate (the buffer is left to finish already-started loads).
async function withinRefillBuffer() {
  const cfg = await getConfig();
  if (!cfg || !cfg.requestsPerToken) return false;
  const reserveTokens = Math.ceil(cfg.refillBufferRequests / cfg.requestsPerToken);
  const tokens = await countTokens(await openDB());
  if (tokens < 0) return false; // couldn't read the pool — don't force a refill
  return tokens <= reserveTokens;
}

function exhausted(request, event) {
  dbg(`EXHAUSTED: no tokens left (${request.mode === 'navigate' ? 'redirecting' : 'navigating owner'} to activate)`);
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
    dbg('pool within refill buffer, steering navigation to /pp/activate?refill=1');
    return Response.redirect('/pp/activate?refill=1', 302);
  }

  // 1. Try riding the current session cookie.
  let res = await ride(request);
  if (res.status !== 401) {
    dbg(`ride ${res.status} pts=${res.headers.get('X-PP-Points') ?? '-'} ${new URL(request.url).pathname}`);
    maybeTopUp(res, event); // keep the session funded for SW-invisible media
    return res;
  }
  dbg(`401 (no/drained session) for ${new URL(request.url).pathname}, renewing`);

  // 2. No live session (first request, or it drained). Renew (coalesced across
  //    the concurrent herd — one token per session) and re-ride, at most twice.
  for (let i = 0; i < 2; i++) {
    const attempt = renewSession();
    const opened = await attempt;
    if (!opened) return exhausted(request, event);
    res = await ride(request);
    if (res.status !== 401) {
      maybeTopUp(res, event);
      return res;
    }
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

// Best-effort proactive top-up while the SW is alive. NOTE: browsers terminate
// idle service workers (~30s), so this timer does NOT reliably run during pure
// media playback with no other requests — the header-driven maybeTopUp() and the
// large per-token session buffer are the real safeguards. This only helps when
// the SW is otherwise kept warm by ongoing activity.
async function checkAndTopUp() {
  const cfg = await getConfig();
  const threshold = (cfg && cfg.sessionTopUpThreshold) || 200000;
  const r = await fetch('/pp/points')
    .then((x) => x.json())
    .catch(() => null);
  if (!r) return;
  // Only maintain an EXISTING draining session; a drained/absent one (points 0)
  // is handled by the reactive renewal on the next real request.
  if (r.points > 0 && r.points < threshold) await topUp();
}

setInterval(checkAndTopUp, 10000);
