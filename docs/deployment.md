# Deploying the web wallet — static hosting, headers, the artifacts (Privacy Wallet Web spec §20)

The wallet is a static build (`cd apps/web && npm run build` → `apps/web/dist`): HTML, JavaScript, CSS, the WASM of the
Rust core, the circuit artifacts and the pin file. It needs no server-side code. What a host must do is serve the
files with the right headers, fall back to `index.html` for the client-side routes, and serve nothing else. The
wallet makes requests only to the hosts the build was configured with (`VITE_*`, see `apps/web/.env.example`); the
content security policy below names them and refuses every other destination.

## The policy and the headers

`apps/web/scripts/csp.mjs` builds the policy from the build's environment and writes it into `dist/index.html` as a
`<meta http-equiv="Content-Security-Policy">` (the first tag of `<head>`), so a host that cannot set headers still
ships it. A host that can set headers sends the same policy as a header (a header reaches the browser before any
byte of the page) plus `frame-ancestors 'none'`, which a meta tag cannot carry. `npm run preview` sends every
header below (`vite.config.ts` → `preview.headers`). The policy of a build:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' <the hosts of the build>;
img-src 'self' data: blob:; frame-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self';
base-uri 'none'; form-action 'none'; object-src 'none'; upgrade-insecure-requests
```

- `'wasm-unsafe-eval'`: snarkjs (the prover) and the Rust core run as WebAssembly; no `'unsafe-eval'`, no inline script.
- `worker-src 'self' blob:`: the prover runs in a same-origin module worker.
- `connect-src`: the RPC endpoints, the relayers, the swap service, the beacon APIs, the THORNode gateways, an artifact host
  when `VITE_ARTIFACT_BASE` is absolute, WalletConnect's relay only when `VITE_WC_PROJECT_ID` is set — by exact host (its four
  relay origins), never a wildcard (the review round of 2026-11-02: `*.walletconnect.org` had let the telemetry host and the
  provider's RPC host through while the docs read "never"); WalletConnect's telemetry host (`pulse`), its push host (`echo`) and
  its RPC host (`rpc`) are never allowed, and `apps/web/test/csp.test.ts` matches them against every source as a browser would
  —, and the zkAPI profile's pinned hosts when the zkAPI assets were built. Nothing else: no analytics, no error reporting, no
  font or style host. The wallet reads the chain through its own endpoints; a method WalletConnect's provider would route to its
  RPC host fails under the policy instead of leaking.
- `img-src data: blob:`: the icons wallets announce through EIP-6963 arrive as data URIs; the QR codes — Receive's, a
  WalletConnect pairing's — are inline SVG.
- `frame-src 'none'`: no frame — with a WalletConnect project id (V7 Stage 16, spec v3.0 §9) the verify iframe's two hosts.
  WalletConnect's own modal is not used (the eleventh review round, slice 6c): it writes its styles
  as `<style>` elements, which `style-src 'self'` refuses — under the policy it took no tap — so the wallet's own sheet shows
  the pairing, and the modal's hosts (`api.web3modal.org`, `api.web3modal.com`, `explorer-api.walletconnect.com`) are not
  allowed. `apps/web/scripts/csp.mjs` builds all of it.
- `style-src-attr 'unsafe-inline'`: the design system sets no inline styles; a few V1.1–V4 components still mounted do.

The headers (`SECURITY_HEADERS` in `csp.mjs`):

| header | value | why |
|---|---|---|
| `Content-Security-Policy` | the policy above + `; frame-ancestors 'none'` | the page cannot be framed (clickjacking); every destination named |
| `X-Frame-Options` | `DENY` | older browsers |
| `X-Content-Type-Options` | `nosniff` | WASM and JSON are served as what they are |
| `Referrer-Policy` | `no-referrer` | no URL of the wallet reaches another host |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` | nothing the wallet needs |
| `Cross-Origin-Opener-Policy` | `same-origin` | no window reference from another origin |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | HTTPS only |
| `Cache-Control` | `no-store` for `index.html` (the hashed assets may be cached for a year) | a new build is seen at once |

## nginx

nginx sends a level's `add_header` lines only when that level sets none of its own: a `location` that adds
`Cache-Control` drops every header of the `server` block. The wallet page, reached through `try_files` and the internal
redirect to `/index.html`, and every file under `/assets/` set their own, so the headers live in one file that the
`server` block and each such `location` include (audit round 2, r51: the recipe had served the page with no
frame-ancestors and no X-Frame-Options — any site could frame it — and the crypto worker with no policy at all).

