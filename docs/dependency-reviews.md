# Dependency reviews

The record `scripts/dependency-review.mjs` reads (Privacy Wallet Web spec v2.0 §17; doc §69: "Do not casually add
crypto-related npm dependencies. Crypto dependencies require manual review."). verify-all and CI compare the lockfile
with a base revision; a cryptography-sensitive package — `@noble/*`, `@scure/*`, `snarkjs`, `ffjavascript`,
`circomlibjs`, `viem`, `ox`, `@walletconnect/*` — that is added or changes version, or any package that brings an
install script, fails the gate until a dated line below names it as `` `name@version` ``.

A review line says what was checked: the publisher and repository, the changelog between the two versions, the
lockfile's sha512 integrity, the absence of an install script, and which of the package's functions the code calls.

## Baseline — 2026-10-13 (the gate introduced, V6 Stage 2)

The versions locked when the gate was introduced. They were chosen in earlier passes (V1.0 to V5) and exercised by the
suites since; this baseline records them so the gate starts from a known state. It is not a fresh audit of their
code.

| Package | Locked | Used for |
|---|---|---|
| `@noble/hashes@1.8.0`, `@noble/hashes@1.7.0`, `@noble/hashes@1.4.0` — 2026-10-13 | root (1.7.0 and 1.4.0 nested under other packages) | sha256, keccak, scrypt, HKDF (the keystore, the journal key, the domains) |
| `@noble/curves@1.9.1`, `@noble/curves@1.9.7`, `@noble/curves@1.8.0` — 2026-10-13 | root (1.9.7 and 1.8.0 nested) | secp256k1 (EVM keys), ed25519 (Solana), bls12-381 (the light client), x25519 (the payload envelope) |
| `@noble/ciphers@1.3.0` — 2026-10-13 | root | XChaCha20-Poly1305 (the keystore, the journal, the payload envelope) |
| `@scure/base@1.2.6`, `@scure/bip32@1.7.0`, `@scure/bip39@1.6.0` — 2026-10-13 | root | bech32 / base58 encodings, BIP-32 derivation, the 24-word phrase |
| `snarkjs@0.7.6`, `ffjavascript@0.3.1`, `ffjavascript@0.3.0` — 2026-10-13 | root (0.3.0 nested) | Groth16 proving in the browser's worker; verification in tests |
| `viem@2.57.3`, `ox@0.14.45`, `ox@0.9.3`, `ox@0.6.9` — 2026-10-13 | root (ox nested under viem and WalletConnect) | RPC, ABI encoding, transaction building |
| `@walletconnect/ethereum-provider@2.26.0` and its `@walletconnect/*` closure (2.26.0, 2.23.7 nested, the 1.x helpers) — 2026-10-13 | root | the lazily loaded WalletConnect connector |
| `@reown/appkit@1.8.19` — 2026-11-03 | root (under `@walletconnect/ethereum-provider@2.26.0`; the only shipped package with an install script, in the lockfile since 2026-10-08, before the gate — the fourth review round's `--all` sweep found it unreviewed) | postinstall its own postinstall file (appkit-version-check, in the package's scripts directory), read on 2026-11-03: walks up to the consumer's package.json, compares the `@reown/appkit*` versions with `semver` and prints a notice when they differ — no network, no writes, nothing of it runs in the shipped bundle |

## Reviews

- 2026-10-26 (V7 Stage 2) — the Classic app's own lockfile, `classic/package-lock.json` (spec v3.0 §7.8; 386 packages,
  every one from the registry with its sha512 integrity, no `@privacy-wallet/*` package): the runtime dependencies
  `react@18.3.1`, `react-dom@18.3.1` and `zod@4.6.7` (MIT; the same versions the root lockfile carries; zod is reviewed
  above) and the development tooling (Vite 5, Vitest 2, TypeScript, ESLint and its plugins, Testing Library, happy-dom),
  none of which ships in the build. Two packages carry an install script, both reviewed (the gate reads one line at a
  time, so each is dated on its own line):
  - 2026-10-26 — `esbuild@0.21.5` (MIT; Vite 5's bundler; its postinstall only picks the platform binary among its own
    optional packages; the root lockfile carries the same esbuild).
  - 2026-10-26 — `fsevents@2.3.3` (MIT; a macOS-only optional dependency of chokidar, never installed on this
    workstation or in CI).
  No cryptography-sensitive package is in the lockfile yet; the vendored prover of Stage 6 enters as source files under
  the app's vendor directory, hashed by `classic/vendor/VENDORED.md`, not through npm.

