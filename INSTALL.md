# Installing Privacy Pass in front of a web service

This guide walks through putting the `privacy-pass` anonymous-token bot gate in
front of **any** HTTP service reverse-proxied by **nginx**. It's written to be
generic — replace the placeholders with your own values.

- **What it does:** every gated request must carry a valid, unforgeable
  anonymous token (or ride a session opened by one). Tokens are handed out only
  via operator-issued **invite codes**, and each request **spends points**, so a
  scraper can't mint credentials by burning CPU and can't amortise one credential
  over unlimited requests. Redemption is cryptographically **unlinkable** to the
  invite code (Blind RSA, RFC 9578 Type 2).
- **When to use it:** a closed/known audience you can hand invite codes to, where
  you want a hard, accountable per-request cap — not an open public site. (For an
  open site, a proof-of-work gate like Anubis fits better; it trades accounting
  for statelessness.)
- **Requirements the client must meet:** a modern browser with JavaScript,
  Service Workers, IndexedDB, and WebCrypto. Non-browser clients can't pass.

---

## How it works (request flow)

```
                    ┌─────────────────────────── your nginx (after TLS) ───────────────────────────┐
browser  ─────────► │  server { server_name example.com; ... }                                     │
  │  (service       │    location / {                                                               │
  │   worker rides  │        auth_request /pp/verify;   ◄── subrequest on EVERY dynamic request     │
  │   the session   │        ...                                                                    │
  │   cookie, adds  │    }                                                                          │
  │   X-PP-SW)      │    location = /pp/verify { proxy_pass PP/verify; forwards Auth+Cookie+Gate }  │
  └─────────────────┤    location ^~ /pp/     { proxy_pass PP;        # activation, issuance, key } │
                    └───────────────────┬──────────────────────────────────────────────────────────┘
                                        │ 204 allow  /  401 challenge
                                        ▼
                             privacy-pass container  (Node/TS + SQLite + Blind-RSA key)
                             /verify        meter session points, else redeem a token → Set-Cookie
                             /pp/issue      blind-sign a batch of tokens for a valid code
                             /pp/refill     spend a token to top up the current session
                             /pp/token-key  issuer public key   /pp/config  metering params
                             /pp/activate   activation page + sw.js + status.html
```

- The gate lives in nginx's `http{}` block — **after TLS termination**.
- `auth_request` can't be made conditional in nginx, so it runs on **every**
  dynamic request; the *decision* of whether to enforce lives in the service,
  driven by the `X-PP-Gate` header nginx sets from a `geo` map (so you can
  whitelist your LAN/VPN/monitoring without touching the service).
- One container can gate **many** hostnames — it's host-agnostic. Add a server
  block per host, all pointing `/pp/verify` + `^~ /pp/` at the same container.

---

## Prerequisites

- **nginx** with the standard `ngx_http_auth_request_module` (built in on the
  mainline/most distro packages). TLS is terminated here.
- **Docker + Docker Compose** to run the container (or Node 20+ to run it bare).
- A reverse-proxy setup where nginx `proxy_pass`es to your upstream app.

---

## Step 1 — Deploy the privacy-pass container

From the `privacy-pass/` directory:

