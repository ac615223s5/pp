# privacy-pass — anonymous-token bot protection

An initial, single-IP deployment of the Privacy Pass (IETF RFC 9578, **Type 2 /
Blind RSA 2048**) bot-protection layer described in `../privacy-pass-handoff.md`.

The operator issues invite codes; each code grants a batch of anonymous tokens.
After a one-time activation in the browser, a service worker spends tokens
lazily: it rides a **points-metered session cookie**, and only redeems a token
when the session runs out. The server can verify a request carries a valid token
but **cannot link any redemption to the invite code or issuance event** — blind
issuance guarantees this cryptographically.

## What this initial version does and does NOT do

- ✅ Issuer + verifier in one Node/TS service, own Docker container.
- ✅ Blind RSA issuance, publicly-verifiable redemption, atomic double-spend guard.
- ✅ Invite codes with a per-code quota, single-use, admin CLI.
- ✅ Activation page + service worker + IndexedDB token pool.
- ✅ nginx `auth_request` integration, **gated to one client IP** (`24.150.9.204`),
     **never** gated for the LAN (`192.168.88.0/24`) or anyone else.
- ✅ **Points-metered sessions.** One token opens a session worth
     `pointsPerToken` (default 1e6); each request draws `pointsPerRequest`
     (default 1000) → **~1000 requests per token**. Cost stays linear in requests
     (unlike a time window, a bot can't amortise). See *Points-metered sessions*.
- ✅ **Web Worker-parallelised activation** + native raw-RSA signing, so big
     quotas (~10k) are practical.
- ✅ **Operator bypass password**, **token export/import**, **balance page**,
     and an early-**refill buffer** (all below).
- ❌ **No key rotation overlap.** One key epoch; regenerating keys invalidates all
     outstanding tokens *and* bypass cookies.
- ❌ GET requests only are gated (Quetre is read-only). Non-GET from the gated IP
     without a live session gets a 401.

## Architecture

```
Browser SW ── ride session cookie (X-PP-SW) ──► nginx (quetre server block)
     │         on 401, redeem 1 token instead     │  $pp_gate==1 only
     ▼                                             ▼  auth_request /pp/verify
  IndexedDB token pool                       privacy-pass container
                                             172.33.0.1:8017  (host 8017 → 8787)
                                             ├─ /verify   meter session pts, else
                                             │            redeem token → Set-Cookie
                                             ├─ /pp/issue     blind-sign a batch
                                             ├─ /pp/token-key  issuer public key
                                             ├─ /pp/config     metering params
                                             ├─ /pp/points     session balance
                                             ├─ /pp/bypass     password → bypass cookie
                                             └─ /pp/activate   page + sw.js + activate.js
                                                              + status.html + pp-worker.js
```

- The gate lives in the **local** nginx `http{}` block, i.e. **after TLS
  termination** — not in the `stream{}` layer.
- nginx reaches this service via the Docker **bridge gateway** `172.33.0.1:8017`
  (same convention as every other pepperbox service), *not* `127.0.0.1`.
- Signature verification checks the Blind RSA signature only (no challenge/origin
  binding); replay is prevented by hashing the token into a SQLite spent-set.
- nginx forwards the `Cookie` to `/verify` and propagates the `Set-Cookie` it
  mints back to the browser via `auth_request_set`.

## Files

```
src/config.ts   env config           src/pp.ts      issue/verify facade
src/store.ts    SQLite: codes +       src/server.ts  HTTP routes (/verify, /pp/*)
                spent-set + sessions   src/admin.ts   code + bypass-link CLI
src/keys.ts     keypair + bypass HMAC  src/bypass.ts  stateless bypass cookie (HMAC)
client/activate.ts  bundled → public/activate.js (activation + bypass password)
client/pp-worker.ts bundled → public/pp-worker.js (parallel blind/unblind)
public/activate.html  activation UI   public/sw.js   lazy-spend service worker
public/status.html    balance + token export/import
data/           mounted volume: pp.db (SQLite) + keys/ (RSA keypair)  ← secrets
```

## Deploy

```sh
cd privacy-pass
cp .env.example .env          # adjust if needed
docker compose up -d --build  # builds TS + client bundle, generates keys on first run
```

Then reload nginx so the new Quetre routes + `$pp_gate` map take effect
(already merged into `../nginx/nginx.conf`):

```sh
docker exec nginx nginx -t && docker exec nginx nginx -s reload
# or: docker compose -f ../nginx/docker-compose.yaml up -d
```

## Issuing codes

```sh
docker compose exec privacy-pass node dist/admin.js new-code --quota 500
#   created  MW4TM-Z3GBR-NYTSX  (quota 500)
#   link: https://quetre.example.com/pp/activate?code=MW4TM-Z3GBR-NYTSX
docker compose exec privacy-pass node dist/admin.js list-codes
docker compose exec privacy-pass node dist/admin.js revoke-code MW4TM-Z3GBR-NYTSX   # unused codes only
```

**What to tell a user:** send them the `link:` line — it opens the activation
page with the code prefilled; they just click **Activate** (the code is never
auto-submitted, so link previews/prefetchers can't burn it). Or: "Visit
`/pp/activate`, paste this code once." It works on that one browser/device only —
clearing site data or switching device/browser needs a new code. Codes **stack**,
so a user can add more later. Users without a code can request one via the Matrix
link on the activation page.

With points-metered sessions, one token covers `pointsPerToken/pointsPerRequest`
requests (default 1000), so a 500-token code ≈ 500k requests. Activation
blind-signs `quota` tokens in the browser (parallelised across Web Workers), so
very large quotas still take time — size to expected usage.

## Bypass password (operator escape hatch)

For your own devices you usually don't want to burn tokens at all. Set
`PP_BYPASS_PASSWORD` in `.env` (empty = feature off) and restart. Entering that
password on the activation page — or opening the prefilled link — mints a
signed, HttpOnly `pp_bypass` cookie; while it's present the verifier returns
`204` for every gated request **without spending a token or session points**.

```sh
docker compose exec privacy-pass node dist/admin.js bypass-link
#   link: https://quetre.example.com/pp/activate?pw=<password>
```

Send yourself that link (or visit `/pp/activate`, expand **"Have a bypass
password?"**, type it, click **Unlock**). It works on that one browser/device,
needs no invite code and no service worker — the cookie alone rides every
request. It lasts `PP_BYPASS_MAX_AGE_MS` (default 365 days) or until you clear
site data.

- **Not anonymous:** the bypass cookie is a stable per-device value, so it
  deliberately breaks Privacy Pass's unlinkability. Use it only for yourself.
- **Not forgeable:** the cookie is HMAC-signed with a secret derived from the
  issuer private key. A **key rotation invalidates all bypass cookies** too
  (same epoch semantics as tokens) — re-unlock afterwards.
- Keep the password secret; it's reusable and grants unlimited access. Because
  the link puts it in a URL, prefer pasting it on the page over sharing the URL
  through anything that logs referrers/history.

## Points-metered sessions

Redeeming one token opens a **session**: a random id stored server-side (SQLite
`sessions` table) with a starting balance of `PP_POINTS_PER_TOKEN` points, handed
to the browser as an HttpOnly `pp_session` cookie. Each gated request draws
`PP_POINTS_PER_REQUEST` points (atomic `UPDATE … RETURNING`). When the balance
can't cover a request the verifier answers `401`, and the service worker spends
another token to open a fresh session.

- **Lazy spend.** The SW rides the cookie first (marked `X-PP-SW: 1` so nginx
  answers a drained/missing session with `401` rather than an activate redirect),
  and only redeems a token on `401`. One token ≈ 1000 requests.
- **Single-flight renewal.** A page load fires many requests at once, so a
  mid-load drain would 401 several of them. The SW coalesces these into **one**
  token spend (`sessionRenewal`), so a session boundary costs exactly one token,
  and the page keeps loading — no broken sub-resources.
- **Spent-token resilience.** On renewal the SW pops tokens until one opens a
  session, discarding any already-spent ones (e.g. from an imported, partly-used
  pool), bounded so a fully-spent pool can't spin.
- **Privacy trade-off.** The ~1000 requests within one session are mutually
  linkable via the cookie, but sessions are unlinkable to each other and to
  issuance (random id, blind tokens). Set `PP_POINTS_PER_TOKEN ==
  PP_POINTS_PER_REQUEST` to fall back to one-token-per-request (max anonymity).

## Checking balance & running out

- **Balance:** visit `https://<gated-host>/pp/status.html` — a first-party page
  showing **total requests remaining** = pooled tokens × requests-per-token +
  the current session's points. It reads the IndexedDB pool directly and the
  session balance via `/pp/points` (the cookie is HttpOnly, so only the server
  can read it). Works for whatever service is gated on that host with **no change
  to the proxied app**.
- **Move tokens between devices:** the status page can **export** your unspent
  tokens to the clipboard (`{pp:1, origin, tokens}` JSON) and **import** them on
  another browser/device (deduped, so re-importing your own pool is a no-op).
  Exported tokens are **bearer credentials** — whoever holds the text can spend
  them; the current session's points are not exported.
- **Refill buffer:** once the pool is within `PP_REFILL_BUFFER_REQUESTS` (default
  5000, = 5 tokens) of empty, the SW steers new **navigations** to
  `/pp/activate?refill=1` while still serving **sub-resources** from the buffer —
  so in-flight page loads finish and the user is asked to top up early. Codes
  stack, so activating another raises the balance and browsing resumes.
- **Exhaustion is graceful:** truly out of tokens, a navigation redirects to
  `/pp/activate?exhausted=1`; a sub-resource uses `WindowClient.navigate` to send
  the owning tab there rather than leaving a broken page.

## Large activations (big quotas)

`/pp/issue` bodies scale with quota (~350 bytes/token, so ~3.5MB at 10k). nginx's
`^~ /pp/` location raises `client_max_body_size` to 64m and the proxy timeouts to
300s, and the service's JSON limit is 64mb, so ~10k+ batches don't 413 or time
out. Signing is native raw-RSA (~0.6ms/token → 10k in ~6s); the client-side blind
generation (parallelised across Web Workers) is the slow part of a big activation.

## How the gate decides who is protected

`nginx.conf` `http{}` holds:

```nginx
geo $pp_gate {
    default          0;
    24.150.9.204/32  1;   # gated
    192.168.88.0/24  0;   # LAN: never gated
}
```

`auth_request` cannot be made conditional in nginx (no variables, no `if`), and
putting it behind a nested `error_page` breaks the `401 -> @challenge` redirect.
So in the Quetre server block `location /` runs `auth_request /pp/verify` on
**every** dynamic request and passes the geo decision to the verifier as the
`X-PP-Gate` header. **The IP gate therefore lives in the service**: `/verify`
returns `204` immediately when `X-PP-Gate != 1`, and only enforces a token for
gated clients. `$remote_addr` is the true client IP, recovered from PROXY
protocol by the existing `set_real_ip_from 10.10.10.0/24`.

Because the verifier is now in the path for all Quetre HTML requests, `location /`
also has `error_page 502 503 504 = @pp_fail_open` so a privacy-pass outage fails
**open** (Quetre stays up, gate stops enforcing) rather than 500-ing everyone.

To gate more clients, add IPs/CIDRs to the `geo` block with value `1`. To protect
another service, replicate the `/pp/*`, static, `location /`, `@challenge`, and
`@pp_fail_open` blocks in that service's server block (the `geo` map is global).

> **nginx edit gotcha:** the `nginx` container bind-mounts `nginx.conf` as a
> single file. Editing it creates a new inode, so `nginx -s reload` keeps reading
> the *old* file. After any edit, recreate the container:
> `docker compose -f ../nginx/docker-compose.yaml up -d --force-recreate nginx`.

> **LAN caveat:** a LAN device that reaches the site through the public tunnel
> egresses as the LAN's *public* IP. If that public IP is `24.150.9.204`, it is
> gated like any other request from that address — the LAN carve-out only applies
> to direct-to-host access showing a `192.168.88.0/24` source.

## Privacy properties & their limits

- The issuer never persists or logs blinded values, tokens, IPs, or user agents
  alongside invite codes. Redemptions are unlinkable to issuance by construction.
- The spent-set stores only a SHA-256 of each redeemed token — no token values,
  no client identifiers.
- Residual metadata risk: with a tiny user set, IP/timing correlation is possible;
  the anonymity set grows with users. Tokens can be shared/exported by design and
  cannot be revoked once issued (only unused *codes* can be revoked).
- **Session linkability:** requests within one session share a cookie and are
  mutually linkable (~`pointsPerToken/pointsPerRequest` of them); session ids are
  random and never derived from the token, so sessions stay unlinkable to each
  other and to issuance.
- **Bypass is not anonymous:** the operator bypass cookie is a stable per-device
  credential — it deliberately trades away unlinkability for the operator's own
  convenience. Keep the password secret.

## Key rotation (manual, for now)

There is a single key epoch. To rotate, stop the container, delete `data/keys/`,
restart (a new keypair is generated). **This invalidates every outstanding token**
— users must re-activate with new codes. The spent-set (`data/pp.db`) can also be
truncated after rotation since old-epoch tokens no longer verify.

## Backups

`../.backupignore` keeps this service's source + compose + `.env` but **excludes
`data/`** (keys + db). A restore therefore regenerates keys → new epoch → all
outstanding codes/tokens invalid. Back up `data/` explicitly if you need issued
codes/tokens to survive a restore.
