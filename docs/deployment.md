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
img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self';
base-uri 'none'; form-action 'none'; object-src 'none'; upgrade-insecure-requests
```

- `'wasm-unsafe-eval'`: snarkjs (the prover) and the Rust core run as WebAssembly; no `'unsafe-eval'`, no inline script.
- `worker-src 'self' blob:`: the prover runs in a same-origin module worker.
- `connect-src`: the RPC endpoints, the relayers, the swap service, the beacon APIs, the THORNode gateways, an artifact host
  when `VITE_ARTIFACT_BASE` is absolute, WalletConnect's relay only when `VITE_WC_PROJECT_ID` is set, and the zkAPI
  profile's pinned hosts when the zkAPI assets were built. Nothing else: no analytics, no error reporting, no font or
  style host.
- `img-src data: blob:`: the icons wallets announce through EIP-6963 arrive as data URIs; the QR of Receive is inline SVG.
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

```nginx
server {
  listen 443 ssl http2;
  server_name wallet.example;
  root /srv/privacy-wallet/dist;
  # the policy of this build is in dist/index.html's meta tag; repeat it here and add frame-ancestors
  set $csp "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer.example https://swap.example; img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
  add_header Content-Security-Policy $csp always;
  add_header X-Frame-Options DENY always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  types { application/wasm wasm; application/manifest+json webmanifest; }
  location = /index.html { add_header Cache-Control "no-store" always; }
  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }
  location /artifacts/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }   # the 31 MB proving key: cached, pinned
  location / { try_files $uri /index.html; }   # the client-side routes (/send, /more/privacy, …)
}
```

## Caddy

```caddyfile
wallet.example {
  root * /srv/privacy-wallet/dist
  encode zstd gzip
  header {
    Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://rpc.example https://relayer.example https://swap.example; img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
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
- `/zkapi/*` (Private AI): `npm run zkapi:assets` and `npm run zkapi:pins` (docs/zkapi-integration-spec.md).

## The API and the relayer

Both services send the same headers on every answer, from `packages/server-kit/src/http.ts`:

- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`;
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, since they serve JSON only;
- `Strict-Transport-Security` when the service terminates TLS itself (`TLS=1`).

Their configuration: `apps/api/.env.example` (and the engine's, `packages/swap-engine/.env.example`) and
`apps/relayer/.env.example`. Every number in it is read strictly (`packages/server-kit/src/env.ts`): one that is not a
whole number in its range stops the service at start, naming the setting. Their CORS headers go to the origins in `ALLOWED_ORIGINS` only. Both rate-limit per caller
(`RATE_PER_MINUTE`), and the address is never logged. By default the caller is the socket's address and no proxy header
is read. `TRUST_PROXY_HOPS` names how many proxies in front of the service append to `X-Forwarded-For`; the caller is
then the entry the outermost of them wrote, so what a client writes there itself buys nothing. A request with fewer
entries keeps its socket's address. A POST that is not JSON answers 415.
The relayer's edge is `apps/relayer/src/edge.ts` (`apps/relayer/test/edge.test.ts`), the API's `apps/api/src/app.ts`.

Behind a TLS proxy, leave `TLS` unset and let the proxy send HSTS, and set `TRUST_PROXY_HOPS` to the number of proxies
(1 for one). Without it every caller shares the proxy's address and so one bucket, which a single client can use up
for everyone (a V6 follow-up of 2026-10-15). Set it only when the service cannot be reached past those proxies.

The relayer runs only the swaps the swap service vouched for (a V6 follow-up of 2026-10-16, `docs/audit-package.md`
gap 47). Generate a secp256k1 key for the API and keep it with its secrets as `API_VOUCH_KEY` (32 bytes of hex; it
signs nothing else and is never logged). Give each relayer its address as `API_VOUCHER`, which `GET /v1/status` names
(`deployment.voucher`), together with `SWAP_FACTORY`: without both, a relayer runs no swaps. A new key means new
addresses on the relayers; an order committed under the old one is still refunded by a relayer that kept it.

The relayer's job lists (`GET /swap`, `GET /jobs`) are operator data: they answer only with `RELAYER_ADMIN_TOKEN` as a
bearer token, and are closed when it is unset. The relayer answers `GET /jobs/by-nullifier/<nullifier>` with the job's transaction hash and status only. That is how a
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
