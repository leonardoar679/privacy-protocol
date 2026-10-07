# Privacy Protocol V1

An immutable, non-custodial, Ethereum-L1 **shielded pool** for ETH + ERC-20s — the protocol specified
by the Tornado Cash study in [`../research`](../research). Thesis: *keep Classic's immutability and
fund-safety, adopt an expressive UTXO shielded pool, and close the whole metadata stack by default* —
with one central refinement: an **asset-free core** plus **one canonical vault per asset**, so a
stablecoin issuer's freeze can only ever touch its own vault.

> Pre-production. The exact specification is [`docs/protocol-spec-v1.0.md`](docs/protocol-spec-v1.0.md);
> contracts, circuit, two crypto references and the wallet shell are **built and tested to it**, and
> real Groth16 proofs drive a shield → private withdrawal → relayer fee spend **end to end on the EVM**
> with nothing mocked. The trusted setup is a dev setup (insecure by design), the wallet proves in the
> browser but has not been clicked through on a live chain here, and nothing is externally audited. Not for production. See
> [`docs/roadmap.md`](docs/roadmap.md) and [`docs/circuit-audit.md`](docs/circuit-audit.md).

## Layout
```
privacy-protocol/
├─ docs/        protocol-spec-v1.0 (normative) · crypto · vault · threat-model · security-invariants · circuit-audit · privacy-lab · roadmap
├─ contracts/   Foundry — immutable PrivacyCore + vaults + factory + Poseidon2 + verifier + deploy script   [87/87 tests ✅ incl. e2e]
├─ circuits/    circom — 2-in/3-out transaction, Poseidon2, KAT, soundness harness, dev setup             [compiled + proven ✅]
├─ reference/   typescript (vectors, witness builder, prover, envelope, chain keys, scorecard, reorg indexer, WASM cross-check) · python (differential) [72/72 ✅ · 31/31 ✅]
├─ frontend/    Vite+React+viem wallet: encrypted keystore + recovery phrase + journal, shield/send/**receive**/withdraw/**swap privately**/**Private AI** in ETH and every ERC-20 with a vault, fresh per-chain addresses, RPC quorum + relayer failover, scorecard on every action, guest mode; proofs in a Web Worker; the Rust core (WASM) does the sync batches when served, the TypeScript reference otherwise [57 tests ✅ · builds ✅]
├─ core/rust/   privacy-core — the shared native crypto core (Poseidon2, notes, Merkle, envelope, address, keystore + BIP-39 + chain keys) for mobile / desktop / WASM, pinned to the same vectors; privacy-core-wasm — its wasm-bindgen package (incl. the two sync batches: every tree layer, note discovery over every payload), checked against the TypeScript from node   [14 suites ✅ · wasm32 ✅ · WASM == TS 9/9 ✅]
├─ services/relayer/  private submission (proven transact from its own key, paid by a private fee note) + swap-order executor (deploy/execute/refund escrows for the tip) — 23 tests vs forge fixtures, durable journals, abuse limits   [tests ✅]
├─ services/    private-swap (engine + THORChain/LI.FI adapters, live-tested) · zkapi-lab (mainnet pin verifier)  [V1.1]
└─ benchmarks/  gas (live cost tool) · privacy (the study's adversary vs this design) · proof · mobile
```

