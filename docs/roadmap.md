# Roadmap — Stages 0–15 (condensed)

From the spec (§103–§120) and the Core Protocol Specification Plan (§91). Legend: ✅ done · 🔶 partial · ⏳ pending.

| Stage | Deliverable | Status |
|-------|-------------|--------|
| 0 | Freeze specs | ✅ `docs/protocol-spec-v1.0.md` (exact contract + cryptographic spec), crypto / vault / threat / invariants |
| 1 | Cryptographic reference + test vectors | ✅ TypeScript + Python (independent), Poseidon2 pinned by nargo vectors, `circuits/vectors/primitives.json` |
| 2 | Circuits (2-in/3-out) | ✅ compiled (Poseidon2, 23,343 constraints); KAT 18/18; soundness 17/17; **PP-C01/C02/C03 + PP-P01/P02 found and fixed**; external audit ⏳ |
| 3 | Asset vaults (native/ERC20/factory) | ✅ tested incl. the full token zoo and CREATE2 salt format |
| 4 | Immutable core | ✅ 4-aligned groups, txDomain binding, fixed-size payloads, custom errors, no-privilege scan |
| 5 | Deposit tests (malicious tokens, donation, reentrancy) | ✅ |
| 6 | Private transfer | ✅ real proofs for transfer / withdraw / merge / relayer-fee verify on-chain; e2e withdraw + fee spend; wallet-side proving ⏳ |
| 7 | Withdrawal (stealth recipient, claimable, fee) | ✅ claimable-fallback; private fee note; stealth UX ⏳ |
| 8 | Issuer attack lab | ✅ three vaults, asset-local damage, no cross-vault deficit |
| 9 | Reorg lab | ✅ block-based roots (forge) + reorg-aware indexer at depths 1/3/12/64 (TS) |
| 10 | Privacy lab vs the Tornado baseline | ✅ `docs/privacy-lab.md`: §68 targets met (amount unique-link 0 %; joint set 10 → 349 / 1,073) |
| 11 | Adversary ladder A1–A12 (A10/A11 removed) | ✅ `docs/threat-model.md` + `adversarial/` + `NoPrivilege.t.sol` |
| 12 | Proof benchmark + proof-system decision | 🔶 Groth16 measured (~0.9 s, 285k gas verify); mobile + Halo2/FRI comparison ⏳ |
| 13 | Testnet | ⏳ (`contracts/script/Deploy.s.sol` dry-runs locally) |
| 14 | Independent audits | ⏳ |
| 15 | Production asset policy (ETH first, then USDC/USDT) | ⏳ |

