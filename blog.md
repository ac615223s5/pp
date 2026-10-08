# Gating a website with anonymous tokens: designing a self-hosted Privacy Pass service


I run a handful of websites and online services. Like everyone else hosting these,
I had a growing bot problem: scrapers hammering the instances, burning bandwidth and
causing outages. The standard fixes all betray the point of running
privacy frontends in the first place: accounts identify users, CAPTCHAs
fingerprint them, IP rate-limiting logs them and falls over against
thousand-IP botnets anyway.

So the design brief was almost a contradiction: **meter every request, without
being able to attribute any request to anyone.** This post explains how the
IETF Privacy Pass protocol makes that possible, the layered accounting model
the service ended up with, and the problems that showed up on the way —
most of which were not cryptographic at all.

## The idea: blind-signed tokens

Privacy Pass (RFC 9578, Type 2: Blind RSA, 2048-bit) splits access control
into two events that are cryptographically unlinkable:

- **Issuance** — the user proves entitlement (here: an operator-issued invite
  code) and presents a batch of *blinded* token values. The server signs them
  without ever seeing the real values. This step is authenticated and
  linkable: the server knows *which code* drew tokens, and when.
- **Redemption** — the browser unblinds a signature and spends the token. The
  server can verify its own signature is valid, but the unblinded token is
  mathematically uncorrelatable with anything it saw at issuance.

The same Node/TypeScript container plays issuer and verifier (there's no
third-party attester — one operator, one keypair). Replay is stopped not by
challenge binding but by storing a list of spent tokens. Notably, the blindness
itself requires no trust in the server: it is client-side math, and an issuer
that logs every blinded value, code, and timestamp gains nothing — no
redeemed token can be matched to any issuance record.

On the browser side there is no extension and no account. An activation page
does the blinding/unblinding (fanned out across Web Workers) and stores
finished tokens in IndexedDB; a service worker spends them invisibly from
then on. nginx enforces the gate with `auth_request`: every dynamic request
on a gated host is sub-requested to the verifier, which answers 204 (pass) or
401 (challenge).

## The hierarchy: codes → draws → tokens → sessions → points → requests

The accounting model grew into five layers. Each exists to fix a specific
tension between metering granularity, performance, and anonymity — top-down:

**Invite codes** are the operator-facing unit and the only thing a user ever
handles. A code is a *balance* of N tokens (say 500), created by an admin CLI,
handed out manually or sold for crypto via BTCPay. Codes come in two flavors:
fixed balances, and "faucet" codes that accrue tokens daily up to a cap — a
standing grant for a trusted user that never becomes an unlimited pass. Codes
can be revoked (stopping future draws — already-issued tokens are unlinkable
and thus unrevocable, by design) and merged (folding one code's remainder into
another, so a user keeps a single code in their password manager forever).

**Token batches (draws)** are how a code turns into tokens. An activation
draws `min(remaining, PP_TOKENS_PER_DRAW)` — 50 by default — not the whole
balance. The same code therefore works across several devices and sites until
it runs dry, and the client remembers it (localStorage) to re-draw silently
when the device runs low. Crucially, **draw size is an anonymity parameter**,
not just UX: issuance is the linkable event, redemption the anonymous one, and
what keeps them apart in practice is *time*. Drawing tens of tokens ahead of
need decorrelates the two. If draws were one token at a time, every redemption
would be preceded moments earlier by an authenticated draw from some specific
code — the operator could link them by timing alone, no cryptography broken.

**Tokens** are the cryptographic bearer credentials — unlinkable, spendable
exactly once, living in the device's IndexedDB pool. They can be exported and
imported between devices as text (they're bearer instruments; whoever holds
them can spend them).

**Sessions** are why browsing doesn't cost a token per request. Redeeming one
token opens a server-side session — a random id in a cookie, never derived
from the token — pre-loaded with `PP_POINTS_PER_TOKEN` points. Requests
within a session are mutually linkable through the cookie; that is the one
privacy trade-off the design makes deliberately, and it's tunable: set the
session to one request's worth and you're back to maximum anonymity at
maximum cost.

**Points** are the atomic metering currency, and **requests** draw them. Not
all requests are equal: a dynamic page request costs the full rate (default
1,000 points), an image costs a tenth of that, a video segment costs a small
flat floor *plus* a per-MiB component derived from the byte range it asks
for. When a session can't cover a request, the verifier answers 401 and the
service worker spends the next token.

Multiplied out with the defaults: one 500-token code ≈ ten draws of 50 ≈
50k page requests ≈ 50M points — while each individual layer stays small enough
that exhausting it (a session draining, a device running out of tokens, a
draw depleting) is a routine, invisibly-handled event rather than a cliff.

