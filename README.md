# privacy-pass — anonymous-token bot protection

An initial, single-IP deployment of the Privacy Pass (IETF RFC 9578, **Type 2 /
Blind RSA 2048**) bot-protection layer described in `../privacy-pass-handoff.md`.

The operator issues invite codes; each code grants a batch of anonymous tokens.
After a one-time activation in the browser, a service worker attaches a token to
each page request. The server can verify a request carries a valid token but
**cannot link any redemption to the invite code or issuance event** — blind
issuance guarantees this cryptographically.

## What this initial version does and does NOT do

- ✅ Issuer + verifier in one Node/TS service, own Docker container.
- ✅ Blind RSA issuance, publicly-verifiable redemption, atomic double-spend guard.
- ✅ Invite codes with a per-code quota, single-use, admin CLI.
- ✅ Activation page + service worker + IndexedDB token pool.
- ✅ nginx `auth_request` integration, **gated to one client IP** (`24.150.9.204`),
     **never** gated for the LAN (`192.168.88.0/24`) or anyone else.
- ❌ **No session window.** Every gated page view / dynamic GET spends one token.
     (The handoff's session-window optimisation is deliberately omitted for now.)
- ❌ **No key rotation overlap.** One key epoch; regenerating keys invalidates all
     outstanding tokens.
- ❌ GET requests only are gated (Quetre is read-only). Non-GET from the gated IP
     without a token gets a 401.

## Architecture

```
Browser ──(SW adds Authorization: PrivateToken)──► nginx (quetre server block)
                                                     │  $pp_gate==1 only
                                                     ▼  auth_request /pp/verify
                                              privacy-pass container
                                              172.33.0.1:8017  (host 8017 → 8787)
                                              ├─ /verify  sig check + atomic spent-set
                                              ├─ /pp/issue    blind-sign a batch
                                              ├─ /pp/token-key issuer public key
                                              └─ /pp/activate  page + sw.js + activate.js
```

- The gate lives in the **local** nginx `http{}` block, i.e. **after TLS
  termination** — not in the `stream{}` layer.
- nginx reaches this service via the Docker **bridge gateway** `172.33.0.1:8017`
  (same convention as every other pepperbox service), *not* `127.0.0.1`.
- Signature verification checks the Blind RSA signature only (no challenge/origin
  binding); replay is prevented by hashing the token into a SQLite spent-set.

## Files

```
src/config.ts   env config          src/pp.ts      issue/verify facade
src/store.ts    SQLite (codes+spent) src/server.ts  HTTP routes
src/keys.ts     keypair gen/persist  src/admin.ts   invite-code CLI
client/activate.ts  bundled → public/activate.js (blind/unblind in-browser)
public/activate.html  activation UI  public/sw.js   token-attaching service worker
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

Because there is no session window, a code's quota is consumed roughly one token
per page view. Size quotas accordingly; keep them modest until a session window
exists (blind-signing thousands of tokens in the browser is also slow).

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

## Checking balance & running out

- **Balance:** visit `https://<gated-host>/pp/status.html` — a first-party page
  that reads the same IndexedDB pool the service worker spends from, so it works
  for whatever service is gated on that host with **no change to the proxied
  app**. The service worker also stamps an `X-PP-Remaining` header on every gated
  response (visible in devtools).
- **Exhaustion is graceful:** when the pool empties, a top-level navigation
  redirects to `/pp/activate?exhausted=1`. If it runs out on a sub-resource
  mid-page (e.g. a proxied image), the service worker uses `WindowClient.navigate`
  to send the owning tab to the activation page rather than leaving a broken page.
  (Note: with per-request gating, each proxied image spends a token, so
  image-heavy pages burn several tokens per view.)

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
