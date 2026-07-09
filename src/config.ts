// Centralised runtime configuration, read once from the environment.

// A purchasable token package (BTCPay checkout). `amount` stays a string —
// the Greenfield API takes decimal strings, and we never do math on it.
export interface Package {
  id: string;
  label: string;
  tokens: number;
  amount: string;
  currency: string;
}

// Parse PP_BTCPAY_PACKAGES. Throws on malformed config so a bad deploy fails
// loudly at startup instead of silently selling nothing.
function parsePackages(json: string): Package[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('PP_BTCPAY_PACKAGES is not valid JSON');
  }
  if (!Array.isArray(raw)) throw new Error('PP_BTCPAY_PACKAGES must be a JSON array');
  const seen = new Set<string>();
  return raw.map((p, i) => {
    const pkg = p as Partial<Package>;
    if (typeof pkg.id !== 'string' || !pkg.id || seen.has(pkg.id))
      throw new Error(`PP_BTCPAY_PACKAGES[${i}]: missing or duplicate id`);
    seen.add(pkg.id);
    if (typeof pkg.label !== 'string' || !pkg.label)
      throw new Error(`PP_BTCPAY_PACKAGES[${i}]: missing label`);
    if (!Number.isInteger(pkg.tokens) || (pkg.tokens as number) < 1)
      throw new Error(`PP_BTCPAY_PACKAGES[${i}]: tokens must be a positive integer`);
    if (typeof pkg.amount !== 'string' || !/^\d+(\.\d+)?$/.test(pkg.amount))
      throw new Error(`PP_BTCPAY_PACKAGES[${i}]: amount must be a decimal string`);
    if (typeof pkg.currency !== 'string' || !/^[A-Z]{3,5}$/.test(pkg.currency))
      throw new Error(`PP_BTCPAY_PACKAGES[${i}]: currency must be 3-5 uppercase letters`);
    return { id: pkg.id, label: pkg.label, tokens: pkg.tokens as number, amount: pkg.amount, currency: pkg.currency };
  });
}

// Parse PP_TOPUP_THRESHOLD_OVERRIDES: a JSON object mapping hostname ->
// per-host session top-up threshold (points). Lets a video-heavy host (e.g.
// piped) bank a much larger prefunded session than the small default that
// keeps other hosts' sessions private. Throws on malformed config so a bad
// deploy fails loudly at startup.
function parseThresholdOverrides(json: string): Record<string, number> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('PP_TOPUP_THRESHOLD_OVERRIDES is not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('PP_TOPUP_THRESHOLD_OVERRIDES must be a JSON object of host -> points');
  const out: Record<string, number> = {};
  for (const [host, value] of Object.entries(raw)) {
    if (!host || typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`PP_TOPUP_THRESHOLD_OVERRIDES["${host}"]: value must be a non-negative number`);
    out[host.toLowerCase()] = value;
  }
  return out;
}

const btcpayUrl = (process.env.PP_BTCPAY_URL ?? '').replace(/\/+$/, '');
const btcpayApiKey = process.env.PP_BTCPAY_API_KEY ?? '';
const btcpayStoreId = process.env.PP_BTCPAY_STORE_ID ?? '';
const btcpayWebhookSecret = process.env.PP_BTCPAY_WEBHOOK_SECRET ?? '';
const btcpayPackages = parsePackages(process.env.PP_BTCPAY_PACKAGES ?? '[]');