## V1.1 — zkAPI service layer + privacy wallet + cross-chain swap (plan §84 order)
| Step | Deliverable | Status |
|------|-------------|--------|
| 01 study zkAPI | `docs/zkapi/architecture.md`, `protocol.md` | ✅ |
| 02 reproduce zkAPI | SDK 309/309 (LF checkout), contracts 29/29, mainnet + Sepolia pins 23/23 with byte-exact rebuilds (`services/zkapi-lab`); Rust protocol 45/45, app workspace builds + 67/67 runnable tests, clippy/fmt clean, shipped WASM proofs verified natively, own WASM rebuild → byte-identical bindings (`docs/zkapi/reproduction.md`) | 🔶 everything except `test:e2e:v2` + 34 socket-bound unit tests, which this machine's Winsock LSP (ASProxy64.dll) blocks — needs a clean machine or an elevated `netsh winsock reset` |
| 03 zkAPI security assessment | `docs/zkapi/security.md` (pause + 30-day expiry → treasury; single-party setup; server-dependent operation) | ✅ |
| specs | `docs/private-swap-spec-v1.1.md`, `docs/zkapi-integration-spec.md` | ✅ |
| Solidity exit interface | `SwapOrderEscrow` + `SwapOrderFactory` (periphery; core unchanged, frozen ABIs re-verified), 18 tests incl. provider compromise, re-route to fallback, refund-to-pool | ✅ |
| 06 quote aggregator | `services/private-swap` engine: state machine, scoring + incident feed, privacy score, endpoint derivation == forge | ✅ |
| 07 THORChain adapter | quote / memo with limit / router calldata / status / halts — live | ✅ (quotes); execution with funds ⏳ |
| 08 Chainflip adapter | vault-swap quotes, `encodeVaultSwapData` ingress decoded + verified locally, status, safe-mode halts — live | ✅ (quotes + verified calldata); execution with funds ⏳ |
| 09 Mayan adapter | Fast-MCTP quotes, order payload built locally (destination / min-out / deadline), forwarder calldata, explorer status — live | ✅ (quotes + calldata); execution with funds ⏳; SWIFT auctions ⏳ |
| 10 NEAR Intents adapter | 1Click dry quotes (service-signed, min-out, refund = escrow), status — live; ingress withheld until contract-sent deposits are confirmed by the provider | 🔶 quotes ranked, never chosen |
| 12 Uniswap-Across adapter | Across bridge: `depositV3` built locally with an exact fill amount, pinned SpokePools, status — live | ✅ (bridge); Uniswap swap leg ⏳ |
| 11 LI.FI adapter | quote / transactionRequest ingress / status — live | ✅ (quotes) |
| 13 PrivateSwap privacy engine | privacy score + delay budget + route policy | ✅ (calibrated by the lab constants) |
| 14 integrate with PrivacyCore | the escrow IS the integration (withdrawal recipient); **real-proof e2e**: note → escrow → provider, and note → escrow → refund note → spent (`RealProofE2E.t.sol`, fixtures via `circuits/scripts/e2e-fixture.sh`) | ✅ |
| 04 Private AI | `frontend` "Private AI" tab on the zkAPI browser SDK (pinned clone as a `file:` dependency), runtime-key mode only, fresh wallet-derived funding address (EIP-1193 shim over a local key) funded by a private withdrawal from the pool, spending tiers, streaming chat straight to OpenRouter, mutual-close withdrawal; SDK assets built + hash-verified here, spec §3 pin check **12 + lab 23 checks, 0 fail** (`npm run zkapi:assets && npm run zkapi:pins`); Sepolia password dialog wired; 17 node tests of the glue (`frontend/npm test`); the funded browser flow needs a workstation with Sepolia ETH — `docs/private-ai.md` | 🔶 built, unfunded |
| 05 Private RPC | blocked upstream: the live zkAPI deployments lease OpenRouter keys only (no metered RPC upstream); the wallet keeps no permanent API key, batches JSON-RPC, sends no cookies / follows no cross-host redirects and routes reads through the pinned RPC + the same transport hook; light-client verification and the metered upstream wait for a zkAPI RPC upstream | 🔶 blocked upstream |
| 15–16 wallet (web/desktop) | `frontend`: **client-side proving** (Web Worker over `reference/typescript/src/prover.ts`), note discovery from the encrypted payloads, relayer submission with fee notes + merges, the Swap tab (one-time escrow, provider call signed in the browser, executor hand-off), Private AI; **plan §44** encrypted keystore (scrypt + XChaCha20-Poly1305) + 24-word recovery phrase + encrypted note journal + backup file (`src/wallet/{keystore,journal,session}.ts`); **§45–§46** Chain Key Abstraction (BIP-44 / BIP-84 / SLIP-0010, pinned vectors) with a Receive screen and fresh per-chain destinations (`reference/typescript/src/wallet/chainKeys.ts`, `src/keys/chainKeys.ts`, `components/Receive.tsx`); **§38** RPC read quorum (`VITE_RPC_URLS`, every proved view read from all endpoints and compared); **§36** public balance beside the private one (read through the injected wallet's own provider); **§39** pinned by `test/first-launch.test.tsx` (happy-dom: no network request through creating a wallet and opening every tab); **§76–§78** advanced mode (default screens hide the cryptography) + the six-category scorecard on every action (`reference/typescript/src/wallet/scorecard.ts`); **§30–§31** randomized funding time inside the policy window kept in the journal (`src/wallet/schedule.ts`) + bucket suggestions; **§22/§79** one route in plain words, providers behind "View route" with risk / bridge / settlement; **§49** walletless guest mode (`components/Guest.tsx`, service `/guest/*`); 42 node tests + build; mobile: see `docs/mobile.md` (Rust core built, shells need the platform toolchains) | 🔶 web ✅ (unclicked), mobile core ✅, shells ⏳ |
| 17 privacy simulations | plan §72: `test/privacy-flow.test.ts` (live: the permanent wallet never appears in any provider request / signed calldata / order; escrow = the only sender, fresh address = the only receiver) + the **cross-chain observer lab** (`src/sim/crossChainLab.ts` → `benchmarks/privacy/crosschain.json`): ingress ↔ arrival linkability by provider class, throughput and amount policy; the spec §10 score now carries a lab-calibrated cross-chain term | ✅ |
| 18 adversarial / provider-failure tests | plan §71 matrix × 6 providers + §74 compromise, engine side (`test/adversarial.test.ts`, live with tampered API responses) and on-chain (forge); adapters hardened: LI.FI diamond pin + BridgeData/Across-facet decoding, THORNode gateway quorum, Mayan Fast-MCTP pin + min-out consistency, 1Click min-out consistency, changed-quote price guard — `docs/test-matrix.md` | ✅ |
| 19 testnet | `contracts/script/DeploySwapPeriphery.s.sol` (+ Sepolia-gated dev-verifier switch in `Deploy.s.sol`), both dry-run here, escrow creation-code hash == exported artifact; runbook `docs/testnet.md`; **broadcast not done** (needs a funded key and a machine whose network stack lets forge talk to an RPC — this one cannot, Winsock LSP) | 🔶 |
| Rust crypto core (plan §40, §43–§45, §69) | `core/rust/privacy-core`: Poseidon2 (constants generated from the TypeScript), domains, keys, notes, nullifiers, 4-aligned Merkle accumulator + paths, payload binding, tx domain, envelope (X25519 + XChaCha20-Poly1305), bech32m privacy address, **keystore + journal formats, BIP-39 (embedded wordlist generated from the web wallet's), BIP-32/44/84 and SLIP-0010 chain keys** — **12 vector suites** against `primitives.json`, `envelope.json`, `wallet.json` (the web wallet's pinned keystore / journal / phrase vectors: byte-identical), `chainkeys.json` and a real depth-32 circuit fixture; `privacy-core-wasm` (wasm-bindgen) reproduces the TypeScript reference **7/7 from node** (`reference/typescript/test/wasmCore.test.ts`, Poseidon2 ≈ 7× faster); builds offline for the GNU host and `wasm32-unknown-unknown` (vendored crates, `services/zkapi-lab/vendor-closure.mjs`) — `docs/mobile.md`, `docs/wallet-formats.md` | ✅ core + WASM; native prover + RN/Tauri shells ⏳ (toolchains) |
| 20 independent audits | `docs/audit-package.md`: scope, pinning, invariants/test inventory, known gaps, auditor questions; engagement itself external | 🔶 package ready |

## Decisions still open (owner needed)
- **Gas vs §79 targets** — `transact` 1.79M / `deposit` 1.52M vs 650k / 150k. At today's gas that is
  under a dollar per operation; the levers (direct library calls, Yul body hash, deposit queue,
  shallower tree, proven updates) are in `benchmarks/gas/README.md`.
- **Proof system** (plan §41–42): Groth16 + ceremony, or a universal/transparent system — needs the
  Halo2/FRI benchmark.
- **Asset policy in the wallet (plan §36 USDC/USDT)** — the contracts, the engine and the executor handle ERC-20 vaults; the wallet UI stays ETH-only until the stage-15 asset policy is decided (a transaction is single-asset, so relayer fee terms per vault come first).
- **Payload encryption scheme** — *proposal implemented* (`crypto-spec.md`, "Output payload envelope"): view key → X25519 via a tagged sha256, envelope key from the shared secret + both public keys, bech32m `pp1…` privacy address; reference tests + vectors, wallet note discovery on it. The owner confirms or picks another binding under a new version byte.

## Private submission (plan §76, §81, §85 rule 5) — built
`services/relayer` + the wallet's submission setting: by default a relayer submits every private
transaction from its own key and is paid by a private fee note (output 1 of a withdrawal, output 2 of a
transfer, encrypted to the relayer's privacy address); the connected wallet remains the public fallback and
any relayer URL can be used. The same service runs the **swap-order executor**: the Swap tab hands it the
funded order's params, the signed execution and the refund payload; it deploys + executes for the tip and
refunds to the pre-committed note after the window (12 executor tests vs the periphery forge vector). The
Swap tab funds the escrow first and signs the provider call against a fresh quote afterwards (quotes are
minutes, the delay budget hours), re-signing if the executor reports expiry. Journals are file-backed and
survive restarts; per-caller rate limits and a job cap protect a public relayer. The wallet merges notes
automatically (private self-transfers, fee-aware) when a spend needs more than two. `scripts/verify-all.mjs`
runs every suite + builds (+ live, + forge) in one command. Not run on a live chain (no node on this machine).

## Deferred (and why)
- zkAPI-metered RPC / quote gateways (plan §52–§53, §64–§65): the live zkAPI deployments issue OpenRouter keys only; a fork with another capability issuer cannot run on this machine (Winsock LSP). Tor / mixnet transport (§7) and a light client (§38): native-host work (`docs/mobile.md`). RN / Tauri shells (§40, §42, §69–§70): no Xcode / Android SDK / MSVC here; the shared core and engine are built and verified. The private API marketplace (§54): "eventually" in the plan.
- Testnet adapter pins (provider testnets) and the Sepolia broadcast; a live provider-volume feed for the cross-chain privacy term; mobile proving benchmarks; Halo2/FRI comparison; production
ceremony + verifier; external audits; everything in plan §92 (UI beyond the shell, relayer, website).
