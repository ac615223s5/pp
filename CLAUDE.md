# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Privacy Pass (RFC 9578, Type 2 / Blind RSA 2048) bot-protection service: issuer + verifier in one Node/TS container, wired into nginx via `auth_request`. It gates read-only frontends (quetre, redlib, nitter, rimgo). Users activate an operator-issued invite code once; a service worker then spends anonymous tokens lazily against points-metered sessions. Redemptions are cryptographically unlinkable to issuance.

## Commands

```sh
npm run build          # tsc -> dist/ (server + admin CLI), then esbuild -> public/*.js (browser bundles)
npm run build:client   # esbuild only: client/activate.ts + client/pp-worker.ts -> public/ (iife, es2020)
npm start              # node dist/server.js
npm run admin          # node dist/admin.js  (invite-code CLI; usually run in the container)

docker compose up -d --build   # normal deploy; generates RSA keypair in data/keys/ on first run
docker compose exec privacy-pass node dist/admin.js new-code --quota 500      # balance code (drawn in batches)
docker compose exec privacy-pass node dist/admin.js new-code --daily 50 --cap 500  # faucet code
docker compose exec privacy-pass node dist/admin.js list-codes | revoke-code <code> | bypass-link
```

There are no tests and no linter. Config is env-only (`.env`, read once at startup in `src/config.ts`) — changing it requires recreating the container. Set `PP_DEBUG=1` for per-request gate logging; the same flag (surfaced as `debug` in `/pp/config`) makes the SW log token/session stats to the browser console.

## Architecture

Request flow: browser service worker → nginx (gated server block, `auth_request /pp/verify` on every dynamic request) → this service. nginx passes the `geo`-map whitelist decision as `X-PP-Gate`; **the IP gate is enforced here, not in nginx** (`auth_request` can't be conditional). 204 = allow, 401 = challenge. nginx fails *open* on verifier outage.

Two halves, sharing no code:

- **Server** (`src/`, compiled by tsc to `dist/`):
  - `server.ts` — all HTTP routes. `/verify` (the auth_request target: ride session → else redeem token → Set-Cookie), `/pp/issue` (blind-sign a batch for an invite code), `/pp/refill` (token → top up current session), `/pp/merge` (fold one balance code into another), plus token-key/config/points/bypass/activate/static.
  - `pp.ts` — Privacy Pass facade. Issuance deliberately bypasses the library's slow JS `blindSign`: RSABSSA blind-signing is a raw RSA private op, done with `node:crypto` `privateDecrypt` + `RSA_NO_PADDING` (~1ms vs ~350ms, byte-identical). Verification stays on `@cloudflare/privacypass-ts`. No origin/challenge binding — replay is stopped by the spent-set.
  - `store.ts` — better-sqlite3 (synchronous on purpose: check-and-set primitives are single statements). Four tables: `invite_codes` (balance codes with a `drawn` counter + faucet accrual), `spent_tokens` (SHA-256 hashes keyed by key epoch), `sessions` (points balances; `UPDATE … RETURNING` makes spend/top-up atomic), `purchases` (BTCPay invoice → minted code; `settlePurchase`'s pending-only guard + transaction is the exactly-once fulfillment lock).
  - `btcpay.ts` — BTCPay Greenfield API client (invoice create/get via global fetch) + webhook `BTCPay-Sig` HMAC verification over the raw body. The whole purchase feature is env-gated by `config.btcpayEnabled` (all `PP_BTCPAY_*` set + packages non-empty); off ⇒ routes 404, pages hidden.
  - `keys.ts` — one key epoch only. Keypair generated on first run into `PP_KEY_DIR`; the bypass-cookie HMAC secret is derived from the private key, so rotating keys invalidates all tokens *and* bypass cookies. `admin.ts` is a separate entrypoint sharing config + store.
- **Client** (`client/*.ts` bundled by esbuild into `public/`, plus hand-written `public/sw.js` and HTML):
  - `public/sw.js` — the lazy-spend service worker. Rides the `pp_session` cookie (marks fetches `X-PP-SW: 1`, forces `credentials: 'include'`), redeems a token only on 401. Single-flight renewal and top-up promises coalesce request herds so one drain costs exactly one token. Proactive top-up (`POST /pp/refill`) exists because video/audio range requests bypass service workers entirely and can't self-renew.
  - `client/activate.ts` + `client/pp-worker.ts` — activation page: blind-RSA blinding/unblinding fanned across Web Workers, batch POSTed to `/pp/issue`, finished tokens stored in IndexedDB (`pp-tokens`, shared with the SW).

## Invariants to preserve

- **Issue-then-consume ordering** in `/pp/issue`: validate the code, sign, and only then atomically decrement its balance (guarded `UPDATE … WHERE drawn + batch <= quota`, `.changes === 1`) — a signing failure must never decrement, and concurrent draws must never over-issue a code's balance (draws that fit both succeed; an overdrawing loser gets 409). Codes are balances drawn in `PP_TOKENS_PER_DRAW`-capped batches (a client default via `/pp/issue-info`, deliberately NOT a server cap); the activation page remembers the code (`localStorage.pp_code`) and silently re-draws on the SW's `refill=`/`exhausted=` redirects.
- **Privacy:** never log or persist anything linking invite codes to blinded values, tokens, IPs, or user agents. The spent-set stores only token hashes. Purchases may link a BTCPay invoice to a code (delivery requires it; swept after `PP_PURCHASE_RETENTION_MS`) but a minted code must never appear in logs or BTCPay metadata.
- **Exactly-once purchase fulfillment:** all settlement paths (webhook, claim-status reconciliation) must go through `settleIfPending` → `store.settlePurchase`, whose `status='pending'` guard makes redeliveries/races no-ops. The webhook route must stay mounted *before* the global `express.json` middleware — its HMAC is computed over the raw body.
- **Metering classes must stay in sync** across three places: the nginx static-exemption regex, the SW's `STATIC_RE`, and the class regexes in `server.ts` (`STREAM_*_RE` → `PP_POINTS_PER_STREAM_REQUEST`, `MEDIA_*_RE` → `PP_POINTS_PER_MEDIA_REQUEST`, else default; derived from `X-Original-URI`). Non-media static is exempt; images meter through the SW; video/audio bypass the SW and ride the pre-funded session. The optional `PP_POINTS_PER_MIB` size component (from `X-PP-Range` / `range=`/`clen=` in the URI) must stay **additive** to the class cost — never a replacement — so a forged size hint can't undercut the flat price.
- `/pp/config`, `/pp/points`, `/pp/token-key` must stay `Cache-Control: no-store` — the SW and status page compute balances from them.
- Only GET is gated, by design (read-only frontends).
- The SW is served with `Service-Worker-Allowed: /` because it lives under `/pp/` but must control the whole origin.

## Docs

`README.md` documents *this* deployment (metering design, faucet codes, bypass password, media handling, nginx gotchas) and `INSTALL.md` is the generic guide for gating any nginx-fronted service — both are detailed and current; update them when changing behavior they describe. nginx config itself lives outside this repo (`../nginx/nginx.conf`).
