# Mobile and desktop wallets (plan V1.1 §40–§43, §69–§70) — architecture and status

The web wallet (`frontend/`) is the reference user experience. The native wallets reuse everything
below the UI; this page records what is shared, what is built, and what a workstation with the
platform toolchains still has to do. Nothing here changes the trust model: the same contracts, the
same circuit, the same note format, the same keys.

## Layers (plan §40)
```
React Native UI (iOS / Android)        Tauri shell (Windows / macOS)        Vite web app (any browser)
            │                                      │                               │
            └──────────────── TypeScript wallet engine (shared) ───────────────────┘
                      keystore · journal · note store · tree sync (RPC quorum) · planners
                      swap orders + schedule · relayer / swap-service clients · scorecard
            ┌──────────────────────────────┴──────────────────────────────────┐
   Rust crypto core (core/rust/privacy-core)                    snarkjs / WASM prover (today)
   Poseidon2 · domains · keys · notes · nullifiers              → native Groth16 (follow-up)
   Merkle · payload binding · envelope · privacy address
            │
   OS secure storage: iOS Keychain / Android Keystore (seed at rest) · OS CSPRNG
```

## What is shared and verified today
| Piece | Where | Verified by |
|---|---|---|
| Crypto core, native | `core/rust/privacy-core` (Rust, `ark-bn254`, `sha3`, `sha2`, `x25519-dalek`, `chacha20poly1305`, `scrypt`, `pbkdf2`, `k256`, `ed25519-dalek`) | `cargo test`, 12 suites on the SAME vectors as the circuit, contracts and TypeScript — `circuits/vectors/primitives.json` (nargo Poseidon2, domains, zero leaf, keys, note, nullifiers, tree roots, tx domain, payload hash), `reference/typescript/test/vectors/envelope.json` (pinned envelope bytes + address), `wallet.json` (the web wallet's keystore / journal / BIP-39 vectors, byte-identical), `chainkeys.json` (SLIP-0010, BIP-84, BIP-44, Phantom), a real depth-32 circuit fixture; builds for `x86_64` and `wasm32-unknown-unknown` |
| WASM package | `core/rust/privacy-core-wasm` → `core/rust/pkg/{node,web}` (`node scripts/build-wasm.mjs`, wasm-bindgen 0.2.117) | `reference/typescript/test/wasmCore.test.ts`: hashes, commitments, nullifiers, keys, envelopes both ways, roots, addresses, phrases, chain keys and the keystore agree with the TypeScript reference; Poseidon2 ≈ 7× faster than BigInt |
| Keystore, phrase, journal, backup | `frontend/src/wallet/*` ↔ `core/rust/privacy-core/src/{keystore,bip39}.rs`, spec `docs/wallet-formats.md` | a backup file made by the web wallet opens in the Rust core and vice versa (same vectors) |
| Crypto core, TypeScript | `reference/typescript/src` | 45 + chain-key + scorecard tests; the web wallet imports it as `@ref` |
| Transaction model | `reference/typescript/src/txInputs.ts` (witness), `prover.ts` (proof → calldata) | real-artifact proving tests, forge e2e fixtures |
| Keys and addresses | `wallet/chainKeys.ts` (BIP-44 / BIP-84 / SLIP-0010), `address.ts` (bech32m `pp1…`) | BIP-84, SLIP-0010 and Phantom vectors; viem cross-check |
| Wallet engine | `frontend/src/wallet/*`, `frontend/src/sdk/*` (no DOM dependency except `localStorage`, behind `KeyValueStorage`) | 42 node tests incl. keystore / journal / schedule / quorum / first launch |
| Privacy model | `reference/typescript/src/wallet/{amounts,scorecard}.ts`, `services/private-swap/src/privacyScore.ts` | lab-calibrated tests |

## Platform work that needs the toolchains (not done on this machine)
1. **React Native shell** (iOS + Android): screens are the web components' logic without React DOM;
   `KeyValueStorage` → encrypted file + Keychain / Keystore for the keystore blob (same JSON format, so the
   backup file moves between web and native); `crypto.getRandomValues` → `react-native-get-random-values`;
   the crypto → `privacy-core` through UniFFI (Swift / Kotlin bindings; the WASM surface shows the byte-array
   API shape); the prover → a native module (see 3). Requires Xcode / Android Studio.
2. **Tauri desktop shell** (Windows / macOS): wraps the Vite build; adds a local light client / local RPC
   option and a SOCKS5 proxy setting (`additional_browser_args = "--proxy-server=socks5://127.0.0.1:9050"`)
   as the plan §7 transport. Requires the MSVC toolchain on Windows (this machine has only GNU).
3. **Native proving**: the Groth16 proof is produced by snarkjs (WASM) in the web wallet; mobile should use
   a native prover (rapidsnark or `ark-groth16` with the same `.zkey`) exposed through UniFFI from
   `privacy-core`. Benchmarks on devices decide the proof-system question in `docs/roadmap.md`.
4. **Secure storage adapters** and **biometric unlock** on top of the keystore (the password KDF stays;
   the OS keystore wraps the derived key).
5. **Acceptance on devices**: the click-through in `docs/local-run.md` on a phone; a cold-start audit of
   network requests (plan §39) with the platform's traffic capture, as `frontend/test/first-launch.test.tsx`
   does for the web build.

## Rules the native wallets inherit (plan §43, §44, Rule 13)
- Witnesses never leave the device: no remote proving by default.
- Recovery = the 24-word phrase (seed) + the encrypted journal backup; never a server database.
- The default screens hide Merkle trees, nullifiers, proofs, relayers, solvers and bridges; "Advanced" shows them.
- No analytics, no tracking, no network request unrelated to a user action.
