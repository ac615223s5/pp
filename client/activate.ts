// Activation page logic. Bundled by esbuild into public/activate.js.
//
// Flow: register the service worker -> look up the code's quota -> fetch the
// issuer public key -> fan the blind-RSA work out across a pool of Web Workers
// (blind in parallel) -> POST the whole batch for signing -> fan out again to
// finalize/unblind -> stash the finished tokens in IndexedDB for the SW.
//
// The heavy per-token crypto (~35ms each, pure-JS bignum) is the bottleneck, so
// parallelising it across cores is the main speed win. All crypto lives in
// pp-worker.ts; this file only orchestrates and stores.

// This file has no imports, so mark it a module to keep its scope isolated
// (otherwise it shares globals with the other bundled scripts).
export {};

// ---- IndexedDB token pool -------------------------------------------------

const DB_NAME = 'pp-tokens';
const STORE = 'tokens';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function addTokens(db: IDBDatabase, tokens: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const t of tokens) os.add(t);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function countTokens(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
}

// ---- UI --------------------------------------------------------------------

const codeInput = document.getElementById('code') as HTMLInputElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const pwInput = document.getElementById('pw') as HTMLInputElement;
const unlockBtn = document.getElementById('unlock') as HTMLButtonElement;
const bypassEl = document.getElementById('bypass') as HTMLDetailsElement;

function setStatus(msg: string, cls: '' | 'ok' | 'err' = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

function setProgress(done: number, total: number, label: string) {
  bar.hidden = false;
  bar.value = total ? Math.round((done / total) * 100) : 0;
  setStatus(`${label} ${done}/${total}…`);
}

// ---- worker pool helpers ---------------------------------------------------

interface Shard {
  start: number;
  count: number;
}

// Split `total` items into up to `parts` contiguous shards, as evenly as
// possible. Empty shards are dropped (parts > total).
function makeShards(total: number, parts: number): Shard[] {
  const shards: Shard[] = [];
  const base = Math.floor(total / parts);
  const rem = total % parts;
  let start = 0;
  for (let w = 0; w < parts; w++) {
    const count = base + (w < rem ? 1 : 0);
    if (count > 0) {
      shards.push({ start, count });
      start += count;
    }
  }
  return shards;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// Guard against a second activation firing while one is in progress (e.g. a
// second Enter/click during token generation). A double submit would send two
// /pp/issue requests and burn the code (the loser 409s).
let inFlight = false;

function fail(msg: string) {
  setStatus(msg, 'err');
  bar.hidden = true;
  goBtn.disabled = false;
  inFlight = false;
}

async function activate() {
  if (inFlight) return;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    setStatus('Enter your invite code.', 'err');
    return;
  }
  inFlight = true;
  goBtn.disabled = true;
  setStatus('Setting up…');

  try {
    // 1. Register the service worker so it can attach tokens site-wide.
    await ensureServiceWorker();

    // 2. Validate the code and learn how many tokens to make.
    const info = await fetch(`/pp/issue-info?code=${encodeURIComponent(code)}`);
    if (!info.ok) {
      fail('That code is invalid or already used.');
      return;
    }
    const { quota } = (await info.json()) as { quota: number };

    // 3. Fetch the issuer public key (base64url token-key, passed to workers).
    const dir = await (await fetch('/pp/token-key')).json();
    const pkB64 = dir['token-keys'][0]['token-key'] as string;
    const issuerName = location.hostname;

    // 4. Spin up a worker pool and shard the batch across it.
    const poolSize = Math.min(16, Math.max(1, navigator.hardwareConcurrency || 4));
    const shards = makeShards(quota, poolSize);
    const pool = shards.map(() => new Worker('/pp/pp-worker.js'));

    try {
      // Phase A — blind, in parallel.
      const blindedAll = new Array<string>(quota);
      const blindDone = new Array(pool.length).fill(0);
      await Promise.all(
        pool.map(
          (worker, w) =>
            new Promise<void>((resolve, reject) => {
              const { start, count } = shards[w];
              worker.onerror = (ev) => reject(new Error(ev.message || 'worker error'));
              worker.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'progress' && m.phase === 'blind') {
                  blindDone[w] = m.done;
                  setProgress(sum(blindDone), quota, 'Preparing tokens');
                } else if (m.type === 'blinded') {
                  for (let i = 0; i < m.blinded.length; i++) blindedAll[m.start + i] = m.blinded[i];
                  blindDone[w] = count;
                  setProgress(sum(blindDone), quota, 'Preparing tokens');
                  resolve();
                }
              };
              worker.postMessage({ type: 'blind', start, count, pk: pkB64, issuerName });
            }),
        ),
      );

      // Phase B — sign the whole batch in one request.
      setStatus('Requesting signatures…');
      const resp = await fetch('/pp/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, blinded_tokens: blindedAll }),
      });
      if (!resp.ok) {
        fail(
          resp.status === 409
            ? 'This code was already activated. Ask for a new one.'
            : 'Issuance failed — please try again, or ask for a new code.',
        );
        return;
      }
      const { signatures } = (await resp.json()) as { signatures: string[] };

      // Phase C — finalize/unblind, in parallel. Each shard's worker finalizes
      // the signatures for the same indices it blinded (it holds the state).
      const tokensAll = new Array<string>(quota);
      const finDone = new Array(pool.length).fill(0);
      await Promise.all(
        pool.map(
          (worker, w) =>
            new Promise<void>((resolve, reject) => {
              const { start, count } = shards[w];
              worker.onerror = (ev) => reject(new Error(ev.message || 'worker error'));
              worker.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'progress' && m.phase === 'finalize') {
                  finDone[w] = m.done;
                  setProgress(sum(finDone), quota, 'Finalising');
                } else if (m.type === 'finalized') {
                  for (let i = 0; i < m.tokens.length; i++) tokensAll[m.start + i] = m.tokens[i];
                  finDone[w] = count;
                  setProgress(sum(finDone), quota, 'Finalising');
                  resolve();
                }
              };
              worker.postMessage({ type: 'finalize', start, signatures: signatures.slice(start, start + count) });
            }),
        ),
      );

      // 5. Store for the service worker to spend (appended to any existing pool).
      const db = await openDB();
      await addTokens(db, tokensAll);
      const total = await countTokens(db); // cumulative, since codes stack

      bar.hidden = true;
      setStatus(`You're set up — ${total} requests available on this device.`, 'ok');
      const link = document.createElement('a');
      link.href = '/';
      link.textContent = 'Continue to the site →';
      statusEl.append(document.createElement('br'), link);
    } finally {
      for (const worker of pool) worker.terminate();
    }
  } catch (err) {
    console.error(err);
    fail(`Something went wrong: ${(err as Error).message}`);
  }
}