- 2026-10-13 (V6 Stage 5) — `@fontsource-variable/inter@5.3.0` (OFL-1.1; packages/ui): the variable Inter's woff2 files;
  the design system serves the latin one from its own origin (`packages/ui/src/fonts.css`). `playwright-core@1.64.0`
  (Apache-2.0), `pixelmatch@8.0.0` (ISC), `pngjs@7.0.0` (MIT; root devDependencies): the screenshot harness
  (`tests/visual/run.mjs`), local only; playwright-core drives the installed Chrome and downloads no browser. None is
  cryptography-sensitive; none has an install script (the lockfile's `hasInstallScript` is unset); each locked with its
  sha512 integrity from the registry. `pngjs@5.0.0` stays nested under `qrcode`, unchanged.
- 2026-10-13 (V6 Stage 9) — `express@5.3.0` (MIT; apps/api) and its closure: `router@2.2.0`, `path-to-regexp@8.4.2`,
  `body-parser@2.3.0`, `raw-body@3.0.2`, `qs@6.16.0` (BSD-3-Clause), `send@1.2.1`, `serve-static@2.2.1`,
  `finalhandler@2.1.1`, `type-is@2.1.0`, `content-type`, `cookie`, `debug`, `mime-types@3.0.2`, `proxy-addr@2.0.8`
  (unused: `trust proxy` is off) and the small MIT/ISC helpers the review script lists; `@types/express@5.0.6` (MIT,
  devDependency). The API's HTTP layer only: it holds no key, signs nothing, and serves JSON to the wallet. None is
  cryptography-sensitive; none has an install script; each locked with its sha512 integrity from the registry; the audit
  finds no advisory in it. `node:sqlite` is Node's own (24.x), no package.
- 2026-10-23 (audit round 2 follow-up: GHSA-mrhx-c7xc-m3w5) — `zod@4.6.7` (MIT), one copy for the whole tree. The advisory
  (high: memory exhausted while validating oversized constrained collections, every zod below 4.6.6) failed the audit gate
  on 2026-10-23. The wallet's own dependency (apps/web: the configuration, the `prefs` store, the classic relayer's
  answers) moved from `^3.25.76` to `^4.6.7`, and the root `overrides` sets `^4.6.7` for every other copy: viem's
  `abitype@1.2.3` (an optional peer, used by `abitype/zod` only), `eslint-plugin-react-hooks` and `zod-validation-error`
  (both accept `^4`), and two that declare zod 3 — `@coinbase/cdp-sdk@1.58.0` (`^3.25.76`, under `@reown/appkit-utils` →
  `@base-org/account`) and `@reown/appkit-wallet@1.8.19` (`3.22.4`, exact). No release of WalletConnect's modal moves past
  zod 3 yet (`@reown/appkit-wallet@1.8.24` still pins 3.22.4). Neither package's zod code is in the shipped bundle (no
  `W3mFrame`, no `cdp-sdk` in `apps/web/dist`); the bundle carries one zod, the wallet's own. The wallet's three schemas
  read alike under zod 4: the configuration, prefs and classic suites pass unchanged. Not cryptography-sensitive; no
  install script; locked with its sha512 integrity from the registry. The override can go once both packages accept zod 4.