**V1.1 (in progress — plan "zkAPI + Privacy Wallet + Cross-Chain Swap")**: the money core is frozen;
two new layers sit beside it and can fail without touching it (plan §85):
- **Private swaps** — [`docs/private-swap-spec-v1.1.md`](docs/private-swap-spec-v1.1.md): a private
  withdrawal pays a counterfactual `SwapOrderEscrow` (periphery); a relayer executes the provider call
  that the order's one-time key signed; failures re-shield into the pool. `contracts/src/periphery/swap`
  (18 tests incl. provider compromise: a malicious provider can take only that order's balance), and
  `services/private-swap` (engine, scoring with incident feed, privacy score; all six provider adapters
  quote **live** — THORChain, Chainflip, Mayan, LI.FI, Across bridge, NEAR Intents (quote-only)).
- **Private services (zkAPI)** — [`docs/zkapi-integration-spec.md`](docs/zkapi-integration-spec.md):
  zkAPI as expiring service credit, never money. Studied and reproduced: [`docs/zkapi/`](docs/zkapi/)
  (architecture, protocol, security assessment, **mainnet + Sepolia pins verified 23/23** incl. a
  byte-exact rebuild of the deployed vault and verifier; [`reproduction.md`](docs/zkapi/reproduction.md):
  SDK 309/309, contracts 29/29, Rust 45/45 + 67/67 runnable, shipped WASM proofs verified natively,
  our own WASM rebuild gives byte-identical bindings; the live e2e is blocked by this machine's Winsock LSP).

## Status (this environment)
| Part | Verified |
|------|----------|
| contracts | **87/87 forge**: 45 mock-based (5 fuzz invariants, token zoo, issuer isolation, reentrancy matrix, no-privilege bytecode scan incl. periphery) + Poseidon2 KAT 5 + real verifier 8 + **end-to-end 10** (four real proofs: withdrawal with a private fee note, the relayer spending it, **a note exiting to a swap-order escrow, and the order's refund note being spent**) + swap periphery 19 |
| circuits | compiled (23,343 constraints, 14 public inputs); KAT **18/18**; soundness **17/17**; Groth16 harness **14/14** |
| reference | TypeScript **63/63** vitest (incl. reorg indexer, amount engine, the **layered Merkle view** (one hashing pass for the root and every path), **wallet-side prover against the real artifacts**, the **payload envelope + privacy address** with pinned vectors, the **Chain Key Abstraction** against the BIP-84 / SLIP-0010 / Phantom vectors, the **privacy scorecard**); Python **31/31** vectors; **Rust core 14/14 suites** (`core/rust`: the same vectors plus the web wallet's keystore / journal / BIP-39 / chain-key vectors, the layered tree, batch discovery), and its **WASM package reproduces the TypeScript reference 9/9 from node** (Poseidon2 ≈ 8× faster than BigInt; a whole tree sync ≈ 10×, discovery ≈ 4×); five implementations agree on every primitive |
| frontend | `tsc -b` clean + `vite build` → `dist/` (main + proving worker); **57/57 vitest** (**the Rust core in the browser**: sync / discovery / planning through the WASM batches give the same tree, notes and witness as the TypeScript path, which also runs when no package is served; **private ERC-20 assets + per-vault fee terms + relayer failover**, **capability failures at the wallet**, **keystore / phrase / encrypted journal / backup**, **fresh per-chain addresses** incl. a viem cross-check, **RPC endpoint quorum** vs a stale endpoint, **first launch without a network request** (happy-dom), **randomized scheduling**, zkAPI policy, fresh funding provider signing vs a mock RPC, tree sync vs the reference tree, **note discovery from encrypted payloads**, withdrawal planning incl. the **relayer fee note** and **multi-note merges**, relayer client); **client-side proving**: the normative prover (`reference/typescript/src/prover.ts`) reproduces the forge-verified e2e public inputs and proves a fresh withdrawal in ~1 s (`test/prover.test.ts`); shield / send / withdraw / fund-escrow are wired end to end through the Web Worker and the injected wallet (type-checked; not clicked here — no browser or chain on this machine) |
| privacy lab | amount unique-link **0.00 %** (Nova-like 11.5 %); joint effective anonymity **10 → 349 / 1,073**; **cross-chain lab**: the swap leg is only as private as the provider's cover traffic (bucketed, native-chain class: joint set 5.9 at 100 swaps/h, 1.2 at 5/h; arbitrary amounts ≈ linked) — the score says so now ([`docs/privacy-lab.md`](docs/privacy-lab.md)) |
| gas | `transact` 1.79M, `deposit` 1.52M; **live cost**: `node benchmarks/gas/cost.mjs` (≈ $0.75 / $0.64 at 0.15 gwei) |
| periphery (swap exit) | **19** forge (`contracts/test/periphery`) + no-privilege scan + **2 real-proof e2e tests** (pool → escrow → provider; pool → escrow → refund note → pool, spent with a real proof); TS endpoint/digest == forge vector |
| private-swap engine | **99/99** vitest: live THORChain, LI.FI, Chainflip, Mayan, NEAR Intents and Across quotes (provider calldata decoded/verified or built locally), **42 adversarial** (plan §71 matrix + §74 compromise with tampered provider responses), **3 cross-chain privacy-flow** tests (plan §72), order **restore** after a service restart, and the **walletless guest deposit** (plan §49: THORChain deposit address confirmed by the gateway quorum, memo with destination + locally built limit) — [`docs/test-matrix.md`](docs/test-matrix.md); `npx tsx src/cli.ts 1 SOL best-privacy` |
| relayer (private submission + swap executor) | `services/relayer`: **27/27** vitest — **fee notes in ERC-20 vaults** (fixed per-vault minimums, unknown vaults refused) and the forge-verified e2e transaction (0.05 ETH private fee note to the relayer) is validated (domain, payload hashes, fee note opening, live minimum fee, in-flight nullifiers), simulated, signed from the relayer's own key and broadcast on a mock chain; the swap executor predicts the escrow exactly like forge, admits only an execution signed by the order key with the committed refund payload, sends `deployAndExecute` once funded and `deployAndRefund` after the window, marks expiry, accepts a re-signed execution for an expired order, watches ERC-20 escrows, and resumes from its file journal after a restart; reverting calls never spend gas ([`services/relayer/README.md`](services/relayer/README.md)) |
| Private AI (zkAPI) | the wallet's Private AI tab on the pinned zkAPI SDK, runtime-key mode, fresh funding address from the pool; assets built + verified, pin check **12 + 23 lab checks, 0 fail** on Sepolia; funded browser flow pending ([`docs/private-ai.md`](docs/private-ai.md)) |
| testnet / audits | deploy scripts dry-run (core + swap periphery; creation-code hash == artifact), runbook [`docs/testnet.md`](docs/testnet.md); audit package [`docs/audit-package.md`](docs/audit-package.md); broadcast + engagement pending |
| zkAPI lab | SDK 309/309, contracts 29/29, mainnet + Sepolia pins **23/23** each; Rust protocol 45/45, app 67/67 runnable (34 socket tests + e2e blocked by the machine's Winsock LSP — `docs/zkapi/reproduction.md`) |

## Quickstart
```
# contracts (local solc + offline — see contracts/README.md for why)
cd contracts && FOUNDRY_OFFLINE=true forge test --use <solc-0.8.24> -vv

# references
cd reference/typescript && npm install && npm test && npm run vectors && npm run fixtures
cd reference/python && python test_vectors.py

# circuit — needs a circom 2.x binary; full pipeline in circuits/README.md
cd circuits && npm install

# everything offline in one go (+ --live for the provider suites, --forge <solc> for the contracts, --rust for the core): 10/10 here
node scripts/verify-all.mjs --forge $SOLC --rust    # CARGO / WASM_BINDGEN env point at the offline toolchain (docs/mobile.md)
# run order for a workstation with a browser and a chain: docs/local-run.md (.env.example in frontend/, services/relayer/, services/private-swap/)

# frontend (+ the local swap service the Swap tab talks to)
cd frontend && npm install && npm run build
cd services/private-swap && npm run serve

# benchmarks
node benchmarks/gas/cost.mjs          # live gas price × measured gas
node benchmarks/privacy/run.mjs       # the study's adversary vs the shipped wallet policy (~1 min)

# V1.1 services
cd services/private-swap && npm install && npm test && npx tsx src/cli.ts 1 BTC best-privacy
cd services/zkapi-lab && npm install && node verify-mainnet.mjs mainnet
```

## How it answers the study's findings
- **TC-01** mutable frontend / note-at-rest → frontend-independent client; raw secret never in
  dapp-origin storage (`frontend/src/keys`).
- **TC-02 / TC-03 / TC-12 / TC-18** governance + bridge → removed from the V1 TCB (immutable core,
  L1 only; proven by the no-privilege bytecode scan, `contracts/test/invariants/NoPrivilege.t.sol`).
- **TC-09 / TC-20** trusted setup → pluggable, immutable verifier; real ceremony later (`docs/crypto-spec.md`).
- **TC-10 / TC-14** root-history cliff → block-based root window + a reorg-aware wallet indexer.
- **TC-11** relayer gas-drain → claimable-fallback payout; relayer fee is a private note (no public relayer field).
- **TC-17** key-registration deanon → no on-chain address↔key registry.
- **TC-19 / TC-22** token accounting + nullifier footgun → strict balance-delta; 1:1 nullifier derived from the key.
- **Timing × amount collapse** (the study's central privacy result) → bucketed public amounts,
  delay floors, fresh addresses; measured in `docs/privacy-lab.md`.
- **+ new**: asset-issuer freeze is isolated to its own vault (`contracts/test/issuer-risk`).

The circuit review found and fixed **PP-C01 (critical)** — anyone who knew a note's opening could
spend it under any key — plus PP-C02/C03 and the privacy defects **PP-P01/P02** (no per-note secret;
observable phantom inputs). All have executed regressions; see [`docs/circuit-audit.md`](docs/circuit-audit.md).

## Mobile / desktop
The shared core is built (`core/rust`, `docs/mobile.md`) and now covers the whole key surface — keystore + recovery phrase + journal ([`docs/wallet-formats.md`](docs/wallet-formats.md): a backup made in the browser opens in the native wallet), BIP-44 / BIP-84 / SLIP-0010 chain keys — with a WASM package for the web; the React Native and Tauri shells need the platform toolchains (Xcode / Android Studio / MSVC) and are the next step on a workstation.

## Non-goals (V1)
No bridge, governance, DAO, proxy/upgrade, AMM/lending, NFTs, arbitrary private calls, cross-chain,
or central compliance gate. No production verifier/ceremony/audit yet.
