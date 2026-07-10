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

// The last code that successfully drew tokens on this origin. Codes are
// balances drawn in capped batches, so the SW's refill/exhausted redirects can
// top up from it silently instead of asking the user to re-type it. Cleared
// only when the server definitively says the code is dead (404), never on
// network errors.
const CODE_KEY = 'pp_code';

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

// Returns true iff a draw completed and tokens landed in IndexedDB (the silent
// top-up path needs to know whether to bounce back or show the manual form).
async function activate(): Promise<boolean> {
  if (inFlight) return false;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    setStatus('Enter your invite code.', 'err');
    return false;
  }
  // SW + WebCrypto need a secure context; without one the flow can't work. Fail
  // loudly instead of hanging on "Setting up…" (the http:// symptom).
  if (!self.isSecureContext) {
    setStatus('This page must be opened over https:// — check the address bar.', 'err');
    return false;
  }
  inFlight = true;
  goBtn.disabled = true;
  setStatus('Setting up…');

  try {
    // 1. Register the service worker so it can attach tokens site-wide.
    await ensureServiceWorker();

    // 2. Validate the code and learn how many tokens to make. For a faucet code
    //    with nothing accrued yet the server answers 429 {error:'empty'}.
    const info = await fetch(`/pp/issue-info?code=${encodeURIComponent(code)}`);
    if (!info.ok) {
      const err = (await info.json().catch(() => ({}))) as { error?: string };
      // 404 = the code is definitively dead; forget it so the silent top-up
      // stops retrying. A 429 faucet just hasn't accrued yet — keep it.
      if (info.status === 404 && localStorage.getItem(CODE_KEY) === code) {
        localStorage.removeItem(CODE_KEY);
      }
      fail(
        err.error === 'empty'
          ? 'No requests have built up on this code yet — check back later.'
          : 'That code is invalid or used up.',
      );
      return false;
    }
    // `quota` = this draw (capped batch); `remaining` = the code's full balance.
    const { quota, remaining } = (await info.json()) as { quota: number; remaining?: number };

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
        if (resp.status === 409) {
          // Concurrent draws from other devices are legal, so a 409 can mean
          // "the balance ran short this instant" while the code still holds
          // tokens. Re-check before forgetting it: only a definitive 404 from
          // issue-info means the code is dead.
          const gone =
            (await fetch(`/pp/issue-info?code=${encodeURIComponent(code)}`).catch(() => null))
              ?.status === 404;
          if (gone && localStorage.getItem(CODE_KEY) === code) {
            localStorage.removeItem(CODE_KEY);
          }
          fail(
            gone
              ? 'This code has no tokens left. Enter a new one.'
              : 'This draw collided with another device — try again.',
          );
        } else {
          fail('Issuance failed — please try again, or ask for a new code.');
        }
        return false;
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

      // Remember the code for silent top-ups (last successful draw wins).
      localStorage.setItem(CODE_KEY, code);

      bar.hidden = true;
      setStatus(`You're set up — ${total} requests available on this device.`, 'ok');
      const left = (remaining ?? quota) - quota;
      if (left > 0) {
        statusEl.append(
          document.createElement('br'),
          `Your code has ${left} tokens left — this device will top up from it automatically.`,
        );
      }
      const link = document.createElement('a');
      link.href = '/';
      link.textContent = 'Continue to the site →';
      statusEl.append(document.createElement('br'), link);
      return true;
    } finally {
      for (const worker of pool) worker.terminate();
    }
  } catch (err) {
    console.error(err);
    fail(`Something went wrong: ${(err as Error).message}`);
    return false;
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

// Both credentials live in real <form>s with password-type fields so password
// managers offer to save the code/password on submit and autofill them later.
// preventDefault keeps the browser from actually POSTing the form — the action
// URLs only exist for managers to file the entries under.
document.getElementById('code-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  activate();
});
document.getElementById('pw-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  unlock();
});

// Merge another code's remaining balance into this device's saved code
// (POST /pp/merge) so the user keeps a single code. Destination: the code that
// last drew here, falling back to whatever is typed in the main field.
const mergeInput = document.getElementById('mergecode') as HTMLInputElement | null;
const mergeBtn = document.getElementById('do-merge') as HTMLButtonElement | null;
document.getElementById('merge-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!mergeInput || !mergeBtn) return;
  const from = mergeInput.value.trim().toUpperCase();
  const into = (localStorage.getItem(CODE_KEY) ?? codeInput.value.trim()).toUpperCase();
  if (!from) {
    setStatus('Enter the code you want to merge.', 'err');
    return;
  }
  if (!into) {
    setStatus('No saved code on this device yet — activate one first, then merge into it.', 'err');
    return;
  }
  if (from === into) {
    setStatus('That is already your saved code — enter the other one.', 'err');
    return;
  }
  mergeBtn.disabled = true;
  setStatus('Merging…');
  try {
    const resp = await fetch('/pp/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, into }),
    });
    const body = (await resp.json().catch(() => ({}))) as {
      merged?: number;
      remaining?: number;
      error?: string;
    };
    if (resp.ok) {
      mergeInput.value = '';
      setStatus(`Merged ${body.merged} tokens — your code now holds ${body.remaining}.`, 'ok');
    } else if (body.error === 'unknown_from') {
      setStatus('That code is unknown (or already merged/revoked).', 'err');
    } else if (body.error === 'unknown_into') {
      setStatus('Your saved code no longer exists on the server — activate a fresh code first.', 'err');
    } else if (body.error === 'not_mergeable') {
      setStatus('Faucet codes cannot be merged — only ordinary balance codes.', 'err');
    } else if (body.error === 'empty') {
      setStatus('That code has no tokens left to merge.', 'err');
    } else {
      setStatus('Merge failed — please try again.', 'err');
    }
  } catch (err) {
    setStatus(`Something went wrong: ${(err as Error).message}`, 'err');
  } finally {
    mergeBtn.disabled = false;
  }
});