- 2026-10-23 (GHSA-27r3-jxmh-p828) — `body-parser@2.4.0` (MIT; apps/api, through `express@5.3.0`, whose range `^2.3.0`
  takes it) and `qs@6.16.1` (BSD-3-Clause), which its raised range asks for. The advisory (high: a compressed request body
  with trailing bytes threw an uncaught exception, a denial of service for anyone who can reach the API; every 2.x below
  2.4.0) failed the audit gate on 2026-10-23. The API reads its bodies with `express.json` (64 KB). Not
  cryptography-sensitive; no install script; locked with their sha512 integrity from the registry; nothing else moved.
- 2026-10-26 (V7 Stage 3) — the Classic screenshot harness's devDependencies in `classic/package-lock.json`:
  `pixelmatch@8.0.0` (ISC), `playwright-core@1.64.1` (Apache-2.0) and `pngjs@7.0.0` (MIT), the same three the root
  harness uses (`axe-core` was already in the lockfile through `eslint-plugin-jsx-a11y`). Local tooling only, never
  shipped (`classic/scripts/check-deps.mjs` keeps them out of `src/`). None is cryptography-sensitive; none has an
  install script; each locked with its sha512 integrity from the registry.
- 2026-10-26 (V7 Stage 5) — the Classic deployment verification's devDependencies in `classic/package-lock.json`:
  `solc@0.8.38` (MIT) — its wrapper alone (`solc/wrapper.js`), which binds the pinned legacy builds the verification
  downloads from binaries.soliditylang.org and checks against the release list's sha256 (`classic/scripts/compilers.mjs`;
  the builds are never committed) — with its closure `commander@8.3.0`, `command-exists@1.2.9`, `follow-redirects@1.16.2`,
  `memorystream@0.3.1` (no licence field in its manifest; the ISC-style text in its repository), `semver@5.7.2` (ISC),
  `tmp@0.2.6` and the nested `js-sha3@0.8.0`; and `js-sha3@0.13.0` (MIT) for the four-byte selectors of the view calls
  the verification makes. Node-side tooling only (`classic/scripts/`, `classic/test/`): nothing of it reaches the app
  (`classic/scripts/check-deps.mjs` keeps devDependencies out of `src/`). None is cryptography-sensitive in the gate's
  sense; none has an install script; each locked with its sha512 integrity from the registry.
- 2026-10-26 (V7 Stage 6) — the Classic prover's runtime dependencies in `classic/package-lock.json`:
  `big-integer@1.6.52` (Unlicense; snarkjs 0.1's and websnark's arithmetic where native BigInt is not used — the vendored
  originals' own dependency, at the version their manifests name), `js-sha3@0.13.0` (MIT; moved from devDependencies to
  dependencies: the keccak256 chain of the MiMCSponge constants in place of web3-utils, and the view-call selectors), and
  `snarkjs@0.7.6` (GPL-3.0) for `groth16.verify` alone — a proof verified on the device, inside the prover worker, before
  it is returned — with its closure: `ffjavascript@0.3.1` (and `ffjavascript@0.3.0` nested under `r1csfile`),
  `wasmcurves@0.2.2`, `wasmbuilder@0.0.16`, `r1csfile@0.0.48`, `fastfile@0.0.20`, `@iden3/binfileutils@0.0.12`,
  `@iden3/bigarray@0.0.2` (GPL-3.0), `circom_runtime@0.1.28`, `web-worker@1.2.0`, `ejs@3.1.10`, `jake@10.9.4`,
  `filelist@1.0.6` (Apache-2.0), `@noble/hashes@1.8.0` (MIT), `bfj@7.1.0`, `logplease@1.2.15`, `async@3.2.6`,
  `bluebird@3.7.2`, `check-types@11.2.3`, `hoopy@0.1.4`, `tryer@1.0.1`, `jsonpath@1.3.0`, `static-eval@2.1.1`,
  `underscore@1.13.6`, `escodegen@2.1.0`, `esprima@4.0.1` and `esprima@1.2.5` (no licence field in its manifest;
  BSD-2-Clause in its repository), `source-map@0.6.1` (optional), the nested `brace-expansion@2.1.7` and
  `minimatch@5.1.9`. The same `snarkjs@0.7.6`, `ffjavascript@0.3.1` / `0.3.0` and `@noble/hashes@1.8.0` the root lockfile
  carries (the baseline table above); none has an install script; each locked with its sha512 integrity from the registry.
  Of the closure only snarkjs's browser build reaches the app, in the prover worker's chunk (466 KB, 114 KB gzipped) and
  never the first route (`classic/scripts/check-budget.mjs`). The vendored prover itself — websnark `4c0af6a8`, snarkjs
  0.1.20, circomlib `3b492f9`, blake-hash 2.0.0 — is source under `classic/vendor/` with every file's sha256 in
  `classic/vendor/VENDORED.md`, not a lockfile entry.
