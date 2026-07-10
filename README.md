# privacy-pass — anonymous-token bot protection

An anonymous-token (Privacy Pass, IETF RFC 9578, **Type 2 / Blind RSA 2048**)
bot-protection layer. Built from `./privacy-pass-handoff.md`; in this deployment
it gates **quetre, redlib, nitter, and rimgo** — every non-whitelisted client is
metered.

> **Deploying it in front of your own service?** See [`INSTALL.md`](./INSTALL.md)
> for a generic, step-by-step guide. This README documents how *this* deployment
> works and why.

The operator issues invite codes; each code grants a batch of anonymous tokens.
After a one-time activation in the browser, a service worker spends tokens
lazily: it rides a **points-metered session cookie**, and only redeems a token
when the session runs out. The server can verify a request carries a valid token
but **cannot link any redemption to the invite code or issuance event** — blind
issuance guarantees this cryptographically.

## What it does and does NOT do

- ✅ Issuer + verifier in one Node/TS service, own Docker container.
- ✅ Blind RSA issuance, publicly-verifiable redemption, atomic double-spend guard.
- ✅ Invite codes with a per-code quota — a balance drawn in capped batches across devices; admin CLI.
- ✅ Activation page + service worker + IndexedDB token pool.
- ✅ nginx `auth_request` integration, **gating every client by default** except a
     `geo`-whitelisted set (LAN `192.168.88.0/24`, WireGuard VPN `10.10.10.0/24`,
     localhost, monitoring egress). The IP decision lives in the service.
