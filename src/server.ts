// HTTP surface, all under /pp/ except the internal /verify target that nginx's
// auth_request rewrites to. See deploy notes in README / nginx.conf.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { loadOrCreateIssuer } from './keys.js';
import { PP } from './pp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Extract the session id from a Cookie header, or null.
function parseSessionId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${config.sessionCookie}=([^;\\s]+)`));
  return m ? m[1] : null;
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

  // Periodically sweep spent/old sessions so the table doesn't grow unbounded.
  const sweep = () => {
    const n = store.cleanupSessions(config.pointsPerRequest, config.sessionMaxAgeMs);
    if (n) console.log(`[pp] swept ${n} exhausted/old sessions`);
  };
  sweep();
  setInterval(sweep, 3600_000).unref();

  const app = express();
  app.disable('x-powered-by');
  // Large batches: a 10k-token /pp/issue body is ~3.5MB; keep generous headroom.
  app.use(express.json({ limit: '64mb' }));

  app.get('/pp/health', (_req, res) => {
    res.json({ ok: true, epoch: state.epoch });
  });

  // Public key set (RFC 9578 issuer directory). The activation page reads the
  // token-key from here to blind against.
  app.get('/pp/token-key', (_req, res) => {
    res.json(pp.tokenKeyDirectory());
  });

  // UX helper: lets the activation page learn how many tokens to generate and
  // gives fast feedback for a bad/used code before the expensive blinding.
  app.get('/pp/issue-info', (req, res) => {
    const code = String(req.query.code ?? '');
    const row = store.getCode(code);
    if (!row || row.used) {
      res.status(404).json({ error: 'unknown_or_used' });
      return;
    }
    res.json({ quota: row.quota });
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
    const check = store.validateForIssue(code, blinded.length);
    if (check !== 'ok') {
      const map = { unknown: 404, used: 409, over_quota: 400 } as const;
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

    // Consume the code only now. If a concurrent request already consumed it
    // (double-submit race), this loser 409s and its signatures are discarded —
    // exactly one activation ever gets tokens.
    if (!store.markUsed(code)) {
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
    const cost = config.pointsPerRequest;

    // 1. Ride an existing session.
    const sid = parseSessionId(req.header('cookie'));
    if (sid) {
      const remaining = store.spendSession(sid, cost);
      if (remaining !== null) {
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

    res.set('WWW-Authenticate', 'PrivateToken').status(401).end();
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