### Sizing each layer

Every ratio between adjacent layers is a knob, and each one trades the same
two things: convenience when it's bigger against blast radius when something
below it is lost. These tensions are also what justify the layers' existence
in the first place: a layer earns its place exactly when the ratio to its
neighbor pulls both ways — if one direction were always better, there would
be nothing to tune, and the boundary would collapse into the layer next to
it.

**Draws per purchase** (code size ÷ draw size). Bigger codes mean less
frequent purchases — less annoyance, and fewer crypto transaction fees per
token bought. Smaller codes mean less commitment: less value stranded if the
service shuts down, the key rotates, or you simply stop using it.

**Tokens per draw.** Higher is more anonymous — more sessions come out of
each draw, so the linkable issuance events sit further apart in time from the
anonymous redemptions. Lower limits the loss when a pool dies with its
device: tokens are bearer instruments living in one browser's IndexedDB, so
whatever sits undrawn on an unused machine — or gets wiped with site data —
is gone, while the balance still on the *code* is not.

**Requests per session/token** (points per token ÷ points per request).
Higher keeps long videos alive: the prefunded session is what playback rides
while the service worker is asleep, so a bigger buffer means less chance of a
stream stalling. Higher is also cheaper overhead per request served — tokens
aren't free: each one costs client-side blind-RSA work to mint (a browser
manages on the order of a hundred per second, fanned across Web Workers) and
a few hundred bytes of IndexedDB and issuance-request payload, so packing
more requests into each token means fewer tokens to generate, ship, and
store for the same amount of browsing. Lower means shorter-lived sessions —
fewer requests linkable to each other through one cookie, and less value
lost when a session expires or is cleared.

**Points per request.** The one ratio with no real tension — it's the
resolution of the currency, not a price. Set it high enough that the full
range of request classes (full page, cheap image, streaming floor, per-MiB
increments) all land on comfortable integers, and forget about it. 

## Challenges, in the order they hit

### Blind-signing was 350× too slow

The `@cloudflare/privacypass-ts` library's `blindSign` is pure JS: ~350ms per
token. A 500-token draw would take minutes of server CPU. But RSABSSA
blind-signing is, on the wire, just a raw RSA private-key operation — so the
service bypasses the library for issuance and calls `node:crypto`'s
`privateDecrypt` with `RSA_NO_PADDING`: ~1ms per token, byte-identical
output. Verification still goes through the library. Client-side, blinding is
the slow half, so the activation page fans it across Web Workers. Big
activations went from "minutes, maybe" to seconds.

### Time windows reward bots — sessions became points-metered

The original plan was a classic session window: redeem a
token, browse free for 15 minutes. But a time window is exactly what a
scraper wants — it amortizes: one token, then unlimited parallel fetches
until expiry. Two days into the project the window was replaced with the
points balance. Cost is now *linear in requests* no matter how they're
scheduled. A human reading pages barely notices a 2,000-request balance; a
bot pulling 100,000 pages pays for 100,000 pages.

### Media files: video bypasses the service worker

Gating media created the hardest client-side problem in the project.
`<video>`/`<audio>` range requests **do not pass through the service worker**
(verified empirically — they arrive with no SW marking and no token), so the
worker's usual trick — catch the 401, spend a token, retry — can't work.
Worse, browsers kill idle service workers after a few minutes, so during a
long video the component responsible for paying is *asleep*.

The solution funds the session *ahead of demand* instead of reactively: nginx
reflects the live session balance to the browser in an `X-PP-Points` response
header on every gated response; whenever the SW sees any request come back
with a balance under a threshold, it spends one token on a `POST /pp/refill`
that *adds* to the running session rather than replacing it. The per-token
buffer is sized to cover minutes of playback with the SW dead. The threshold
is overridable per hostname, so a video-heavy host can bank a multi-token
session while other hosts keep the smaller, more private default — the
override pre-pays more, it never makes tokens cheaper, so there's nothing to
arbitrage.

### Pricing bandwidth without trusting the client

Flat per-request pricing makes a 4K segment cost the same as a thumbnail. The
gate can't see response sizes (it runs *before* the proxied request), but
bandwidth-heavy requests *declare* what they want: media elements send a
`Range` header, and video-CDN-style URLs carry `range=`/`clen=` parameters. So
streaming pays its flat floor **plus** points per MiB requested. The
critical property is that the size component is *additive*, never a
replacement: a forged tiny `Range` can't price a request below its class
cost, and a client can't understate the span, because the range is what the
upstream actually serves back. (An earlier iteration let nginx assert
per-request cost via an `X-PP-Cost` header; it was replaced with server-side
classification from the URI — fewer moving parts to trust.)