// The code input is type=password purely for manager heuristics; codes aren't
// shoulder-surfing secrets on the same level, so let the user unmask to check
// for typos.
const showCode = document.getElementById('show-code') as HTMLInputElement | null;
showCode?.addEventListener('change', () => {
  codeInput.type = showCode.checked ? 'text' : 'password';
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

// Where a redirect back should land: the same-origin path from ?return=, or
// '/' when absent/unsafe. Path-only — must start with exactly one '/' (rejects
// '//host' and the '/\host' browser quirk) and can't smuggle a scheme.
function returnDest(params: URLSearchParams): string {
  const ret = params.get('return');
  return ret && /^\/(?!\/|\\)/.test(ret) ? ret : '/';
}

async function init() {
  // Service workers and WebCrypto (crypto.subtle, used by the blind-RSA workers)
  // are secure-context ONLY. Over plain http:// they're simply absent, so the
  // whole flow wedges silently on "Setting up…". This origin is only ever meant
  // to be reached via https (nginx terminates TLS), so upgrade an http:// visit
  // in place rather than let it fail. localhost is a secure context, so skip it.
  if (
    location.protocol === 'http:' &&
    location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1'
  ) {
    location.replace('https://' + location.host + location.pathname + location.search);
    return;
  }

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
      location.replace(returnDest(params));
      return;
    }
  }

  // SW low/empty redirects. With a remembered code (a balance drawn in capped
  // batches), top up silently and bounce back to where the user was; only fall
  // through to the manual form when there is no stored code, the draw fails,
  // or the timestamp gate says we just tried (breaks any redirect loop, e.g. a
  // draw too small to clear the refill buffer).
  let silentFailed = false;
  if (params.get('refill') === '1' || params.get('exhausted') === '1') {
    const stored = localStorage.getItem(CODE_KEY);
    const last = Number(sessionStorage.getItem('pp-redraw-ts') || 0);
    if (stored && Date.now() - last > 5000) {
      sessionStorage.setItem('pp-redraw-ts', String(Date.now()));
      codeInput.value = stored;
      setStatus('Topping up from your saved code…');
      if (await activate()) {
        location.replace(returnDest(params));
        return;
      }
      // activate() already set the error copy (and forgot a dead code); show
      // the manual form without redirecting again.
      silentFailed = true;
    }
  }

  // Prefill from an activation link (?code=...). We deliberately do NOT
  // auto-submit: link prefetchers and message/email preview crawlers fetch the
  // URL, and auto-activation would burn the code before the human clicks.
  const linkCode = params.get('code');
  if (linkCode) {
    codeInput.value = linkCode.trim().toUpperCase();
    // The code was visible in the link anyway — unmask so it can be checked.
    if (showCode) {
      showCode.checked = true;
      codeInput.type = 'text';
    }
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

  if (silentFailed) {
    // Keep the specific error from the failed silent draw on screen.
  } else if (params.get('exhausted') === '1') {
    setStatus('Your tokens on this device are used up. Enter a code to continue.', 'err');
  } else if (params.get('refill') === '1') {
    setStatus('Running low on requests — enter a code to top up (they stack).', 'err');
  }

  // Purchases are env-gated server-side; unhide the "buy one" link only when
  // the endpoint answers (404 = feature off, page stays inert).
  const buyLine = document.getElementById('buyline');
  if (buyLine) {
    fetch('/pp/buy/packages')
      .then((r) => {
        if (r.ok) buyLine.hidden = false;
      })
      .catch(() => {});
  }

  // Issuer-key transparency: unlinkability assumes every user is signed by the
  // SAME key — a per-user key would let the operator partition redemptions.
  // Show the key's SHA-256 fingerprint (no code needed; /pp/token-key is
  // public) so users can compare it across devices and with each other.
  void showKeyFingerprint();
}

async function showKeyFingerprint(): Promise<void> {
  const line = document.getElementById('keyline');
  const fp = document.getElementById('key-fp');
  if (!line || !fp || !crypto.subtle) return;
  try {
    const dir = await (await fetch('/pp/token-key')).json();
    const b64 = dir['token-keys'][0]['token-key'] as string;
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // SHA-256 of the token-key — the same value RFC 9578 uses as token_key_id.
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    fp.textContent = Array.from(hash, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .replace(/(.{8})(?=.)/g, '$1 ');
    line.hidden = false;
  } catch {
    // Informative only — never block activation on it.
  }
}
init();
