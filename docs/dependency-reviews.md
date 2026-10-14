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
