// Centralised runtime configuration, read once from the environment.

export const config = {
  port: Number(process.env.PP_PORT ?? 8787),
  issuerName: process.env.PP_ISSUER_NAME ?? 'quetre.example.com',
  gatedOrigin: process.env.PP_GATED_ORIGIN ?? 'https://quetre.example.com',
  quotaDefault: Number(process.env.PP_QUOTA_DEFAULT ?? 500),
  dbPath: process.env.PP_DB_PATH ?? '/data/pp.db',
  keyDir: process.env.PP_KEY_DIR ?? '/data/keys',

  // Points-metered sessions: redeeming one token opens a session worth
  // pointsPerToken; each gated request draws pointsPerRequest. Default
  // 1_000_000 / 1_000 = 1000 requests per token. Set pointsPerToken ==
  // pointsPerRequest to fall back to one-token-per-request (no session reuse).
  pointsPerToken: Number(process.env.PP_POINTS_PER_TOKEN ?? 1_000_000),
  pointsPerRequest: Number(process.env.PP_POINTS_PER_REQUEST ?? 1_000),
  sessionCookie: process.env.PP_SESSION_COOKIE ?? 'pp_session',
  // sessions with fewer than one request's worth of points, or older than this,
  // are swept periodically.
  sessionMaxAgeMs: Number(process.env.PP_SESSION_MAX_AGE_MS ?? 30 * 24 * 3600 * 1000),
} as const;