### Herds, races, and one-token boundaries

A page load fires dozens of requests at once. If the session drains
mid-load, several of them 401 simultaneously — and a naive worker would spend
several tokens. Everything that spends is therefore *single-flight*: renewal
and top-up are coalesced promises, so one drain costs exactly one token. The
same discipline shows up server-side as single-statement atomicity in SQLite:
spend/top-up is one `UPDATE … RETURNING`, the spent-set is one guarded
insert, and a draw is one `UPDATE … WHERE drawn + batch <= quota` — two
devices racing a code's last tokens can both win only if both fit; an
overdraw loses cleanly with a 409. A subtler leak: fetches made without
credentials skipped the session cookie and each burned a fresh token; the SW
now forces `credentials: 'include'` on everything it meters.

### Running out gracefully

Exhaustion is a UX problem in three acts. A **refill buffer** steers new
navigations to the activation page while the pool still has a few tokens, so
in-flight page loads finish from the reserve. **Silent top-up** means the
activation page usually never renders: it re-draws from the remembered code
and bounces straight back to a validated same-origin `return=` path — the
user sees a blink. And true **exhaustion** redirects navigations (and walks
sub-resource failures up to their owning tab) to a real page rather than
leaving a broken skeleton. A sessionStorage timestamp breaks any redirect
loop if the silent path itself fails.

### One code everywhere, instead of a browser extension

The largest late redesign started from a complaint that had nothing to do
with cryptography: *entering codes for every site and every device is
tedious.* The obvious answer — a browser extension that syncs tokens — turned
out to be the wrong one: spending is destructive, so synced token pools need
distributed coordination (splitting and rebalancing across devices); vendor
sync channels transit bearer credentials; and a multi-issuer extension
invites token-harvesting by malicious pages unless issuers are pinned.

The right answer was to sync the *code*, not the tokens — which is what
turned codes from single-use into balances with partial draws (the hierarchy
above is the post-redesign shape). The activation form was then rebuilt as a
real HTML form with a `type="password"` code field and `autocomplete`
attributes, so an ordinary password manager becomes the cross-device
transport: save the code once, autofill it on every device, and the silent
re-draw does the rest. Code merging closes the loop — buy a new code later,
fold it into the saved one, and the password-manager entry stays valid
forever (merging even revives an exhausted code).

### Selling codes without linking payments to browsing

BTCPay Server integration lets users buy codes with crypto (Monero fits the
project's goals better than transparent-chain BTC). Two invariants carry the
design: fulfillment is *exactly-once* — webhook deliveries and status-poll
reconciliation all funnel through a single pending-only guarded transaction,
so redeliveries and races can't double-mint — and the purchase record linking
invoice to code (unavoidable: delivery requires it) is swept after a
retention window. The operator can know *who bought a code*, but blind
issuance means never *what it's used for*.

## What it doesn't protect against

Honest limits, documented from day one: with a small user base, IP and timing
correlation can erode anonymity regardless of the cryptography — the
anonymity set grows with users. Requests inside one session are linkable to
each other by construction. Tokens are bearer credentials: exportable,
shareable, unrevocable once issued. And there is a single key epoch —
rotating the keypair invalidates every outstanding token (and the operator's
bypass cookies, whose HMAC secret derives from the same key).

The useful way to slice these limits is by who has to be trusted. **What the
client guarantees unilaterally**, with nothing more than an unmodified
service worker: the operator cannot tell which code — which person, which
payment — any request belongs to. Blinding is client-side math; hostile
logging doesn't touch it. The two assumptions behind that are both checkable
from the client's end. First, that everyone is issued under the *same* key —
the activation page displays the issuer key's SHA-256 fingerprint (RFC
9578's `token_key_id`) without requiring a code, so users can compare it
across devices and with each other; a per-user key would let the operator
partition redemptions, and the fingerprint makes that detectable. Second,
that draws are sized ahead of need — the client generates the batch itself,
so it always knows exactly how many tokens it drew and when. **What no
client can fix**: the operator sees an IP on every request — with or without
tokens, exactly as any website does — so network-layer anonymity takes Tor
or a VPN here as it does anywhere else; and the anonymity set is only ever
as large as the user base.

## Takeaways

The cryptography was the easy part — the library existed, and the one
performance wall had a three-line fix. Nearly everything hard lived in the
seams: what a service worker cannot see, what nginx cannot express, what a
scraper will find if you exempt it, and what users will not tolerate typing
twice. The layered hierarchy is what let each of those problems be solved
where it was cheapest — points absorb per-request economics, sessions absorb
performance, tokens absorb anonymity, draws absorb timing correlation, and
codes absorb distribution — without any layer having to know much about the
others.