```nginx
# /etc/nginx/snippets/privacy-wallet-headers.conf: every response of the wallet sends these
add_header Content-Security-Policy $csp always;
add_header X-Frame-Options DENY always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```

```nginx
server {
  listen 443 ssl http2;
  server_name wallet.example;
  root /srv/privacy-wallet/dist;
  # the policy of this build is in dist/index.html's meta tag; repeat it here and add frame-ancestors
  set $csp "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer.example https://swap.example; img-src 'self' data: blob:; frame-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
  include snippets/privacy-wallet-headers.conf;
  types { application/wasm wasm; application/manifest+json webmanifest; }
  location = /index.html { include snippets/privacy-wallet-headers.conf; add_header Cache-Control "no-store" always; }
  location /assets/ { include snippets/privacy-wallet-headers.conf; add_header Cache-Control "public, max-age=31536000, immutable" always; }
  location /artifacts/ { include snippets/privacy-wallet-headers.conf; add_header Cache-Control "public, max-age=31536000, immutable" always; }   # the 31 MB proving key: cached, pinned
  location / { try_files $uri /index.html; }   # the client-side routes (/send, /privacy, /settings, …): the server's headers
  # Private AI only (a build with the zkAPI assets): the SDK reads its deployment manifest behind this same-origin rewrite. A third
  # party's server must never answer as a document of the wallet's origin (the fourth review round, 2026-11-03: a reverse proxy had
  # served any of its answers, HTML included, as the wallet itself — a script in it would have run as 'self'): the upstream's
  # certificate is verified, its answer is served as JSON whatever it says, under a policy that lets nothing in it run and puts any
  # document from it in an opaque origin. A build without the zkAPI assets drops this block.
  location /zkapi-deployment/ {
    proxy_pass https://zkapi-sepolia.openanonymity.ai/;
    proxy_ssl_server_name on;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_hide_header Content-Type;
    proxy_hide_header Content-Security-Policy;
    proxy_hide_header Set-Cookie;
    include snippets/privacy-wallet-headers.conf;      # a location with headers of its own sends the server's again (r51)
    include snippets/zkapi-deployment-headers.conf;    # and the record's own: JSON whatever the upstream says, sandboxed, uncached
  }
  # V7 (spec v3.0 §7.8): Tornado Classic — another application with its own build and policy, under its own location (the snippets below)
  location /classic/ { include snippets/tornado-classic.conf; }
}
```

```nginx
# /etc/nginx/snippets/zkapi-deployment-headers.conf: the proxied deployment record is data, never a document (the fourth review round, 2026-11-03)
add_header Content-Type application/json always;
add_header Content-Security-Policy "default-src 'none'; sandbox" always;
add_header X-Content-Type-Options nosniff always;
add_header Cache-Control "no-store" always;
```

```nginx
# /etc/nginx/snippets/tornado-classic-headers.conf: every response of the Classic application sends these — its own policy,
# the same hardening (copy the policy from classic/dist/index.html's meta tag at every build, as for the wallet)
set $csp_classic "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer-a.example https://relayer-b.example; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
add_header Content-Security-Policy $csp_classic always;
add_header X-Frame-Options DENY always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
```

```nginx
# /etc/nginx/snippets/tornado-classic.conf: the body of `location /classic/` — the separate build at classic/dist
alias /srv/tornado-classic/dist/;
include snippets/tornado-classic-headers.conf;
add_header Cache-Control "no-store" always;
try_files $uri $uri/ /classic/index.html;   # the tabs as URLs (/classic/withdraw, /classic/history, /classic/settings)
# the hashed assets, the 42 MB of proving artifacts and the history snapshots: immutable, pinned by hash in the application
location ~ ^/classic/(?<dir>assets|artifacts|data)/(?<rest>.*)$ {
  alias /srv/tornado-classic/dist/$dir/$rest;
  include snippets/tornado-classic-headers.conf;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
}
```

