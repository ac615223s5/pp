// Centralised runtime configuration, read once from the environment.

export const config = {
  port: Number(process.env.PP_PORT ?? 8787),
  issuerName: process.env.PP_ISSUER_NAME ?? 'quetre.example.com',
  gatedOrigin: process.env.PP_GATED_ORIGIN ?? 'https://quetre.example.com',
  quotaDefault: Number(process.env.PP_QUOTA_DEFAULT ?? 500),
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
  // sessions with fewer than one request's worth of points, or older than this,
  // are swept periodically.
  sessionMaxAgeMs: Number(process.env.PP_SESSION_MAX_AGE_MS ?? 30 * 24 * 3600 * 1000),
} as const;
