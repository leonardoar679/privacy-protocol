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
