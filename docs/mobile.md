# Mobile and desktop wallets (plan V1.1 §40–§43, §69–§70) — architecture and status

The web wallet (`apps/web/`) is the reference user experience. The native wallets reuse everything
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
   Rust crypto core (privacy-core/privacy-core)                    Groth16 prover: snarkjs / WASM (web),
   Poseidon2 · domains · keys · notes · nullifiers              privacy-core/privacy-prover (native, same .zkey)
   Merkle · payload binding · envelope · privacy address
            │
   OS secure storage: iOS Keychain / Android Keystore (seed at rest) · OS CSPRNG
```

## What is shared and verified today
| Piece | Where | Verified by |
|---|---|---|
| Crypto core, native | `privacy-core/privacy-core` (Rust, `ark-bn254`, `sha3`, `sha2`, `x25519-dalek`, `chacha20poly1305`, `scrypt`, `pbkdf2`, `k256`, `ed25519-dalek`) | `cargo test`, 14 suites on the SAME vectors as the circuit, contracts and TypeScript — `circuits/vectors/primitives.json` (nargo Poseidon2, domains, zero leaf, keys, note, nullifiers, tree roots, tx domain, payload hash), `packages/protocol/test/vectors/envelope.json` (pinned envelope bytes + address), `wallet.json` (the web wallet's keystore / journal / BIP-39 vectors, byte-identical), `chainkeys.json` (SLIP-0010, BIP-84, BIP-44, Phantom), a real depth-32 circuit fixture; builds for `x86_64` and `wasm32-unknown-unknown` |
| WASM package | `privacy-core/privacy-core-wasm` → `privacy-core/pkg/{node,web}` (`node scripts/build-wasm.mjs`, wasm-bindgen 0.2.117) | `packages/protocol/test/wasmCore.test.ts`: hashes, commitments, nullifiers, keys, envelopes both ways, roots, addresses, phrases, chain keys and the keystore agree with the TypeScript reference, and so do the two **sync batches** — `merkle_layers` (every layer of the tree in one call; paths are then lookups) and `scan_note_payloads` (note discovery over every payload in one call); since the audit round of 2026-10-16 (c18) also `open_note_payloads`, every payload that opens with the view key in the same single pass, each flagged by whether it reproduces its leaf with the privacy address's owner commitment — a deposited note is made out to its own (`derive_owner_key`, keys.rs), which the caller derives from the opened secret with the spend key. The FFI has `scan_note_payloads` only: a native wallet built on it must add the opening batch before its deposits use their own owner keys. Measured from node: Poseidon2 ≈ 8× faster than BigInt, a 4096-leaf tree ≈ 10×, discovery ≈ 4×. **The web wallet uses them** (`packages/sdk/src/core.ts`): loaded lazily from its own origin (`/core/`, never at first launch), the TypeScript reference when the package is not served |
| FFI for the native apps | `privacy-core/privacy-ffi` (UniFFI 0.32, proc-macros): the core's keys / notes / nullifiers / Poseidon2, address + envelope, tree roots + paths + batch discovery, phrase / keystore / journal, chain + per-dApp addresses, and a `Prover` object (zkey + circuit WASM → `prove(inputsJson, r, s)` → the 256-byte `transact` proof + public inputs, `verify`; `prove` refuses a witness whose public inputs differ from the ones the inputs declare — a tampered witness program holds the spending key and could otherwise prove another statement, e.g. another recipient, as the web wallet's `proveInputs` already refuses); errors as a typed `CoreError`; built as cdylib + staticlib. `privacy-core/uniffi-bindgen` (same uniffi version) generates **Swift** (`privacy_ffi.swift` + header + modulemap), **Kotlin** (`uniffi/privacy_ffi/privacy_ffi.kt`) and **Python** from the compiled library (`node privacy-core/scripts/ffi-bindings.mjs` → `privacy-core/target/bindings/`) | `privacy-ffi/tests/python/test_bindings.py` (11) over the generated Python module and the compiled library: nargo Poseidon2 vectors, keys / note / nullifier, tree roots and paths, the pinned envelopes and addresses, batch discovery, the web wallet's keystore / journal / phrase reproduced byte for byte, BIP-84 / BIP-44 / Solana / per-dApp addresses, and **a proof made through the bindings that is byte for byte the one forge verifies on the on-chain verifier** (≈ 0.6 s from inputs); invalid inputs fail in the witness, before proving. Swift / Kotlin compile on the platform toolchains |
| Native prover | `privacy-core/privacy-prover`: the snarkjs proving key read natively (`.zkey`: header, IC, coefficients, A / B1 / B2 / C / H; every point checked on its curve), snarkjs witnesses (`.wtns`), arkworks Groth16 with the snarkjs QAP reduction, the proof as snarkjs JSON and as the `transact` calldata; blinding scalars come from the caller; **the witness computed natively** (`witness.rs`: the circuit's own WASM run by wasmi, a pure-Rust interpreter with no JIT, so it runs on iOS) — circuit inputs → witness → proof without snarkjs | `privacy-prover/tests/prover.rs` (11) on the dev key and the four v1 fixtures: **the native witness equals snarkjs' `.wtns` element for element**, the circuit soundness manifest (4 honest, 10 attacks) gets the same verdicts as `circuits/test/witness.mjs` with the circuit's own failing line, the parsed key **equals `verification_key.json`**, native proofs verify and bind all 14 public inputs, **snarkjs' proofs verify natively** and export to snarkjs' own calldata, an unsatisfying witness never yields a valid proof; `contracts/test/verifier/NativeRustProof.t.sol` (5): **native proofs verify on the EVM verifier** PrivacyCore calls (pinned bytes, deterministic blinding). Time here (28 threads, `examples/prove-bench.rs`): **witness ≈ 340 ms + proof ≈ 235 ms native vs ≈ 1.1 s for snarkjs' witness + proof** |
| Keystore, phrase, journal, backup | `packages/sdk/src/wallet/*` ↔ `privacy-core/privacy-core/src/wallet/{keystore,bip39}.rs`, spec `docs/wallet-formats.md` | a backup file made by the web wallet opens in the Rust core and vice versa (same vectors) |
| Crypto core, TypeScript | `packages/protocol/src` | 45 + chain-key + scorecard tests; the web wallet imports it as `@ref` |
| Transaction model | `packages/protocol/src/txInputs.ts` (witness), `prover.ts` (proof → calldata) | real-artifact proving tests, forge e2e fixtures |
| Keys and addresses | `wallet/chainKeys.ts` (BIP-44 / BIP-84 / SLIP-0010), `address.ts` (bech32m `pp1…`) | BIP-84, SLIP-0010 and Phantom vectors; viem cross-check |
| Wallet engine | `packages/sdk/src/wallet/*`, `packages/sdk/src/*` (no DOM dependency except `localStorage`, behind `KeyValueStorage`) | 72 node tests incl. keystore / journal / schedule / quorum / first launch / the core path both ways / the swap-service guard |
| Privacy model | `packages/protocol/src/wallet/{amounts,scorecard}.ts`, `packages/swap-engine/src/privacyScore.ts` | lab-calibrated tests |

## Platform work that needs the toolchains (not done on this machine)
1. **React Native shell** (iOS + Android): screens are the web components' logic without React DOM;
   `KeyValueStorage` → encrypted file + Keychain / Keystore for the keystore blob (same JSON format, so the
   backup file moves between web and native); `crypto.getRandomValues` → `react-native-get-random-values`;
   the crypto and the prover → the generated UniFFI bindings over `privacy-core/privacy-ffi` (Swift / Kotlin
   sources come out of `node privacy-core/scripts/ffi-bindings.mjs`; link the staticlib on iOS — an
   `aarch64-apple-ios` build — and the cdylib per ABI on Android via `cargo-ndk`). Requires Xcode / Android Studio.
2. **Tauri desktop shell** (Windows / macOS): wraps the Vite build (which already carries the light client,
   `packages/sdk/src/lightclient/`); adds a local RPC option and a SOCKS5 proxy setting (`additional_browser_args = "--proxy-server=socks5://127.0.0.1:9050"`)
   as the plan §7 transport. Requires the MSVC toolchain on Windows (this machine has only GNU).
3. **Native proving on devices**: the prover and the native witness are built and verified
   (`privacy-core/privacy-prover`, above: circuit inputs → witness → proof, all Rust); both are exposed through
   UniFFI (`Prover` in `privacy-core/privacy-ffi`); what remains is shipping `transaction.wasm` and the `.zkey`
   with the app (or fetching them pinned by hash) and the device benchmarks (`cargo run --release -p privacy-prover --example
   prove-bench` on the phone) that decide the proof-system question in `docs/roadmap.md`. The interpreter
   uses wasmi's portable dispatch: its default tail-call dispatch relies on LLVM eliminating sibling calls,
   which did not happen on this target and overflowed the stack.
4. **Secure storage adapters** and **biometric unlock** on top of the keystore (the password KDF stays;
   the OS keystore wraps the derived key).
5. **Acceptance on devices**: the click-through in `docs/local-run.md` on a phone; a cold-start audit of
   network requests (plan §39) with the platform's traffic capture, as `apps/web/test/first-launch.test.tsx`
   does for the web build.

## Rules the native wallets inherit (plan §43, §44, Rule 13)
- Witnesses never leave the device: no remote proving by default.
- Recovery = the 24-word phrase (seed) + the encrypted journal backup; never a server database.
- The default screens hide Merkle trees, nullifiers, proofs, relayers, solvers and bridges; "Advanced" shows them.
- No analytics, no tracking, no network request unrelated to a user action.