// ---- operator bypass -------------------------------------------------------

// Exchange the bypass password for a signed cookie. Unlike token activation,
// this spends nothing and needs no service worker: the cookie alone makes the
// nginx gate pass every request. It stays valid on this device until it expires
// or site data is cleared.
async function unlock() {
  const password = pwInput.value;
  if (!password) {
    setStatus('Enter the bypass password.', 'err');
    return;
  }
  unlockBtn.disabled = true;
  setStatus('Unlocking…');
  try {
    const resp = await fetch('/pp/bypass', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (resp.status === 404) {
      setStatus('Bypass is not enabled on this server.', 'err');
      unlockBtn.disabled = false;
      return;
    }
    if (!resp.ok) {
      setStatus('That password is incorrect.', 'err');
      unlockBtn.disabled = false;
      return;
    }
    bar.hidden = true;
    setStatus('Unlocked — unlimited access on this device, no tokens needed.', 'ok');
    const link = document.createElement('a');
    link.href = '/';
    link.textContent = 'Continue to the site →';
    statusEl.append(document.createElement('br'), link);
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${(err as Error).message}`, 'err');
    unlockBtn.disabled = false;
  }
}

goBtn.addEventListener('click', activate);
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') activate();
});
unlockBtn.addEventListener('click', unlock);
pwInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});

// Register the gate's service worker (scope '/') and wait until it is active,
// so a navigation issued right after (the challenge bounce, or the user's next
// click) is actually controlled by it. Idempotent: re-registering an already
// installed SW is a no-op. Bounded so a wedged registration can't hang the page.
async function ensureServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/pp/sw.js', { scope: '/' });
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (err) {
    console.error('service worker registration failed', err);
  }
}

async function init() {
  const params = new URLSearchParams(location.search);

  // Ensure the gate's service worker is installed and active on EVERY visit to
  // this page — it's the component that rides the session and spends tokens, so
  // without it every navigation cold-challenges straight back here. A user who
  // lands here via a challenge redirect (e.g. after unregistering the SW) never
  // submits a code, so registering only in activate() would strand them on this
  // page despite a full token pool. Awaited so the bounce below lands on a page
  // the SW actually controls.
  await ensureServiceWorker();

  // nginx tags its tokenless-request redirect with ?challenge=1. The common
  // cause is a hard refresh, which bypasses the service worker so the request
  // reaches nginx with no token even though the pool is full. If we DO still
  // have tokens, that redirect was spurious: bounce back to where the user was,
  // where a normal navigation goes through the SW and spends a token. The
  // timestamp gate breaks any loop if the SW genuinely isn't attaching.
  if (params.get('challenge') === '1') {
    const n = await countTokens(await openDB());
    const last = Number(sessionStorage.getItem('pp-bounce-ts') || 0);
    if (n > 0 && Date.now() - last > 3000) {
      sessionStorage.setItem('pp-bounce-ts', String(Date.now()));
      const ret = params.get('return');
      const dest = ret && ret.startsWith('/') && !ret.startsWith('//') ? ret : '/';
      location.replace(dest);
      return;
    }
  }

  // Prefill from an activation link (?code=...). We deliberately do NOT
  // auto-submit: link prefetchers and message/email preview crawlers fetch the
  // URL, and auto-activation would burn the code before the human clicks.
  const linkCode = params.get('code');
  if (linkCode) {
    codeInput.value = linkCode.trim().toUpperCase();
    codeInput.focus();
  }

  // Prefill the bypass password from an operator link (?pw=...) and expand the
  // section. Not auto-submitted: the password is reusable so a prefetch can't
  // burn it, but leaving the click to the human keeps it out of surprise POSTs.
  const linkPw = params.get('pw');
  if (linkPw) {
    pwInput.value = linkPw;
    bypassEl.open = true;
    pwInput.focus();
  }

  if (params.get('exhausted') === '1') {
    setStatus('Your tokens on this device are used up. Enter a new code to continue.', 'err');
  } else if (params.get('refill') === '1') {
    setStatus('Running low on requests — activate a new code to top up (they stack).', 'err');
  }
}
init();