export const config = {
  port: Number(process.env.PP_PORT ?? 8787),
  issuerName: process.env.PP_ISSUER_NAME ?? 'subdomain.example.com',
  gatedOrigin: process.env.PP_GATED_ORIGIN ?? 'https://subdomain.example.com',
  quotaDefault: Number(process.env.PP_QUOTA_DEFAULT ?? 500),
  // Default draw size: /pp/issue-info tells clients to generate
  // min(available, tokensPerDraw) tokens per activation, so a code is drawn
  // down in batches instead of all at once. A CLIENT default, not a server
  // cap — /pp/issue accepts any batch up to the code's remaining balance,
  // because larger draws are anonymity-positive: drawing tens of tokens ahead
  // of need keeps issuance events temporally decorrelated from redemptions,
  // while one-token draws would let the operator link redemptions back to
  // codes by timing.
  tokensPerDraw: Math.max(1, Math.floor(Number(process.env.PP_TOKENS_PER_DRAW ?? 50))),
  // Accrual period for "faucet" codes (--daily): how long it takes to earn one
  // day's worth of tokens. Default 24h; lower it (e.g. 60000) to test accrual
  // without waiting a real day.
  accrualPeriodMs: Number(process.env.PP_ACCRUAL_PERIOD_MS ?? 24 * 3600 * 1000),
  dbPath: process.env.PP_DB_PATH ?? '/data/pp.db',
  keyDir: process.env.PP_KEY_DIR ?? '/data/keys',
  // Verbose per-request logging at the gate (token redeem / session ride /
  // top-up). Off by default; flip PP_DEBUG=1 to diagnose token spend.
  debug: process.env.PP_DEBUG === '1',

  // Points-metered sessions: redeeming one token opens a session worth
  // pointsPerToken; each gated request draws pointsPerRequest. Default
  // 1_000_000 / 1_000 = 1000 requests per token. Set pointsPerToken ==
  // pointsPerRequest to fall back to one-token-per-request (no session reuse).
  pointsPerToken: Number(process.env.PP_POINTS_PER_TOKEN ?? 1_000_000),
  pointsPerRequest: Number(process.env.PP_POINTS_PER_REQUEST ?? 1_000),
  // Cheaper per-request cost for media (images + audio/video). The gate forwards
  // the original request URI as X-Original-URI and /verify charges this instead
  // of pointsPerRequest when the URI looks like media — so image-heavy browsing
  // doesn't drain a budget, while a direct media scrape still costs points.
  // Default 100 (10x cheaper than the 1_000 default). Replaces the old nginx
  // $pp_media_cost map / X-PP-Cost header plumbing.
  pointsPerMediaRequest: Number(process.env.PP_POINTS_PER_MEDIA_REQUEST ?? 100),
  // Cheapest class: audio/video/streaming (HLS/DASH segments + manifests,
  // progressive mp4/webm, piped's /videoplayback). A low flat base — the real
  // pricing signal for streaming is the size-based PP_POINTS_PER_MIB component
  // these requests carry (Range headers / range= params), so the base is just
  // a per-request floor. Images deliberately stay in the pricier media class.
  pointsPerStreamRequest: Number(process.env.PP_POINTS_PER_STREAM_REQUEST ?? 25),
  // Size-based cost component, in points per MiB REQUESTED. When > 0, a
  // request that declares how many bytes it is asking for — a Range header
  // (forwarded by the gate as X-PP-Range), or googlevideo-style range=/clen=
  // query params (piped /videoplayback) — pays its class cost PLUS
  // ceil(MiB * pointsPerMiB). Additive on purpose: a spoofed tiny Range can
  // never make a request cheaper than its flat class cost, and requests with
  // no size hint simply stay flat. 0 disables (default).
  pointsPerMiB: Number(process.env.PP_POINTS_PER_MIB ?? 0),
  sessionCookie: process.env.PP_SESSION_COOKIE ?? 'pp_session',

  // Operator bypass. When PP_BYPASS_PASSWORD is set (non-empty), entering it on
  // the activation page (or via ?pw= in the link) mints a signed bypass cookie
  // that makes every gated request pass WITHOUT spending a token or session
  // points. Empty => feature disabled (the /pp/bypass route 404s). This is a
  // linkable, non-anonymous escape hatch for the operator's own use — it
  // deliberately breaks the unlinkability property, so keep the password secret.
  bypassPassword: process.env.PP_BYPASS_PASSWORD ?? '',
  bypassCookie: process.env.PP_BYPASS_COOKIE ?? 'pp_bypass',
  bypassMaxAgeMs: Number(process.env.PP_BYPASS_MAX_AGE_MS ?? 365 * 24 * 3600 * 1000),
  // Reserve this many requests of capacity: once a device is within the buffer,
  // new navigations are steered to re-activate, but the buffer stays spendable so
  // in-flight page loads (which fire many sub-requests at once) still complete.
  refillBufferRequests: Number(process.env.PP_REFILL_BUFFER_REQUESTS ?? 5_000),
  // Proactive session top-up threshold (in POINTS). When a live session's
  // balance drops below this, the SW spends a token to add pointsPerToken to it
  // — keeping it funded for SW-invisible media (video/audio) that rides the
  // session at the nginx gate but can't trigger the SW's reactive renewal.
  // Default 200_000 = 200 requests of headroom at the 1_000/request rate.
  sessionTopUpThreshold: Number(process.env.PP_SESSION_TOPUP_THRESHOLD ?? 200_000),
  // Per-host overrides for the top-up threshold, keyed by lowercase hostname.
  // The SW reads the threshold from /pp/config on its own origin, so raising it
  // for one host makes that host's SW bank a bigger session (many tokens'
  // worth) while the SW is awake — runway for SW-invisible playback — without
  // growing other hosts' sessions. Token VALUE stays global on purpose: a
  // bigger threshold pre-pays more tokens into the session, it does not make
  // tokens go further, so per-euro economics are identical on every host.
  // REQUIRES nginx to forward the original Host header on ^~ /pp/
  // (proxy_set_header Host $host) — otherwise the lookup sees the upstream
  // address and every host gets the default.
  topUpThresholdOverrides: parseThresholdOverrides(
    process.env.PP_TOPUP_THRESHOLD_OVERRIDES ?? '{}',
  ),
  // sessions with fewer than one request's worth of points, or older than this,
  // are swept periodically.
  sessionMaxAgeMs: Number(process.env.PP_SESSION_MAX_AGE_MS ?? 30 * 24 * 3600 * 1000),

  // BTCPay purchases: sell invite codes for crypto via an operator-run BTCPay
  // Server (Greenfield API). All four credentials AND at least one package must
  // be set to enable the feature; otherwise every /pp/buy* and /pp/claim* route
  // 404s and the pages are hidden — same "empty = disabled" idiom as the
  // bypass password above.
  btcpayUrl,
  btcpayApiKey,
  btcpayStoreId,
  btcpayWebhookSecret,
  btcpayPackages,
  btcpayEnabled: !!(btcpayUrl && btcpayApiKey && btcpayStoreId && btcpayWebhookSecret && btcpayPackages.length),
  // Purchase rows link a BTCPay invoice to the minted code (needed for
  // delivery). They are deleted this long after the code is first revealed
  // (or after a terminal failure), severing that link. 0 = never sweep.
  purchaseRetentionMs: Number(process.env.PP_PURCHASE_RETENTION_MS ?? 30 * 24 * 3600 * 1000),
} as const;