- 2026-10-26 (V7 Stage 7) — `fake-indexeddb@6.2.5` (Apache-2.0), a devDependency in `classic/package-lock.json`: the
  IndexedDB the Classic history store's tests run against (the same package the root lockfile carries for apps/web).
  Test-only, never shipped; no install script; locked with its sha512 integrity from the registry.
- 2026-11-02 (a V7 follow-up) — `follow-redirects@1.16.2` (MIT) replaces 1.16.1 in `package-lock.json`: GHSA-mrwp-f3q8-3g9p
  (cross-realm `sensitiveHeaders` arrays discarded, so custom credentials could follow a redirect), a transitive dependency of
  WalletConnect's modal stack (`@walletconnect/ethereum-provider` → `@reown/appkit` → `@base-org/account` → `@coinbase/cdp-sdk`
  → `axios`). The wallet never calls axios — every request goes through the privacy engine's transport — and the connector
  exists only with a project id; bumped with `npm update follow-redirects`, which also wrote npm's `license` fields into the
  lockfile's entries (no other version moved; `scripts/check-lockfile.mjs` and `scripts/dependency-review.mjs` pass).

## The --all sweep — 2026-11-03 (the fourth review round)

`node scripts/dependency-review.mjs --all` reviews every installed package, not the change since a base: the diff-only review had never
swept the lockfile's first population, so the one shipped package with an install script (`@reown/appkit@1.8.19`, named above) and the
members of the WalletConnect closure — recorded on 2026-10-13 as one closure row, which the sweep reads per `name@version` — had no line
of their own. The gate runs the sweep over both lockfiles. What each line below records: the package is the one the 2026-10-13
closure row covers (the lazily loaded WalletConnect connector, the modal stack under it), locked to the tarball the lockfile's
sha512 pins, no install script, and nothing of it runs before the user taps WalletConnect.

| Package | Locked | Used for |
|---|---|---|
| `@walletconnect/core@2.23.7` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/core@2.26.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/environment@1.0.1` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/events@1.0.1` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/heartbeat@1.2.2` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/jsonrpc-http-connection@1.0.8` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/jsonrpc-provider@1.0.14` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/jsonrpc-types@1.0.4` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/jsonrpc-utils@1.0.8` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/jsonrpc-ws-connection@1.0.16` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/keyvaluestorage@1.1.1` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/logger@3.0.2` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/relay-api@1.0.11` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/relay-auth@1.1.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/safe-json@1.0.2` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/sign-client@2.23.7` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/sign-client@2.26.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/time@1.0.2` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/types@2.23.7` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/types@2.26.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/universal-provider@2.23.7` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/universal-provider@2.26.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/utils@2.23.7` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/utils@2.26.0` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/window-getters@1.0.1` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `@walletconnect/window-metadata@1.0.1` — 2026-11-03 | root (the WalletConnect closure of 2026-10-13) | the lazily loaded WalletConnect connector's stack |
| `esbuild@0.28.2` — 2026-11-03 | root, development only (under `tsx`, the test and script runner); not shipped | postinstall `install.js`, read on 2026-11-03: validates the installed platform binary's version and downloads the matching one only when it is missing — the registry's own tarball, pinned by the lockfile |