1. **Create `.env`** (see the [Configuration reference](#configuration-reference)):

   ```ini
   PP_PORT=8787
   PP_ISSUER_NAME=example.com
   PP_GATED_ORIGIN=https://example.com     # used only to print activation links
   PP_QUOTA_DEFAULT=500
   PP_POINTS_PER_TOKEN=2000000             # 2M / 1000 = 2000 requests per token
   PP_POINTS_PER_REQUEST=1000
   PP_REFILL_BUFFER_REQUESTS=6000
   PP_SESSION_TOPUP_THRESHOLD=200000
   PP_BYPASS_PASSWORD=                      # empty = operator bypass disabled
   PP_DB_PATH=/data/pp.db
   PP_KEY_DIR=/data/keys
   ```

2. **Bring it up.** The provided `docker-compose.yaml` builds the image, mounts
   `./data` (SQLite db + the generated RSA keypair — **these are secrets**), and
   publishes host port `8017 → 8787`:

   ```bash
   docker compose up -d --build
   docker compose logs -f      # look for: [pp] issuer ready, key epoch <hex>
   ```

3. **Decide how nginx reaches it.** Two common layouts:

   | Layout | nginx reaches the container at |
   |---|---|
   | **nginx in Docker** (recommended) | the pinned bridge **gateway** IP, e.g. `http://172.33.0.1:8017`. The compose file pins the subnet `172.33.0.0/16` (gw `172.33.0.1`) precisely so you can hardcode this. |
   | **nginx on the host** | `http://127.0.0.1:8017` (the published port). |

   Below, `PP` means this address (e.g. `http://172.33.0.1:8017`).

> The container generates its Blind-RSA keypair on first run and persists it to
> `PP_KEY_DIR`. **Back up `data/keys/`** — losing it invalidates every issued
> token. The SQLite db (`pp.db`) holds invite codes, the spent-token set, and
> sessions; it's less precious (spent-set and sessions are disposable) but back
> up the invite codes if they matter.

---

## Step 2 — Wire up nginx

### 2a. The gate decision (once, in `http{}`)

Decide which clients are metered. `geo` maps the real client IP to `$pp_gate`
(`1` = enforce, `0` = pass straight through):

```nginx
http {
    geo $pp_gate {
        default          1;    # gate everyone...
        127.0.0.1        0;     # ...except localhost,
        10.0.0.0/8       0;     # your LAN/VPN,
        203.0.113.10     0;     # your monitoring's egress, etc.
    }
    # ... server blocks below ...
}
```

If nginx sits behind a tunnel/load balancer/CDN, recover the true client IP
first, or the `geo` map sees the proxy's address:

```nginx
    set_real_ip_from 10.10.10.0/24;   # the trusted hop(s) in front of you
    real_ip_header   proxy_protocol;  # or X-Forwarded-For, per your setup
```

### 2b. The server block

Add this to the `server {}` for your gated host. Replace:
`UPSTREAM` → your app (e.g. `http://127.0.0.1:8080`), `PP` → the container
(e.g. `http://172.33.0.1:8017`), `example.com` → your host.

```nginx
server {
    listen 443 ssl;
    server_name example.com;
    # ... your ssl_certificate / ssl_certificate_key ...

    # If TLS is terminated on a non-standard internal port behind a tunnel,
    # keep nginx-generated redirects relative so the internal port doesn't leak:
    absolute_redirect off;

    # --- Privacy Pass ------------------------------------------------------

    # Internal auth subrequest. Forwards the token, the session cookie, and the
    # geo gate decision. Never proxies the body (it's a HEAD-like check).
    location = /pp/verify {
        internal;
        proxy_pass PP/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Cookie        $http_cookie;
        proxy_set_header X-PP-Gate      $pp_gate;   # 1 => meter, 0 => allow
    }

    # The activation page, issuance, key directory, service worker, etc.
    # ^~ so /pp/*.js is NOT swallowed by the static regex below. Big body +
    # long timeouts because a large token batch (/pp/issue) is multi-MB.
    location ^~ /pp/ {
        client_max_body_size 64m;
        proxy_read_timeout   300s;
        proxy_send_timeout   300s;
        proxy_pass PP;
    }

    # NON-media static is exempt (no token burned on scripts/styles/fonts/icons).
    # Images and audio/video are deliberately NOT here — see Step 3.
    location ~* \.(?:css|js|mjs|map|svg|ico|woff2?|ttf|eot)$ {
        proxy_pass UPSTREAM;
    }

    # Everything else is gated.
    location / {
        auth_request /pp/verify;

        # Propagate the session cookie the verifier mints on token redemption,
        # so subsequent requests ride the session (no token spent).
        auth_request_set $pp_setcookie $upstream_http_set_cookie;
        add_header Set-Cookie $pp_setcookie;

        # Surface the session balance so the service worker can top up before
        # SW-invisible media drains it (see Step 3).
        auth_request_set $pp_points $upstream_http_x_pp_points;
        add_header X-PP-Points $pp_points always;

        error_page 401 = @challenge;
        # Fail OPEN if the verifier is unreachable — an outage never takes the
        # site down; the gate simply stops enforcing.
        error_page 502 503 504 = @pp_fail_open;

        proxy_pass UPSTREAM;
    }

    # No live session and no valid token. A service worker sets X-PP-SW and
    # wants a 401 so it can lazy-spend a token; a plain browser navigation gets
    # the activation page.
    location @challenge {
        if ($http_x_pp_sw = "1") { return 401; }
        if ($http_accept ~* text/html) { return 302 /pp/activate?challenge=1&return=$uri; }
        add_header WWW-Authenticate 'PrivateToken' always;
        return 401;
    }
    location @pp_fail_open {
        proxy_pass UPSTREAM;
    }
}
```

### 2c. Reload

```bash
nginx -t && nginx -s reload
```

> **Docker gotcha:** if `nginx.conf` is **bind-mounted as a single file**, an
> in-place edit changes the inode and a `reload` may not see it. Recreate the
> container instead: `docker compose up -d --force-recreate nginx`.

---

## Step 3 — Static assets & media (the important nuance)

The gate meters **per request**, so you must decide what's worth a token. There
are three request classes:

| Class | Handling |
|---|---|
| **Non-media static** (css/js/fonts/icons) | **Exempt** at nginx (the regex above, and/or a `^~ /static/` prefix). Bots don't scrape these; metering them just wastes points. |
| **Images** (`<img>`) | **Gated.** They go through the service worker like any GET → per-request ride/spend. This is what stops scrapers pulling image links directly. |
| **Audio / video** (`<video>`/`<audio>`) | **Gated, but special.** Media-element range requests **bypass the service worker** entirely, so they can't trigger the SW's reactive renewal. They ride a session the SW keeps **funded ahead of demand**. |

**How the funded-session top-up works** (already wired above):

1. nginx returns the live session balance in the `X-PP-Points` response header.
2. The SW reads it on every request it *does* see (navigations, css/js, images,
   playlist fetches). When it drops below `PP_SESSION_TOPUP_THRESHOLD`, the SW
   single-flight-spends **one** token via `POST /pp/refill`, which **adds**
   `PP_POINTS_PER_TOKEN` to the current session (same cookie).
3. The large per-token buffer covers stretches of pure playback (when the browser
   has killed the idle SW and no top-up can fire).

**Adapting the exemptions to your app:** the template exempts by *extension*.
If your app serves its own UI assets under a path prefix (e.g. `/static/`,
`/assets/`), exempt that prefix directly so you don't meter the app's own chrome,
while still metering the *content* media:

```nginx
    location ^~ /static/ { proxy_pass UPSTREAM; }   # the app's own UI bundle
```

Leave the actual content media (user images/videos) to fall through to
`location /` so it meters. Identify your app's media routes (grep its source for
the image/video proxy handlers) to be sure they aren't accidentally covered by an
extension exemption.

> **Caveat:** a marathon single-page video session (tens of minutes, no
> navigation, SW killed the whole time) can drain the funded session and stall
> until a page reload. If that matters, raise `PP_SESSION_TOPUP_THRESHOLD` so
> each navigation banks more runway (costs slightly more token spend).

---

## Step 4 — Issue an invite code

Two kinds of code. **Single-use** codes mint one batch of `--quota` tokens then
die. **Faucet** codes (`--daily`) accrue tokens per day up to a cap and dispense
everything built up each time they're entered — a reusable standing grant.

```bash
docker compose exec privacy-pass node dist/admin.js new-code --quota 500
# ABCDE-FGHJK-LMNPQ  (quota 500)  https://example.com/pp/activate?code=ABCDE-FGHJK-LMNPQ
docker compose exec privacy-pass node dist/admin.js new-code --quota 500 --count 10  # batch

# Faucet: 50 tokens/day, cap 500. Starts full; re-enter to collect what accrued.
docker compose exec privacy-pass node dist/admin.js new-code --daily 50 --cap 500

docker compose exec privacy-pass node dist/admin.js list-codes
docker compose exec privacy-pass node dist/admin.js revoke-code ABCDE-FGHJK-LMNPQ  # unused only
```

Share the **link** — it prefills the code but still requires the user to click
Activate (so link prefetchers can't burn it).

### Optional — sell codes via BTCPay

If you run a [BTCPay Server](https://btcpayserver.org/), users can buy codes
themselves at `/pp/buy` instead of asking you. Set in `.env` (all required to
enable; empty = feature off, routes 404):

```ini
PP_BTCPAY_URL=https://btcpay.example.com
PP_BTCPAY_API_KEY=...        # Greenfield key: btcpay.store.cancreateinvoice + canviewinvoices
PP_BTCPAY_STORE_ID=...
PP_BTCPAY_WEBHOOK_SECRET=... # store webhook -> https://example.com/pp/buy/webhook
PP_BTCPAY_PACKAGES=[{"id":"s","label":"Starter","tokens":500,"amount":"3.00","currency":"EUR"}]
```

In BTCPay, create a store webhook pointing at `https://<host>/pp/buy/webhook`
with events **InvoiceSettled, InvoiceExpired, InvoiceInvalid** (the `^~ /pp/`
location already passes it through ungated). Payment methods are whatever the
store enables — invoices are created without a `paymentMethods` restriction,
so adding e.g. **Monero** (BTCPay's Monero plugin + a view-only wallet) needs
no change here beyond the buy-page copy. A settled invoice mints a
single-use invite code exactly once (webhook redeliveries are no-ops) and the
buyer claims it at `/pp/claim?ct=<token>` — the claim URL is the only
credential, so tell buyers to save it. Recovery: `node dist/admin.js
list-purchases`, or mark the invoice Settled in the BTCPay UI to re-fire
fulfillment. Purchase rows (the payment↔code link) are swept
`PP_PURCHASE_RETENTION_MS` after the code is revealed.

---

## Step 5 — Activate in a browser

1. Visit the link (or any gated page → you're redirected to `/pp/activate`).
2. Enter the code and Activate. The page registers the service worker, then fans
   the Blind-RSA blinding across Web Workers, POSTs the batch to `/pp/issue`,
   unblinds, and stores the finished tokens in IndexedDB.
3. Browse normally. The SW rides a points-metered session and only spends a token
   when it runs low.
4. `/pp/status` (status.html) shows the remaining balance and can **export/import**
   tokens between devices/origins.

**Per-origin pools:** tokens live in the browser's IndexedDB, which is
per-origin. A user activates **once per gated hostname**. Tokens are
cross-origin-valid (same issuer key), so `status.html` export/import can bridge
one activation to your other gated hosts.

---

## Configuration reference

All via `.env` (read once at startup — recreate the container to apply changes).

| Variable | Default | Meaning |
|---|---|---|
| `PP_PORT` | `8787` | Port the service listens on inside the container. |
| `PP_ISSUER_NAME` | `quetre…` | Cosmetic issuer label. |
| `PP_GATED_ORIGIN` | `https://…` | Base URL used only to print activation links in the admin CLI. |
| `PP_QUOTA_DEFAULT` | `500` | Default `--quota` (and faucet `--cap`) for `new-code`. |
| `PP_ACCRUAL_PERIOD_MS` | `86400000` | Accrual period for faucet (`--daily`) codes. |
| `PP_POINTS_PER_TOKEN` | `1000000` | Points a token adds to a session. |
| `PP_POINTS_PER_REQUEST` | `1000` | Points each gated request draws. `token/request` = requests per token. |
| `PP_POINTS_PER_MEDIA_REQUEST` | `100` | Points a **media** request draws (images + audio/video, detected from the request URI). Cheaper so image-heavy browsing doesn't drain a budget, while a direct media scrape still costs points. |
| `PP_REFILL_BUFFER_REQUESTS` | `5000` | When the **token pool** falls to this many requests of reserve, new navigations are steered to re-activate (top up your code supply). |
| `PP_SESSION_TOPUP_THRESHOLD` | `200000` | Points; when a live **session** drops below this the SW spends a token to top it up (keeps media funded). Size ≥ the request cost of the longest single video. |
| `PP_BYPASS_PASSWORD` | `` (empty) | If set, `/pp/activate?pw=…` mints a signed **operator bypass cookie** that skips metering entirely. Empty = feature off. Breaks unlinkability — keep it secret. |
| `PP_SESSION_COOKIE` | `pp_session` | Session cookie name. |
| `PP_DB_PATH` | `/data/pp.db` | SQLite path (inside the mounted volume). |
| `PP_KEY_DIR` | `/data/keys` | RSA keypair dir. **Persist + back up.** |
| `PP_SESSION_MAX_AGE_MS` | 30 days | Session cookie lifetime + sweep age. |
| `PP_BYPASS_MAX_AGE_MS` | 365 days | Operator bypass cookie lifetime. |
| `PP_BTCPAY_URL` / `_API_KEY` / `_STORE_ID` / `_WEBHOOK_SECRET` | `` (empty) | BTCPay Server integration for selling codes. **All four** (plus packages) must be set to enable `/pp/buy`; empty = off. |
| `PP_BTCPAY_PACKAGES` | `[]` | JSON array of purchasable packages: `{id,label,tokens,amount,currency}` (amount is a decimal string). |
| `PP_PURCHASE_RETENTION_MS` | 30 days | Purchase rows (payment↔code link) are deleted this long after the code is revealed. 0 = never. |

**Tuning intuition:** `pointsPerToken / pointsPerRequest` = requests per token.
Bigger tokens = fewer activations/renewals but coarser accounting. The top-up
threshold trades token-spend frequency against media playback headroom.

---

## Operations

- **Update / rebuild:** `docker compose up -d --build`.
- **Change `.env` or `nginx.conf`:** recreate the affected container
  (`--force-recreate`) — a plain reload can miss single-file bind-mount edits.
- **Back up:** `data/keys/` (critical) and `data/pp.db` (invite codes).
- **Revoke a leaked code:** `revoke-code <code>` (only if still unused).
- **Rotate keys:** delete `data/keys/` and restart — **invalidates all
  outstanding tokens and bypass cookies** (one key epoch, no overlap). Users must
  clear site data and re-activate.

---

## Troubleshooting & gotchas

- **Cold visitors get a bare 401 instead of the activation page.** Check the
  `@challenge` block ordering; a nested `error_page` can swallow the
  `401 → @challenge` redirect. Keep `auth_request` always-on and the IP decision
  in `X-PP-Gate` (don't gate with `if ($pp_gate) return …`).
- **Everything 401s even for whitelisted IPs.** Your `geo` map is seeing the
  proxy's IP, not the client's. Fix `set_real_ip_from` / `real_ip_header`.
- **Tokens suddenly all invalid (401 at verify).** The key epoch changed —
  usually a stray `PP_KEY_DIR` value made the service generate a *new* keypair.
  `docker exec privacy-pass env | grep PP_` and confirm the epoch in
  `/pp/health` matches. Reset by clearing site data + re-activating.
- **Video stalls / images broken when gated.** Media requests bypass the SW
  (`sw=0`). Ensure the funded-session top-up is wired (`X-PP-Points` header +
  `/pp/refill`) and the session buffer is large enough; see Step 3.
- **Redirects leak an internal `:port`.** Add `absolute_redirect off;`.
- **Only GET is gated.** Non-GET from a gated client without a live session gets
  a 401. This is intentional for read-only frontends; extend `server.ts` if you
  need to gate writes.
- **Big activations time out / 413.** Ensure `^~ /pp/` has
  `client_max_body_size 64m;` and raised proxy timeouts (in the template).

---

## Security notes

- `data/keys/` (RSA private key) and any `PP_BYPASS_PASSWORD` are **real
  secrets** — never commit them or expose the volume.
- The gate proves a request holds a valid token; it does **not** identify the
  user. Blind issuance means the server cannot link a redemption to the invite
  code — don't add logging that reconstructs that link.
- The operator bypass password is a deliberate, linkable escape hatch — enabling
  it trades away the anonymity guarantee for your own convenience.