**Prefer its own origin (the fourth review round, 2026-11-03).** Under `/classic/` the Classic application runs as the wallet's
origin: in the browser it shares the wallet's IndexedDB, localStorage, Cache storage, BroadcastChannel and Web Lock — rule 9 keeps
the two source trees apart, the browser does not. A script that runs inside Classic (its own threat model names the host as the
residual) could overwrite the wallet's two ciphertext blobs, hold the wallet's lock so no wallet tab opens, or lock the wallet's
tab at will. Serve it from a `classic.` host of its own and point the wallet's More entry at it (`VITE_CLASSIC_URL=https://classic.<your host>/`);
the same-origin location above is the development recipe (the local stack's), and a host that keeps it accepts that residual
(audit gap 68).

The Classic application (`classic/`, GPL-3.0; spec v3.0 §7.8) is built apart (`cd classic && npm ci && npm run build`; its
`VITE_CLASSIC_*` environment names the RPC endpoints, extra relayers, where the snapshots and the artifacts are served, and
which pool functions are live — none, until `classic/docs/release-gate.md` and the owner's `classic/docs/legal-review.md`
say so). Its policy is its own (`classic/scripts/csp.mjs`; the curated relayers' hosts from `classic/relayers.json` join
`connect-src`), written into `classic/dist/index.html` and repeated by the server from `snippets/tornado-classic-headers.conf`. Copy the
policy from the built `index.html` into that snippet's `$csp_classic` at every build, as for the wallet. The artifacts (`classic/public/artifacts/`, 42 MB) and the
history snapshots (`npm run snapshot -- --pool <id>`, under `classic/public/data/`) are static files under the same
location, pinned by hash in the application (an artifact that does not hash to its pin is refused; a snapshot is held to its
manifest and to the chain). The stricter hosting option — a `classic.` subdomain, so the two applications share no storage
at all — needs only its own `server` block with the same headers; the wallet's More link then points at it
(`apps/web/src/features/more/entries.ts`). `npm run preview` in `classic/` answers with these headers, policy included.

Before a release, check that the headers reach every kind of response — the page, a client route and the crypto
worker, which takes its policy from its own response, never from the page's meta tag:

```sh
for p in / /send "/assets/$(ls dist/assets | grep -m1 '^worker-')"; do
  curl -sI "https://wallet.example$p" | grep -ci -E '^(content-security-policy|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|cross-origin-opener-policy|strict-transport-security):'
done   # 7 for each
```

## Caddy

```caddyfile
wallet.example {
  root * /srv/privacy-wallet/dist
  encode zstd gzip
  header {
    Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer.example https://swap.example; img-src 'self' data: blob:; frame-src 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
    X-Frame-Options DENY
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    Cross-Origin-Opener-Policy same-origin
    Strict-Transport-Security "max-age=63072000; includeSubDomains"
  }
  @index path /index.html /
  header @index Cache-Control no-store
  header /assets/* Cache-Control "public, max-age=31536000, immutable"
  header /artifacts/* Cache-Control "public, max-age=31536000, immutable"
  # V7: Tornado Classic under /classic/ — its own build and policy (classic/scripts/csp.mjs; copy it from classic/dist/index.html)
  handle /classic/* {
    root * /srv/tornado-classic
    header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer-a.example; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"
    header Cache-Control no-store
    header /classic/assets/* Cache-Control "public, max-age=31536000, immutable"
    header /classic/artifacts/* Cache-Control "public, max-age=31536000, immutable"
    header /classic/data/* Cache-Control "public, max-age=31536000, immutable"
    uri strip_prefix /classic
    try_files {path} /dist/index.html
    file_server { root /srv/tornado-classic/dist }
  }
  # Private AI only (a build with the zkAPI assets): the SDK reads its deployment manifest behind this same-origin rewrite — served
  # as JSON under a policy that lets nothing in it run, whatever the upstream answers (the fourth review round, 2026-11-03; Caddy
  # verifies the upstream's certificate by default). A build without the zkAPI assets drops this block.
  handle_path /zkapi-deployment/* {
    reverse_proxy https://zkapi-sepolia.openanonymity.ai {
      header_up Host {upstream_hostport}
      header_down -Content-Type
      header_down -Content-Security-Policy
      header_down -Set-Cookie
      header_down Content-Type application/json
      header_down Content-Security-Policy "default-src 'none'; sandbox"
      header_down X-Content-Type-Options nosniff
      header_down Cache-Control no-store
    }
  }
  try_files {path} /index.html
  file_server
}
```

## The chunks

V6 Stage 16 (spec v2.0 §19): the first route carries the onboarding screens only. The shell, every screen behind the
gate, the crypto worker's client, the prover and the Korean catalog are separate chunks under `/assets/`. A chunk loads
when its route matches, at the first proof, or when the locale is Korean (before the first render). Nothing changes for
a host: they are hashed files under the same policy, cached like the rest of `/assets/`. `node scripts/check-budget.mjs`
reads the build's Vite manifest (`dist/.vite/manifest.json`). It requires the first route to stay within 250 KB of
gzipped JavaScript and Home within 80 KB more, with no snarkjs and no WASM before they are needed. The manifest is a build
record; serving it is harmless, but a host may leave `/.vite/` out.

## The artifacts and their pins

- `/artifacts/transaction.wasm`, `/artifacts/transaction_final.zkey`, `/artifacts/verification_key.json`: copy them from
  `circuits/build` and `circuits/setup/<ceremony>` into `dist/artifacts/` (or serve them from `VITE_ARTIFACT_BASE`, which
  then belongs in `connect-src`). The dev setup's key is the insecure single-party one; a production build ships the
  ceremony's.
- `/core/privacy_core_wasm.js`, `/core/privacy_core_wasm_bg.wasm`: `npm run core:assets` copies the Rust core's package
  into `public/core` before the build; without it the wallet runs the TypeScript reference.
- `/artifacts.json`: the pins (`node scripts/pin-artifacts.mjs`; `docs/build-hashes.md` records them). The crypto worker
  hashes the proving key and the witness generator it fetched and refuses a mismatch in a production build; a build
  without a pin file refuses to prove in production. V6 Stage 15: the worker keeps both in the browser's Cache API
  (`privacy-wallet-artifacts-v1`) under their pinned SHA-256 and hashes them again on every read. An entry that no
  longer matches is dropped and fetched again, a new pin replaces the old entry, and an unpinned artifact is never
  cached, so the 31 MB key is downloaded once per device and per ceremony, not once per proof. `node scripts/check-artifact-pins.mjs` checks the pins against
  the files on the build machine and, when `dist/` exists, that `index.html` carries the policy and ships the pin file.
- `/zkapi/*` (Private AI): `npm run zkapi:assets` and `npm run zkapi:pins` (docs/zkapi-integration-spec.md). The SDK
  reads its deployment behind the same-origin rewrite `/zkapi-deployment/`, to the pinned protocol server of the network
  the assets were built for (`https://zkapi-sepolia.openanonymity.ai` or `https://zkapi-mainnet.openanonymity.ai`, as the
  dev server proxies it): the `location` and `handle_path` blocks above. Without it the client-route fallback answered the
  SDK with `index.html` (audit round 2, n76).

## The API and the relayer

Both services send the same headers on every answer, from `packages/server-kit/src/http.ts`:

- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`;
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, since they serve JSON only;
- `Strict-Transport-Security` when the service terminates TLS itself (`TLS=1`).

Their configuration: `apps/api/.env.example` (and the engine's, `packages/swap-engine/.env.example`) and
`apps/relayer/.env.example`. Every number in it is read strictly (`packages/server-kit/src/env.ts`): one that is not a
whole number in its range stops the service at start, naming the setting. Their CORS headers go to the origins in `ALLOWED_ORIGINS` only. Both rate-limit per caller
(`RATE_PER_MINUTE`), and the address is never logged. The API bounds what it stores too (the eighth review round, 2026-11-03):
`COMMITS_PER_MINUTE` (default 4, a burst of 30) operations a caller may create a minute, commits and restores alike, and
`MAX_OPEN_OPERATIONS` (default 50,000) operations not yet ended; past either it answers 429 or 503. By default the caller is the socket's address and no proxy header
is read. `TRUST_PROXY_HOPS` names how many proxies in front of the service append to `X-Forwarded-For`; the caller is
then the entry the outermost of them wrote, so what a client writes there itself buys nothing. A request with fewer
entries keeps its socket's address. A POST that is not JSON answers 415. The API's `EXPOSURE_POLICY_FILE` (V7 Stage 13, spec v3.0 §4)
names a JSON object keyed by value tier whose rows replace the compiled exposure-policy table
(`packages/protocol/src/wallet/exposurePolicy.ts`) field by field (`word`, `capBps`, `range`, `activation`); a malformed file
stops the start, naming the field. Unset, the compiled defaults apply.
The relayer's edge is `apps/relayer/src/edge.ts` (`apps/relayer/test/edge.test.ts`), the API's `apps/api/src/app.ts`.

Behind a TLS proxy, leave `TLS` unset and let the proxy send HSTS, and set `TRUST_PROXY_HOPS` to the number of proxies
(1 for one). Without it every caller shares the proxy's address and so one bucket, which a single client can use up
for everyone (a V6 follow-up of 2026-10-15). Set it only when the service cannot be reached past those proxies.

The relayer runs only the swaps the swap service vouched for (a V6 follow-up of 2026-10-16, `docs/audit-package.md`
gap 47). Generate a secp256k1 key for the API and keep it with its secrets as `API_VOUCH_KEY` (32 bytes of hex; it
signs nothing else and is never logged). Give each relayer its address as `API_VOUCHER`, which `GET /v1/status` names
(`deployment.voucher`), together with `SWAP_FACTORY`: without both, a relayer runs no swaps. Before the API runs with a
key, `npm run voucher-address -w @privacy-wallet/api` prints that address from the `API_VOUCH_KEY` in its environment
(never the key). Give the API the
deployment's `SHIELD_FACTORY` too, so it can vouch for the shield receipts of swaps into the protected balance; without
it such a commit is refused. A wallet reads its relayer's `GET /info` before it funds a swap, and stops the swap unfunded
(`relayer_not_ready`) when that relayer names another swap factory, its list but no swap factory (it has no
`SWAP_FACTORY`, so it runs no swaps), or a list without the swap service's address.

To rotate the key (a V6 follow-up of 2026-10-16), give the relayers `API_VOUCHER=<new>,<old>` first, the new address
printed by `npm run voucher-address` from the new key. Each relayer's `GET /info` lists the addresses it runs for
(`vouchers`) and its `swapFactory`: check that every relayer lists both before going on. Then restart the
API with the new `API_VOUCH_KEY` and `API_VOUCHER_PREVIOUS=<old>`. From then on the API signs every vouch with the new
key, and its finalize still honors the old key's commit vouches. The relayers accept both, and `GET /v1/status` names
the honored former addresses (`deployment.previousVouchers`) and says whether the relayer the API reads lists the new
one (`deployment.relayerAcceptsVoucher`). The API needs the old address only until the last order
committed under it is past its `executeDeadline`: the wallet signs no call after it, and none could run. The relayers need
it until every such order is executed or refunded: a refund-only job and a shield job carry the vouch from the order's
commit, and a wallet may ask for a refund at any time until the escrow is refunded. Jobs a relayer has already admitted
run on either way. Once the old address is dropped, a wallet that comes back to an unrefunded order of the old key is
refused (`unvouched_order`). The escrow's refund stays open to anyone after `refundAfter` (the factory's
`deployAndRefund`, which pays the order's tip to the caller). A key that leaked is rotated without the overlap: list
its address neither on the relayers nor in `API_VOUCHER_PREVIOUS`. Listed on a relayer, it runs whatever its holder
vouches for. In `API_VOUCHER_PREVIOUS`, its holder gets the new key's vouch for the call of any order it vouched for, a
rebuilt one included. The orders committed under it then refund through the jobs the relayers already hold, or
through anyone's `deployAndRefund`; a wallet stops one it has not funded yet (`service_key_changed`), so no more funds
reach an order whose vouches nobody takes any longer.

The relayer's job lists (`GET /swap`, `GET /jobs`) are operator data: they answer only with `RELAYER_ADMIN_TOKEN` as a
bearer token, and are closed when it is unset; a token shorter than 32 characters stops the relayer at start (the fourth
review round, 2026-11-03 — a short token was guessable from the open internet, and the lists hold every job's words). The relayer answers `GET /jobs/by-nullifier/<nullifier>` with the job's transaction hash and status only. That is how a
wallet whose answer was lost (the network dropped mid-submission) finds its submission again instead of sending it
twice (spec v2.0 §7.11).

## What the host never sees

No request of the wallet carries a seed, a phrase, a spending or viewing key, a note secret or the keystore; the
privacy leakage suite (`apps/web/test/privacy-leakage.test.tsx`, verify-all's "apps/web privacy leakage" step)
drives the create → protect → send flows and the swap scenario and reads every request body. The host serves files;
the balance, the notes and the journal live encrypted in the browser's IndexedDB (`docs/wallet-formats.md`).

## Checks before a release

1. `node scripts/verify-all.mjs` (every suite, the lint, the leakage gate, the artifact pins, the dependency audit, the
   build, the bundle scan — `node scripts/scan-bundle.mjs` refuses a tracker SDK or host, a source map and a test seed in
   `dist/` — and the performance budget, `node scripts/check-budget.mjs`); with `--browser`, the screenshots against the
   reviewed baselines and the accessibility passes in Chrome.
2. `cd apps/web && npm run build && npm run preview`, open the preview: the console shows no CSP violation on first
   launch, Protect, Send, Swap, the Privacy Center.
3. `node scripts/check-artifact-pins.mjs` on the build machine; `docs/build-hashes.md --dist` for the record.
4. The local stack's browser run (`docs/local-run.md`) against the build when the services are reachable.