- ✅ **Points-metered sessions.** A token opens/tops up a session worth
     `pointsPerToken` (`2_000_000` here); each request draws `pointsPerRequest`
     (`1000`) → **~2000 requests per token**. Cost stays linear in requests
     (unlike a time window, a bot can't amortise). See *Points-metered sessions*.
- ✅ **Web Worker-parallelised activation** + native raw-RSA signing, so big
     quotas (~10k) are practical.
- ✅ **Operator bypass password**, **token export/import**, **balance page**,
     and an early-**refill buffer** (all below).
- ✅ **Media is gated; only non-media static is exempt** (css/js/fonts/icons).
     Images meter through the service worker; **video/audio bypass the SW**, so
     they ride a session the SW keeps funded via `POST /pp/refill` (see *Static
     assets & media*). This reversed an earlier media exemption once scrapers
     began pulling image/video links directly through the frontends.
- ❌ **No key rotation overlap.** One key epoch; regenerating keys invalidates all
     outstanding tokens *and* bypass cookies.
- ❌ GET requests only are gated (these frontends are read-only). Non-GET from a
     gated client without a live session gets a 401.

## Architecture

```
Browser SW ── ride session cookie (X-PP-SW) ──► nginx (gated server block)
     │  on 401 redeem a token; when the         │  every client, $pp_gate==1
     │  balance (X-PP-Points) runs low, top up   ▼  auth_request /pp/verify
     ▼                                         privacy-pass container
  IndexedDB token pool                         172.33.0.1:8017  (host 8017 → 8787)
                                             ├─ /verify   meter session pts, else
                                             │            redeem token → Set-Cookie
                                             ├─ /pp/refill    token → top up session
                                             ├─ /pp/issue     blind-sign a batch
                                             ├─ /pp/token-key  issuer public key
                                             ├─ /pp/config     metering params
                                             ├─ /pp/points     session balance
                                             ├─ /pp/bypass     password → bypass cookie
                                             ├─ /pp/buy*,/pp/claim*  sell codes via BTCPay
                                             │                 (optional, env-gated)
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
                + purchases
src/keys.ts     keypair + bypass HMAC  src/bypass.ts  stateless bypass cookie (HMAC)
src/btcpay.ts   BTCPay Greenfield client + webhook HMAC verify
client/activate.ts  bundled → public/activate.js (activation + bypass password)
client/pp-worker.ts bundled → public/pp-worker.js (parallel blind/unblind)
public/activate.html  activation UI   public/sw.js   lazy-spend service worker
public/status.html    balance + token export/import
public/buy.html       package picker  public/claim.html  post-payment code reveal
data/           mounted volume: pp.db (SQLite) + keys/ (RSA keypair)  ← secrets
```

## Deploy

```sh
cd privacy-pass
cp .env.example .env          # adjust if needed
docker compose up -d --build  # builds TS + client bundle, generates keys on first run
```

Then reload nginx so the gated routes + `$pp_gate` map take effect (already
merged into `../nginx/nginx.conf`):

```sh
docker exec nginx nginx -t && docker exec nginx nginx -s reload
# or: docker compose -f ../nginx/docker-compose.yaml up -d
```

## Issuing codes

```sh
# Balance: a shared pool of N tokens, drawn in capped batches until empty.
docker compose exec privacy-pass node dist/admin.js new-code --quota 500
#   MW4TM-Z3GBR-NYTSX  (quota 500)  https://subdomain.example.com/pp/activate?code=MW4TM-Z3GBR-NYTSX
docker compose exec privacy-pass node dist/admin.js new-code --quota 500 --count 10   # ten at once

# Faucet: reusable code that accrues 50 tokens/day up to a 500 cap; each entry
# dispenses a capped draw of what has built up (stacks into the device pool).
docker compose exec privacy-pass node dist/admin.js new-code --daily 50 --cap 500

docker compose exec privacy-pass node dist/admin.js list-codes
docker compose exec privacy-pass node dist/admin.js revoke-code MW4TM-Z3GBR-NYTSX   # not-fully-drawn codes only
```

A code is a **balance**, not a one-shot: each activation draws
`min(remaining, PP_TOKENS_PER_DRAW)` tokens (default 50), so the same code
works across several devices and sites until the balance is empty. The
activation page **remembers the last code that drew successfully** (per site,
in localStorage) and silently draws another batch when the device runs low —
users type a code once per site per device and then forget about it. Revoking
a partially-drawn code stops future draws; already-issued tokens stay valid
(they're unlinkable by design — there is nothing to claw back).

Draw sizing is a privacy parameter, not just UX: draws of tens of tokens made
ahead of need keep the (code-authenticated, linkable) issuance events
temporally decorrelated from the (anonymous) redemptions. One-token draws
would let the operator link redemptions back to codes purely by timing —
don't set `PP_TOKENS_PER_DRAW` low. The cap is a client default only;
`/pp/issue` accepts any batch up to the code's remaining balance.

**Merging codes:** a user with several codes (say, an old one plus a newly
bought package) can fold one into another under "Have more than one code?" on
`/pp/activate` — the other code's remaining tokens move onto the device's
saved code, the source dies immediately, and an exhausted destination comes
back to life (so the password-manager entry stays valid forever). Operator
equivalent: `node dist/admin.js merge-code <from> <into>`. Balance codes only
(faucets keep their accrual); the server stores and logs nothing linking the
two codes.

A **faucet code** starts full (first entry yields a first draw immediately),
then refills at `--daily` per day up to `--cap`. Re-entering it — or the silent
top-up doing so — dispenses a capped draw of what has accumulated since last
time — a low-friction standing grant for a trusted user, without ever handing
out an unlimited code. The accrual period is `PP_ACCRUAL_PERIOD_MS` (default 24h).

**What to tell a user:** send them the `link:` line — it opens the activation
page with the code prefilled; they just click **Activate** (the code is never
auto-submitted, so link previews/prefetchers can't burn a draw). Or: "Visit
`/pp/activate`, paste this code once." Tokens live in that one browser/device;
the code's remaining balance can be drawn again on other devices/browsers, or
after clearing site data. Codes **stack**, so a user can add more later.
The activation form is password-manager friendly: the code field is a real
password input (`autocomplete="current-password"`, with a "Show code" toggle),
so managers offer to save the code on activation and autofill it on other
devices — handy now that one code is a balance drawn everywhere.

With points-metered sessions, one token covers `pointsPerToken/pointsPerRequest`
requests (~2000 here), so a 500-token code ≈ 1M requests. Activation
blind-signs one draw's worth of tokens in the browser (parallelised across Web
Workers), so even huge codes activate in seconds — the balance is drawn down
over time, not all at once.

## Selling codes (BTCPay)

Optionally, users can **buy** invite codes with crypto instead of asking for
one: `/pp/buy` lists fixed packages, payment runs through a **BTCPay Server**
you operate, and a settled invoice automatically mints a code revealed on a
claim page — a balance the buyer can draw on all their devices. Everything
downstream (activation, blind signing, metering) is the ordinary invite-code
flow.

**Enable it** by setting all of `PP_BTCPAY_URL`, `PP_BTCPAY_API_KEY`,
`PP_BTCPAY_STORE_ID`, `PP_BTCPAY_WEBHOOK_SECRET`, and `PP_BTCPAY_PACKAGES`
(JSON array of `{id,label,tokens,amount,currency}`) in `.env` and recreating
the container. All unset = feature off (routes 404, pages hidden). BTCPay-side
setup:

1. Create a Greenfield API key with only `btcpay.store.cancreateinvoice` and
   `btcpay.store.canviewinvoices`, scoped to the one store.
2. Create a store webhook pointing at `https://<gated-host>/pp/buy/webhook`
   with events **InvoiceSettled, InvoiceExpired, InvoiceInvalid**, and put its
   secret in `PP_BTCPAY_WEBHOOK_SECRET`. The path is reachable because nginx
   proxies `^~ /pp/` ungated.

**Payment methods (incl. Monero)** are configured entirely on the BTCPay side —
invoices offer every method the store has enabled (`createInvoice` sets no
`paymentMethods` restriction), and the webhook/settlement flow is identical for
all of them. To accept **Monero**, which fits this service's privacy goals
better than transparent-chain BTC:

1. Install the community **Monero plugin** in BTCPay (Server Settings →
   Plugins) and restart.
2. Point it at a `monerod` node and a **view-only** `monero-wallet-rpc` (the
   BTCPay host never needs spend keys), then enable XMR on the store and set
   its confirmation policy (XMR settles after ~10 confirmations ≈ 20 min; the
   claim page just keeps polling until `InvoiceSettled` fires).
3. Nothing changes in this service — packages stay priced in
   `PP_BTCPAY_PACKAGES`' fiat/BTC currency and BTCPay converts to XMR at
   invoice time. Update the copy in `public/buy.html` if you enable or drop
   coins.

**Flow:** buyer picks a package → `POST /pp/buy/checkout` creates the BTCPay
invoice (its `redirectURL` points back to `/pp/claim?ct=<claim token>`) →
buyer pays on the BTCPay checkout → the signed webhook flips the purchase
`pending → settled` and mints the code **exactly once** (atomic pending-only
guard, so redeliveries and races can't double-mint) → the claim page polls
`/pp/claim/status` and reveals the code + an activate link. If a webhook is
missed, the status poll reconciles directly against BTCPay. The claim token in
the URL is the only credential — no account, no email; the buy page also
stashes the claim URL in `localStorage` as a recovery copy.

**Recovery:** `docker compose exec privacy-pass node dist/admin.js
list-purchases` shows every purchase with its claim link and code — match a
buyer by BTCPay invoice id or payment time. A stuck-but-paid invoice can be
marked **Settled in the BTCPay UI**, which fires a genuine signed webhook and
fulfills automatically. Refunds are manual in BTCPay.

**Privacy:** the `purchases` row links a BTCPay invoice to the minted code —
necessary for delivery, and swept `PP_PURCHASE_RETENTION_MS` (default 30 days)
after the code is first revealed, severing that link. Blind issuance is
untouched: the operator can know *who bought a code*, never *what it is used
for*. Never log minted codes or store them alongside `/pp/issue` data.

## Bypass password (operator escape hatch)

For your own devices you usually don't want to burn tokens at all. Set
`PP_BYPASS_PASSWORD` in `.env` (empty = feature off) and restart. Entering that
password on the activation page — or opening the prefilled link — mints a
signed, HttpOnly `pp_bypass` cookie; while it's present the verifier returns
`204` for every gated request **without spending a token or session points**.

```sh
docker compose exec privacy-pass node dist/admin.js bypass-link
#   link: https://subdomain.example.com/pp/activate?pw=<password>
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
- **Proactive top-up (for media).** Video/audio bypass the SW and can't trigger
  the reactive renewal above, so the SW funds the session *ahead of demand*:
  nginx returns the live balance in the `X-PP-Points` response header, and when it
  drops below `PP_SESSION_TOPUP_THRESHOLD` the SW single-flight-spends one token
  via `POST /pp/refill` to **add** `pointsPerToken` to the current session (stable
  cookie). See *Static assets & media*.
- **Spent-token resilience.** On renewal the SW pops tokens until one opens a
  session, discarding any already-spent ones (e.g. from an imported, partly-used
  pool), bounded so a fully-spent pool can't spin.
- **Privacy trade-off.** The requests within one session are mutually linkable
  via the cookie, but sessions are unlinkable to each other and to issuance
  (random id, blind tokens). Set `PP_POINTS_PER_TOKEN == PP_POINTS_PER_REQUEST`
  to fall back to one-token-per-request (max anonymity).

## Static assets & media

Because the gate meters **per request**, what to exempt matters. Three classes:

- **Non-media static** (css/js/fonts/icons): **exempt** at nginx (a narrowed
  regex `css|js|mjs|map|svg|ico|woff2?|ttf|eot`, plus `^~ /static/` for a
  service's own bundle, e.g. rimgo). The SW's `STATIC_RE` skips them too. Bots
  don't scrape these; metering them just wastes points.
- **Images** (`<img>`): **gated**, at the media class cost
  (`PP_POINTS_PER_MEDIA_REQUEST`). They flow through the SW like any GET, so they
  meter per-request (ride/spend). This is what stops scrapers pulling image links
  directly through us.
- **Audio / video** (`<video>`/`<audio>`): **gated, but special** — and the
  cheapest flat class (`PP_POINTS_PER_STREAM_REQUEST`: HLS/DASH segments and
  manifests, progressive mp4/webm, piped's `/videoplayback`, nitter's
  `/video/`). The low base is a floor; with `PP_POINTS_PER_MIB` set, streaming
  pays primarily by the bytes it requests. Media-element
  range requests **bypass the service worker** (verified: they arrive `sw=0`, no
  token), so they can't trigger the SW's reactive renewal. They ride a session the
  SW keeps **funded ahead of demand**:
  1. nginx surfaces the balance as `X-PP-Points` (`auth_request_set` +
     `add_header`) on every gated response.
  2. On any SW-visible request, if the balance is below
     `PP_SESSION_TOPUP_THRESHOLD` (default `200000` = 200 requests) the SW spends
     one token via `POST /pp/refill`, adding `pointsPerToken` to the live session.
  3. The large per-token buffer (`2_000_000` = ~2000 requests) covers stretches of
     pure playback when the browser has killed the idle SW and no top-up can fire.

> Bots hitting a media link directly just `401` at nginx (no session, no token) —
> that path needs none of the SW machinery. The top-up exists solely to keep
> *real users'* video playing. A marathon single-page video (30+ min, no
> navigation, SW asleep throughout) can still drain the session and stall until a
> reload; raise `PP_SESSION_TOPUP_THRESHOLD` if that matters.

**Size-based pricing (`PP_POINTS_PER_MIB`):** the gate cannot know a response's
size when `auth_request` fires, but many bandwidth-heavy requests *declare*
what they're asking for: media-element range requests send a `Range` header
(forwarded as `X-PP-Range`), and piped/googlevideo `/videoplayback` URLs carry
`range=a-b`/`clen=` query params in `X-Original-URI`. When `PP_POINTS_PER_MIB`
is set, such requests pay their class cost **plus** `ceil(MiB × rate)` — so a
4K segment costs proportionally more than a 480p one and bulk video pulls pay
by the terabyte. Additive on purpose: a forged tiny `Range` can never price a
request *below* its flat class cost, and a client can't understate the span —
the range is what the upstream serves back. Requests with no size hint stay
flat, so this changes nothing for HTML/API traffic.

The threshold can also be raised **per host**: `PP_TOPUP_THRESHOLD_OVERRIDES`
(JSON, `hostname -> points`) is applied by `/pp/config` from the request's Host
header, and each host's SW reads its own origin's config. A video-heavy host
can therefore bank a multi-token prefunded session (the SW trickles one token
per top-up until the threshold is met while it's awake) while every other host
keeps the small, more private default. Token *value* deliberately stays global
— the override pre-pays more into the session; it never makes tokens cheaper on
one host, so there's nothing for a scraper to arbitrage. nginx must forward the
original Host on `^~ /pp/` (`proxy_set_header Host $host;`) or every host sees
the default.

Per-service media routes: redlib `/preview`,`/img`,`/thumb`,`/vid`,`/hls`; nitter
`/pic`,`/video`; rimgo root `/{id}.{ext}` (its own UI is under `/static`). None
are exempted — they fall through to `location /` and meter.

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
- **Refill buffer:** once the pool is within `PP_REFILL_BUFFER_REQUESTS` (`6000`
  here, ≈ 3 tokens) of empty, the SW steers new **navigations** to
  `/pp/activate?refill=1&return=<path>` while still serving **sub-resources**
  from the buffer — so in-flight page loads finish and the pool tops up early.
- **Exhaustion is graceful:** truly out of tokens, a navigation redirects to
  `/pp/activate?exhausted=1&return=<path>`; a sub-resource uses
  `WindowClient.navigate` to send the owning tab there rather than leaving a
  broken page.
- **Silent top-up:** on either redirect, the activation page draws another
  batch from the remembered code (localStorage `pp_code`) without user input
  and bounces straight back to the same-origin `return=` path — the user just
  sees a brief blink. Only when there is no stored code, or the server says
  the code is dead (its balance is empty — the stored code is then forgotten),
  does the manual form appear. A sessionStorage timestamp gate breaks any
  redirect loop.

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
    default          1;    # gate every client...
    127.0.0.1        0;    # ...except localhost,
    10.10.10.0/24    0;    # the WireGuard VPN,
    192.168.88.0/24  0;    # the LAN,
    198.135.181.189  0;    # and monitoring (Uptime Kuma) egress.
}
```

`auth_request` cannot be made conditional in nginx (no variables, no `if`), and
putting it behind a nested `error_page` breaks the `401 -> @challenge` redirect.
So each gated server block's `location /` runs `auth_request /pp/verify` on
**every** dynamic request and passes the geo decision to the verifier as the
`X-PP-Gate` header. **The IP gate therefore lives in the service**: `/verify`
returns `204` immediately when `X-PP-Gate != 1`, and only enforces a token for
gated clients. `$remote_addr` is the true client IP, recovered from PROXY
protocol by the existing `set_real_ip_from 10.10.10.0/24`.

Because the verifier is in the path for every gated request, `location /` also
has `error_page 502 503 504 = @pp_fail_open` so a privacy-pass outage fails
**open** (the site stays up, gate stops enforcing) rather than 500-ing everyone.

Every client is gated by default; to **whitelist** one, add its IP/CIDR to the
`geo` block with value `0`. This gate is replicated across the quetre, redlib,
nitter, and rimgo server blocks (the `geo` map is global); protect another
service by copying that block onto its upstream — or follow [`INSTALL.md`](./INSTALL.md).

> **nginx edit gotcha:** the `nginx` container bind-mounts `nginx.conf` as a
> single file. Editing it creates a new inode, so `nginx -s reload` keeps reading
> the *old* file. After any edit, recreate the container:
> `docker compose -f ../nginx/docker-compose.yaml up -d --force-recreate nginx`.

> **LAN caveat:** the `192.168.88.0/24` carve-out only applies to
> **direct-to-host** access showing that source. A LAN device reaching the site
> through the public tunnel egresses as the LAN's *public* IP — which is gated
> like any other client unless you also whitelist it.

## Privacy properties & their limits

- The issuer never persists or logs blinded values, tokens, IPs, or user agents
  alongside invite codes. Redemptions are unlinkable to issuance by construction.
- **What an unmodified client guarantees by itself, regardless of the
  operator:** blinding happens in the browser, so no matter what the server
  logs, a redeemed token cannot be matched to any issuance record — using
  tokens reveals nothing beyond what visiting an ungated site already would
  (IP, timing, the pages fetched), plus the coarse fact that some code drew N
  tokens at some time. IP correlation is a property of HTTP, not of this
  system; network-layer anonymity needs Tor/VPN here as anywhere. The two
  assumptions this rests on are client-checkable: the issuer key is the same
  for everyone (fingerprint shown on the activation page, no code needed) and
  draws are batched ahead of need (the client builds the batch itself, so it
  always knows how many tokens it drew and when).
- The spent-set stores only a SHA-256 of each redeemed token — no token values,
  no client identifiers.
- Residual metadata risk: with a tiny user set, IP/timing correlation is possible;
  the anonymity set grows with users. Tokens can be shared/exported by design and
  cannot be revoked once issued (only unused *codes* can be revoked).
- **Same-key assumption:** unlinkability holds only if every user is signed by
  the same issuer key — a per-user key would let the operator partition
  redemptions. `/pp/token-key` is public (no code needed) and the activation
  page shows the key's SHA-256 fingerprint (= RFC 9578 `token_key_id`), so
  users can compare it across devices and with each other out-of-band.
- **Session linkability:** requests within one session share a cookie and are
  mutually linkable (~`pointsPerToken/pointsPerRequest` of them); session ids are
  random and never derived from the token, so sessions stay unlinkable to each
  other and to issuance.
- **Bypass is not anonymous:** the operator bypass cookie is a stable per-device
  credential — it deliberately trades away unlinkability for the operator's own
  convenience. Keep the password secret.
- **Purchases link payment→code, never code→browsing:** a BTCPay purchase row
  ties an invoice (payment metadata on your BTCPay instance) to the minted
  invite code until the retention sweep deletes it. Token issuance and
  redemption stay blind — the purchase reveals nothing about what the code's
  tokens are spent on.

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
