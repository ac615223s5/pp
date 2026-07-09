// HTTP surface, all under /pp/ except the internal /verify target that nginx's
// auth_request rewrites to. See deploy notes in README / nginx.conf.

import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { loadOrCreateIssuer } from './keys.js';
import { PP } from './pp.js';
import { mintBypassCookie, verifyBypassCookie } from './bypass.js';
import { createInvoice, getInvoice, verifyWebhookSig } from './btcpay.js';
import { generateCode, generateClaimToken } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Read a single named cookie from a Cookie header, or null.
function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`));
  return m ? m[1] : null;
}

// Three cost classes, picked from the original request URI (X-Original-URI;
// $request_uri includes the query, so the trailing (?|$) anchors an extension
// immediately followed by ? or end):
//   streaming (cheapest) — audio/video: HLS/DASH segments + manifests,
//     progressive files, piped's /videoplayback, nitter's encoded /video/<enc>.
//     A low flat floor: the real pricing signal for these is the size-based
//     PP_POINTS_PER_MIB component their Range/range= hints carry.
//   media — images, incl. nitter's extensionless /pic/<enc>.
//   default — everything else (documents, APIs).
const STREAM_EXT_RE =
  /\.(?:mp4|webm|m4v|mov|ts|m3u8|mpd|mp3|m4a|ogg|oga|opus|wav)(?:\?|$)/i;
const STREAM_PREFIX_RE = /^\/(?:video\/|videoplayback(?:[/?]|$))/i;
const MEDIA_EXT_RE = /\.(?:jpg|jpeg|png|gif|webp|bmp|avif)(?:\?|$)/i;
const MEDIA_PREFIX_RE = /^\/pic\//i;

// How many bytes a request declares it is asking for, or null when it carries
// no size hint. Sources, in order of preference:
//   1. googlevideo-style query params (piped /videoplayback): range=a-b is the
//      exact byte span of the segment; clen=N is the full resource length.
//   2. The HTTP Range header, forwarded by the gate as X-PP-Range:
//      bytes=a-b (closed), bytes=-N (suffix), bytes=a- (open-ended — resolved
//      against clen when the URI declares one, otherwise unknown).
//   3. clen alone (no range anywhere): the whole resource is being fetched.
// The client cannot understate this: the range determines what the upstream
// returns, so it gets exactly the bytes it paid for.
function requestedBytes(uri: string | undefined, rangeHeader: string | undefined): number | null {
  let clen: number | null = null;
  if (uri) {
    const c = uri.match(/[?&]clen=(\d+)(?:&|$)/i);
    if (c) clen = Number(c[1]);
    const q = uri.match(/[?&]range=(\d+)-(\d+)(?:&|$)/i);
    if (q) return Math.max(0, Number(q[2]) - Number(q[1]) + 1);
  }
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
    if (m && (m[1] || m[2])) {
      if (m[1] && m[2]) return Math.max(0, Number(m[2]) - Number(m[1]) + 1);
      if (!m[1]) return Number(m[2]); // suffix: last N bytes
      // open-ended a-: the rest of the resource, if we know its length
      return clen !== null ? Math.max(0, clen - Number(m[1])) : null;
    }
    return clen; // multi-range/unparseable: fall back to clen or flat
  }
  return clen;
}

function costForUri(uri: string | undefined, rangeHeader?: string | undefined): number {
  let base = config.pointsPerRequest;
  if (uri) {
    if (STREAM_EXT_RE.test(uri) || STREAM_PREFIX_RE.test(uri)) {
      base = config.pointsPerStreamRequest;
    } else if (MEDIA_EXT_RE.test(uri) || MEDIA_PREFIX_RE.test(uri)) {
      base = config.pointsPerMediaRequest;
    }
  }
  if (config.pointsPerMiB <= 0) return base;
  const bytes = requestedBytes(uri, rangeHeader);
  if (bytes === null || bytes <= 0) return base;
  return base + Math.ceil((bytes / 1048576) * config.pointsPerMiB);
}

// Constant-time password check (hash both sides so length isn't leaked).
function bypassPasswordMatches(input: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(config.bypassPassword).digest();
  return timingSafeEqual(a, b);
}

async function main() {
  const store = new Store(config.dbPath);
  const state = await loadOrCreateIssuer(config.keyDir, config.issuerName);
  const pp = new PP(state, store);
  console.log(
    `[pp] issuer ready, key epoch ${state.epoch}, quota ${config.quotaDefault}, ` +
      `${config.pointsPerToken}/${config.pointsPerRequest} pts ` +
      `(${Math.floor(config.pointsPerToken / config.pointsPerRequest)} reqs/token)`,
  );
  if (
    config.tokensPerDraw * Math.floor(config.pointsPerToken / config.pointsPerRequest) <=
    config.refillBufferRequests
  ) {
    console.warn(
      `[pp] PP_TOKENS_PER_DRAW=${config.tokensPerDraw} is worth fewer requests than ` +
        `PP_REFILL_BUFFER_REQUESTS=${config.refillBufferRequests} — every draw lands inside ` +
        `the refill buffer, so the SW will bounce to /pp/activate after each one`,
    );
  }

  // Periodically sweep spent/old sessions so the table doesn't grow unbounded,
  // and old purchases so the payment<->code link doesn't outlive its purpose.
  const sweep = () => {
    const n = store.cleanupSessions(config.pointsPerRequest, config.sessionMaxAgeMs);
    if (n) console.log(`[pp] swept ${n} exhausted/old sessions`);
    if (config.btcpayEnabled && config.purchaseRetentionMs > 0) {
      const p = store.sweepPurchases(config.purchaseRetentionMs);
      if (p) console.log(`[pp] swept ${p} old purchases`);
    }
  };
  sweep();
  setInterval(sweep, 3600_000).unref();

  // Mint exactly one invite code per settled invoice. Idempotent via the
  // store's pending-only guard: webhook redeliveries and the webhook-vs-
  // reconciliation race are no-ops. Privacy: log the invoice id only — the
  // code must never appear in logs.
  const settleIfPending = (invoiceId: string): void => {
    if (!store.getPurchase(invoiceId)) {
      console.error(
        `[buy] settled invoice ${invoiceId} has no purchase row — recover via BTCPay metadata.orderId`,
      );
      return;
    }
    if (store.settlePurchase(invoiceId, generateCode())) {
      console.log(`[buy] invoice ${invoiceId} settled, code minted`);
    }
  };

  const app = express();
  app.disable('x-powered-by');

  // BTCPay webhook. MUST be mounted before the global express.json middleware:
  // the BTCPay-Sig HMAC is computed over the raw request bytes, so we need them
  // unparsed (express.raw leaves req.body a Buffer; we JSON.parse only after
  // the signature verifies).
  app.post('/pp/buy/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!config.btcpayEnabled) {
      res.status(404).json({ error: 'disabled' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || !verifyWebhookSig(req.body, req.header('btcpay-sig'))) {
      console.error('[buy] webhook signature mismatch');
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    let ev: { type?: string; invoiceId?: string };
    try {
      ev = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      res.status(400).json({ error: 'bad_json' });
      return;
    }
    if (ev.type === 'InvoiceSettled' && ev.invoiceId) {
      settleIfPending(ev.invoiceId);
    } else if ((ev.type === 'InvoiceExpired' || ev.type === 'InvoiceInvalid') && ev.invoiceId) {
      store.failPurchase(ev.invoiceId, ev.type === 'InvoiceExpired' ? 'expired' : 'invalid');
    }
    // Always 200 once the signature checks out (including unknown invoice ids
    // and ignored event types) so BTCPay stops redelivering; the unknown-
    // invoice case is logged loudly above for operator recovery.
    res.status(200).json({ ok: true });
  });

  // Large batches: a 10k-token /pp/issue body is ~3.5MB; keep generous headroom.
  app.use(express.json({ limit: '64mb' }));

  app.get('/pp/health', (_req, res) => {
    res.json({ ok: true, epoch: state.epoch });
  });

  // These reflect live state/config — never cache them. A stale /pp/config
  // (old requestsPerToken) would make the status page's request count wildly
  // wrong and disagree with the service worker.
  app.use(['/pp/config', '/pp/points', '/pp/token-key'], (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Public key set (RFC 9578 issuer directory). The activation page reads the
  // token-key from here to blind against.
  app.get('/pp/token-key', (_req, res) => {
    res.json(pp.tokenKeyDirectory());
  });

  // Client-visible metering config (for the SW's refill buffer + status page).
  // The top-up threshold is per-host: the SW fetches this on its own origin,
  // so req.hostname (the forwarded Host header) selects the override — a
  // video-heavy host can bank a much larger prefunded session than the rest.
  app.get('/pp/config', (req, res) => {
    const threshold =
      config.topUpThresholdOverrides[req.hostname?.toLowerCase() ?? ''] ??
      config.sessionTopUpThreshold;
    res.json({
      pointsPerToken: config.pointsPerToken,
      pointsPerRequest: config.pointsPerRequest,
      requestsPerToken: Math.floor(config.pointsPerToken / config.pointsPerRequest),
      refillBufferRequests: config.refillBufferRequests,
      sessionTopUpThreshold: threshold,
      // PP_DEBUG also flips the SW's console logging (token/session stats).
      debug: config.debug,
    });
  });

  // Current session's remaining balance (reads the cookie; spends nothing).
  app.get('/pp/points', (req, res) => {
    const sid = readCookie(req.header('cookie'), config.sessionCookie);
    const points = (sid ? store.getSessionPoints(sid) : null) ?? 0;
    res.json({ points, requests: Math.floor(points / config.pointsPerRequest) });
  });

  // UX helper: lets the activation page learn how many tokens to generate and
  // gives fast feedback for a bad/used code before the expensive blinding.
  app.get('/pp/issue-info', (req, res) => {
    const code = String(req.query.code ?? '');
    const row = store.getCode(code);
    if (!row) {
      res.status(404).json({ error: 'unknown_or_used' });
      return;
    }
    const available = store.availableTokens(row, config.accrualPeriodMs);
    // Balance fully drawn.
    if (row.daily <= 0 && available < 1) {
      res.status(404).json({ error: 'unknown_or_used' });
      return;
    }
    // Faucet with nothing built up yet — tell the client to come back later.
    if (row.daily > 0 && available < 1) {
      res.status(429).json({ error: 'empty', daily: row.daily });
      return;
    }
    // `quota` = how many tokens to generate NOW: a capped draw, so one device
    // doesn't drain the whole balance (the cap is a client default, not a
    // server limit — /pp/issue accepts any batch <= `remaining`).
    res.json({
      quota: Math.min(available, config.tokensPerDraw),
      remaining: available,
      daily: row.daily,
      cap: row.quota,
    });
  });

  // Redeem an invite code for a batch of blind signatures.
  // Body: { code: string, blinded_tokens: string[] }  (base64url TokenRequests)
  // Privacy: we never log the code alongside blinded values or store any link.
  app.post('/pp/issue', async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const blinded = Array.isArray(req.body?.blinded_tokens) ? req.body.blinded_tokens : null;
    if (!code || !blinded || blinded.some((b: unknown) => typeof b !== 'string')) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    // Validate without consuming, so a signing failure doesn't burn the code.
    const check = store.validateForIssue(code, blinded.length, config.accrualPeriodMs);
    if (check !== 'ok') {
      const map = { unknown: 404, used: 409, empty: 429, over_quota: 400 } as const;
      res.status(map[check]).json({ error: check });
      return;
    }

    let signatures: string[];
    try {
      signatures = await pp.issueBatch(blinded as string[]);
    } catch (err) {
      // Code is still unused — the user can simply retry with the same code.
      console.error('[pp] signing failed:', (err as Error).message);
      res.status(500).json({ error: 'issue_failed' });
      return;
    }

    // Consume the code only now. Concurrent draws that both fit the remaining
    // balance both succeed (multi-device draws are the feature); a draw that
    // would overdraw it — a double-submit of the last batch, or a faucet that
    // drained meanwhile — loses here, 409s, and its signatures are discarded,
    // so a code can never over-issue.
    if (!store.consumeForIssue(code, blinded.length, config.accrualPeriodMs)) {
      res.status(409).json({ error: 'used' });
      return;
    }
    res.json({ signatures });
  });

  // Internal auth_request target. nginx rewrites /pp/verify -> /verify and
  // forwards Authorization, Cookie, and X-PP-Gate (the geo decision).
  // The IP gate lives here: only X-PP-Gate=1 clients are metered; everyone else
  // passes straight through. 204 => allow, 401 => challenge.
  //
  // Metering: a request first tries to draw pointsPerRequest from its session
  // cookie. If there's no live session, it redeems a token and opens one worth
  // pointsPerToken (minus this request). One token therefore covers
  // pointsPerToken/pointsPerRequest requests.
  app.get('/verify', async (req, res) => {
    if (req.header('x-pp-gate') !== '1') {
      res.status(204).end();
      return;
    }
    const cookie = req.header('cookie');
    // Per-request cost by class (see the regexes above): streaming pays a low
    // flat floor (its real price is the size component), images meter cheaper
    // than documents so image-heavy browsing doesn't drain a budget, and
    // everything else pays the default. Derived from the original request URI
    // (forwarded by the gate as X-Original-URI). When PP_POINTS_PER_MIB is
    // set, requests that declare a byte size (Range header forwarded as
    // X-PP-Range, or piped's range=/clen= query params) additionally pay per
    // MiB requested.
    const cost = costForUri(req.header('x-original-uri'), req.header('x-pp-range'));
    const dbg = (outcome: string) => {
      if (!config.debug) return;
      const sid = readCookie(cookie, config.sessionCookie);
      console.log(
        `[verify] ${outcome} sw=${req.header('x-pp-sw') ? 1 : 0} ` +
          `cookie=${sid ? sid.slice(0, 8) : '-'} hasAuth=${req.header('authorization') ? 1 : 0} ` +
          `cost=${cost} uri=${req.header('x-original-uri') ?? req.header('x-pp-uri') ?? '?'}`,
      );
    };

    // 0. Operator bypass: a valid bypass cookie skips metering entirely — no
    //    token redeemed, no session points drawn. (Off unless a password is set.)
    if (config.bypassPassword && verifyBypassCookie(state.bypassSecret, readCookie(cookie, config.bypassCookie))) {
      res.set('X-PP-Bypass', '1').status(204).end();
      return;
    }
    // 1. Ride an existing session.
    const sid = readCookie(cookie, config.sessionCookie);
    if (sid) {
      const remaining = store.spendSession(sid, cost);
      if (remaining !== null) {
        dbg(`ride ${remaining}`);
        res.set('X-PP-Points', String(remaining)).status(204).end();
        return;
      }
    }

    // 2. No live session: redeem a token and open a new one.
    const result = await pp.verifyHeader(req.header('authorization'));
    if (result.status === 'ok') {
      const newId = randomBytes(16).toString('hex'); // random, not derived from token
      const remaining = config.pointsPerToken - cost;
      store.createSession(newId, remaining);
      dbg(`REDEEM->newsession ${newId.slice(0, 8)}`);
      res
        .set(
          'Set-Cookie',
          `${config.sessionCookie}=${newId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
            config.sessionMaxAgeMs / 1000,
          )}`,
        )
        .set('X-PP-Points', String(remaining))
        .status(204)
        .end();
      return;
    }

    dbg(`401 (${result.status})`);
    res.set('WWW-Authenticate', 'PrivateToken').status(401).end();
  });

  // Proactive session top-up. The service worker calls this (with a token) to
  // ADD points to its current session BEFORE it drains — so media requests that
  // bypass the SW (video/audio element range requests) always find a funded
  // session to ride at the nginx gate, even though they can't trigger the SW's
  // reactive per-request renewal. Adds to the existing session (stable cookie)
  // when one is present, otherwise opens a new one.
  app.post('/pp/refill', async (req, res) => {
    const result = await pp.verifyHeader(req.header('authorization'));
    if (result.status !== 'ok') {
      if (config.debug) console.log(`[refill] 401 (${result.status})`);
      res.status(401).json({ error: result.status });
      return;
    }
    const sid = readCookie(req.header('cookie'), config.sessionCookie);
    if (sid) {
      const points = store.topUpSession(sid, config.pointsPerToken);
      if (points !== null) {
        if (config.debug) console.log(`[refill] TOPUP ${sid.slice(0, 8)} -> ${points}`);
        res.set('X-PP-Points', String(points)).json({ points });
        return;
      }
    }
    // No live session — open one and set the cookie.
    const newId = randomBytes(16).toString('hex');
    store.createSession(newId, config.pointsPerToken);
    if (config.debug) console.log(`[refill] REDEEM->newsession ${newId.slice(0, 8)} (had cookie=${sid ? sid.slice(0, 8) : '-'})`);
    res
      .set(
        'Set-Cookie',
        `${config.sessionCookie}=${newId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
          config.sessionMaxAgeMs / 1000,
        )}`,
      )
      .set('X-PP-Points', String(config.pointsPerToken))
      .json({ points: config.pointsPerToken });
  });

  // Operator bypass: exchange the shared password for a signed bypass cookie
  // that makes every gated request pass without spending a token. Disabled
  // (404) when no password is configured. Body: { password: string }.
  app.post('/pp/bypass', (req, res) => {
    if (!config.bypassPassword) {
      res.status(404).json({ error: 'disabled' });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !bypassPasswordMatches(password)) {
      res.status(401).json({ error: 'bad_password' });
      return;
    }
    const value = mintBypassCookie(state.bypassSecret, config.bypassMaxAgeMs);
    res
      .set(
        'Set-Cookie',
        `${config.bypassCookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
          config.bypassMaxAgeMs / 1000,
        )}`,
      )
      .json({ ok: true, expiresInDays: Math.round(config.bypassMaxAgeMs / 86_400_000) });
  });

  // ---- BTCPay purchases ----------------------------------------------------
  // Buy an invite code with crypto. All routes 404 when the feature is off
  // (PP_BTCPAY_* unset), same idiom as /pp/bypass above.

  const buyDisabled = (res: express.Response): boolean => {
    if (config.btcpayEnabled) return false;
    res.status(404).json({ error: 'disabled' });
    return true;
  };

  // Package list for the buy page. Live config — never cache.
  app.get('/pp/buy/packages', (_req, res) => {
    if (buyDisabled(res)) return;
    res.set('Cache-Control', 'no-store').json({ packages: config.btcpayPackages });
  });

  // Trivial global rate limit on invoice creation: the endpoint is
  // unauthenticated and each call creates a real BTCPay invoice. Enough to
  // stop drive-by invoice spam without a dependency; nginx-level limits can
  // be layered on top.
  let checkoutsThisMinute = 0;
  setInterval(() => (checkoutsThisMinute = 0), 60_000).unref();

  // Create an invoice for a package and hand back the BTCPay checkout link +
  // the claim URL. The purchase row is inserted only AFTER BTCPay succeeds, so
  // a BTCPay failure leaves no orphan row (the reverse orphan — invoice
  // without row on a crash between the two — is caught by the webhook's
  // unknown-invoice log and recovered via metadata.orderId).
  app.post('/pp/buy/checkout', async (req, res) => {
    if (buyDisabled(res)) return;
    if (++checkoutsThisMinute > 30) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const pkg = config.btcpayPackages.find((p) => p.id === req.body?.packageId);
    if (!pkg) {
      res.status(400).json({ error: 'unknown_package' });
      return;
    }
    const claimToken = generateClaimToken();
    let invoice;
    try {
      invoice = await createInvoice(pkg, claimToken);
    } catch (err) {
      console.error('[buy] invoice create failed:', (err as Error).message);
      res.status(502).json({ error: 'btcpay_unreachable' });
      return;
    }
    store.createPurchase(invoice.id, claimToken, pkg.id, pkg.tokens);
    res.json({
      checkoutLink: invoice.checkoutLink,
      claimUrl: `${config.gatedOrigin}/pp/claim?ct=${claimToken}`,
    });
  });

  // Claim status: the claim page polls this until the purchase settles. While
  // still pending, reconcile directly against BTCPay — the fallback for a
  // missed webhook (BTCPay unreachable => stay pending; the poller retries).
  app.get('/pp/claim/status', async (req, res) => {
    if (buyDisabled(res)) return;
    res.set('Cache-Control', 'no-store');
    const ct = String(req.query.ct ?? '');
    let row = ct ? store.getPurchaseByClaim(ct) : undefined;
    if (!row) {
      res.status(404).json({ error: 'unknown' });
      return;
    }
    if (row.status === 'pending') {
      try {
        const invoice = await getInvoice(row.invoice_id);
        if (invoice.status === 'Settled') settleIfPending(row.invoice_id);
        else if (invoice.status === 'Expired') store.failPurchase(row.invoice_id, 'expired');
        else if (invoice.status === 'Invalid') store.failPurchase(row.invoice_id, 'invalid');
        row = store.getPurchaseByClaim(ct)!;
      } catch {
        /* BTCPay unreachable — report pending, poller retries */
      }
    }
    if (row.status !== 'settled') {
      res.json({ status: row.status });
      return;
    }
    store.markPurchaseClaimed(ct); // retention clock starts at first reveal
    res.json({
      status: 'settled',
      code: row.code,
      tokens: row.tokens,
      activateUrl: `${config.gatedOrigin}/pp/activate?code=${row.code}`,
    });
  });

  app.get('/pp/buy', (_req, res) => {
    if (buyDisabled(res)) return;
    res.sendFile(join(PUBLIC_DIR, 'buy.html'));
  });

  app.get('/pp/claim', (_req, res) => {
    if (buyDisabled(res)) return;
    res.sendFile(join(PUBLIC_DIR, 'claim.html'));
  });

  // Activation / landing page. Same handler for cold visits and ?exhausted=1.
  app.get('/pp/activate', (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'activate.html'));
  });

  // Service worker must control the whole origin, so it is registered with
  // scope '/' — which requires this header even though it is served from /pp/.
  app.get('/pp/sw.js', (_req, res) => {
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript');
    res.sendFile(join(PUBLIC_DIR, 'sw.js'));
  });

  // Purchases disabled: hide the raw pages the static handler would otherwise
  // still expose at /pp/buy.html and /pp/claim.html.
  app.use('/pp', (req, res, next) => {
    if (!config.btcpayEnabled && (req.path === '/buy.html' || req.path === '/claim.html')) {
      res.status(404).end();
      return;
    }
    next();
  });

  // activate.js and any other bundled assets.
  app.use('/pp', express.static(PUBLIC_DIR));

  app.listen(config.port, () => {
    console.log(`[pp] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error('[pp] fatal:', err);
  process.exit(1);
});
