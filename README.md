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
├─ apps/
│  ├─ web/          the wallet (V6, spec v2.0): Home / Swap / Activity / More on packages/ui, Protect / Send / Receive, Swap with one confirmation, the $50K protected steps, the Privacy Center, Classic Privacy (mock pool), Korean and the language picker, the desktop layouts; the platform: the encrypted IndexedDB container, the long-lived crypto worker with pinned and cached artifacts, auto-lock, connectivity; lazy routes under a performance budget; the screenshot fixtures   [508 + 9 leakage + 6 live ✅]
│  ├─ api/          V6: Express 5 + node:sqlite over the swap engine — quotes, operations (swaps only), reconcile, the guest and gateway routes; no secret, balance or address stored; retention; privacy-safe logs   [26 ✅]
│  └─ relayer/      private submission (proven transact from its own key, paid by a private fee note; V6: the 1 % rule on every withdrawal, the actual gas recorded, a job found by its nullifier) + the swap-order executor + V6's shield executor (same-chain swaps into the protected balance), ERC-20 fee vaults, durable journals, the server kit's edge   [59 ✅]
├─ packages/
│  ├─ protocol-types/ the frozen types of spec v2.0 (assets, chains, deployments, quotes, the assessments, the operation states)
│  ├─ config/       the chain and asset registries (the only place a network or a token is named)
│  ├─ contracts/    forge's ABIs and creation code, the deployment check and its fingerprint
│  ├─ sdk/          the wallet engine out of apps/web (V6 Stage 4): the session, keystore and encrypted journal, notes, private transactions, swap orders and campaigns, the operation records with their catalog and recovery logic — behind the doc §61 facade (src/index.ts); the platform passes its store and prover to configure()
│  ├─ wallet-engine/ the public wallet's connection (EIP-6963, injected, WalletConnect on request) and the doc §15 names
│  ├─ privacy-engine/ the one network edge: the HTTP transport's policy and the PrivacyTransport every chain read goes through (the only viem client constructor); the privacy score
│  ├─ risk-engine/  assessRisk(facts) → {score, level, blockers, warnings}: the eight doc §48 blockers
│  ├─ ui/           the design system (V6 Stage 5): the tokens (eight type roles in rem, calm light / dark / high-contrast sets, self-hosted Inter), icons, the wrapped Radix primitives, the doc §9 components (the hold with its dialog alternative; dialogs give the focus back), the patterns (FlowCard, FeeLines, ReviewLayout, StateScreen, AddressChip, AmountText, StickyAction), the shell (one bar at a time: the phone's bottom bar, the desktop's top bar with its Wallet menu), the component preview (React as a peer)   [49 ✅]
│  ├─ server-kit/   V6: the typed logger (a value without its field's shape is redacted), the rate limiter, the headers and CORS — shared by apps/api and apps/relayer   [9 ✅]
│  ├─ protocol/     the TypeScript reference (vectors, witness builder, prover, envelope, chain keys, scorecard, reorg indexer, WASM cross-check; V2: valuation + tiers, the Privacy Center model, destinations, the privacy lint, the housekeeping planner; V3: the campaign core — the tranche splitter, the exposure accounting with its invariants, the settlement gates, pause detection and the reducer —, the risk classes, the address book; V4: the exposure policy — the §4 cap table, the exposure tiers R0–R4, the impact remedies, the velocity window —, the six-component privacy assessment, I6 and the ledger, the destination's approval step; the campaign lab's benchmark knobs and the policy benchmark)  [158/158 ✅]
│  └─ swap-engine/  the private-swap engine (engine + six live adapters; V2: five policies, execution plans incl. THORChain streaming / Chainflip DCA / Mayan swap & lock, the competition record, health memory, the price guard, the valuer, tracking, the zkAPI gateway interface; V3: the risk database, the security breakdown, the breaker's triggers, the protection recommendation, the execution window)  (its HTTP layer becomes apps/api in V6 Stage 9)
├─ privacy-core/    privacy-core — the shared native crypto core (Poseidon2, notes, Merkle, envelope, address, keystore + BIP-39 + chain keys) for mobile / desktop / WASM, pinned to the same vectors; privacy-core-wasm — its wasm-bindgen package (incl. the two sync batches: every tree layer, note discovery over every payload), checked against the TypeScript from node; privacy-prover — the native witness (the circuit's WASM under a pure-Rust interpreter) + Groth16 prover over the same proving key, its proofs verified by the on-chain verifier; privacy-ffi — both behind UniFFI (Swift / Kotlin / Python generated)   [14 suites + prover 12 + Python bindings 11 ✅ · wasm32 ✅ · WASM == TS 9/9 ✅]
├─ contracts/       Foundry — immutable PrivacyCore + vaults + factory + Poseidon2 + verifier + deploy scripts; periphery: the swap escrow, V6's ProtectRouter and ShieldReceiver   [146/146 tests ✅ incl. e2e + native-prover proofs]
├─ circuits/        circom — 2-in/3-out transaction, Poseidon2, KAT, soundness harness, dev setup             [compiled + proven ✅]
├─ reference/       python (the differential reference: Poseidon2, the primitives, the vectors)   [31/31 ✅]
├─ tools/           zkapi-lab (mainnet pin verifier) · crate vendoring for the offline Rust build
├─ scripts/         verify-all.mjs (every suite in one command) · **local-stack/** (the whole stack on one workstation + the browser run of the V2 flows and of a V3 protected swap)
├─ tests/           **visual/** (V6: the screenshot harness — the fixtures in Chrome at four viewports against reviewed baselines, the layout at the ten sizes, the acceptance checks of doc §86–§92, the accessibility passes; `verify-all --browser`) · **high-value/** (V4: the plan's §116 tree over the pure modules — order, quote, exposure with the §117 property test, tranche, rfq, streaming, routing, settlement, recovery, provider-failure, privacy, mobile, adversarial chaos)   [62/62 ✅]
├─ docs/            protocol-spec-v1.0 (normative) · private-swap-spec-v1.1 (normative) · **whale-execution-spec-v1.0 (normative, V2)** · **high-value-protection-spec-v1.0 (normative, V3)** · **high-value-execution-contract-v1.0 (normative, V4)** · HighValuePolicyBenchmark (generated) · zkapi-integration-spec · wallet-formats · crypto · vault · threat-model · security-invariants · circuit-audit · privacy-lab · test-matrix · audit-package · roadmap · **privacy-wallet-web-spec-v2.0 (normative, V6)**
└─ benchmarks/      gas (live cost tool) · privacy (the study's adversary vs this design, incl. the cross-chain and streamed-settlement rows) · whale (V2: public large-swap research, the live execution lab $100K–$25M per provider, the whale UTXO strategy lab; V3: the campaign lab — 192 campaigns $1M–$50M, 13 faults, ELPF; V4: the policy benchmark — one execution vs 5 % vs 2.5 % vs 1 %, the §119 conditions, the §120 privacy matrix, the §123 default) · proof · mobile
```

**V1.1 (in progress — plan "zkAPI + Privacy Wallet + Cross-Chain Swap")**: the money core is frozen;
two new layers sit beside it and can fail without touching it (plan §85):
- **Private swaps** — [`docs/private-swap-spec-v1.1.md`](docs/private-swap-spec-v1.1.md): a private
  withdrawal pays a counterfactual `SwapOrderEscrow` (periphery); a relayer executes the provider call
  that the order's one-time key signed; failures re-shield into the pool. `contracts/src/periphery/swap`
  (18 tests incl. provider compromise: a malicious provider can take only that order's balance), and
  `packages/swap-engine` (engine, scoring with incident feed, privacy score; all six provider adapters
  quote **live** — THORChain, Chainflip, Mayan, LI.FI, Across bridge, NEAR Intents (quote-only)).
- **Private services (zkAPI)** — [`docs/zkapi-integration-spec.md`](docs/zkapi-integration-spec.md):
  zkAPI as expiring service credit, never money. Studied and reproduced: [`docs/zkapi/`](docs/zkapi/)
  (architecture, protocol, security assessment, **mainnet + Sepolia pins verified 23/23** incl. a
  byte-exact rebuild of the deployed vault and verifier; [`reproduction.md`](docs/zkapi/reproduction.md):
  SDK 309/309, contracts 29/29, Rust 45/45 + 67/67 runnable, shipped WASM proofs verified natively,
  our own WASM rebuild gives byte-identical bindings; the live e2e is blocked by this machine's Winsock LSP).

**V2 (done 2026-10-08 — plan "Privacy Wallet & Private Settlement Platform V2")**: the whale execution
layer, spec first — [`docs/whale-execution-spec-v1.0.md`](docs/whale-execution-spec-v1.0.md) (the 25
sections of plan §137) — then ten stages on `main` (`docs/roadmap.md`, V2 table): whale labs
(`benchmarks/whale/`), USD valuation and tiers through the wallet's own RPC quorum, the engine's
policies / execution plans / competition record / health memory / price guard / tracking, the four-tab
wallet with the Privacy Center and Activity, destinations + pre-trade simulation + privacy lint, the
high-value Review (hold, second factor, review hold, export), settlement tracking, private balance
maintenance, "Check this trade" and the zkAPI gateway interface (blocked upstream). Nothing in
`PrivacyCore`, the vaults, the circuits or the escrow bytecode changed; UniswapX is deferred (spec §11).

**V3 (done 2026-10-08 — plan "High-Value Privacy & Whale Protection V3")**: a large order is never one
escrow and one external execution any more. Spec first — [`docs/high-value-protection-spec-v1.0.md`](docs/high-value-protection-spec-v1.0.md)
(19 sections) — then eight stages on `main` (`docs/roadmap.md`, V3 table): the shared campaign core
(`packages/protocol/src/wallet/campaign.ts`: tranches from the bucket alphabet inside a band, the in-flight
cap with invariants I1–I5, the settlement gate per risk class with an elapsed-time margin, pause detection, one
pure reducer), the labs (`benchmarks/whale/campaign.md`: 192 campaigns, 13 injected faults reaching at most one
tranche, ELPF), the service's risk layer (`packages/swap-engine/risk/`: a risk database, a security score with
separate fields, the breaker's new triggers, a protection recommendation on every large quote), the wallet's
campaign runner (one action per tick from the App-level scheduler: reconcile, track, decide, act — a funding or a
hand-over is never sent twice), the screens (the wizard, the campaign Review with the maximum-loss model and the
paired SECURITY + PRIVACY verdict, the progress panel, the exposure dashboard, the global switch, the separate
device at institutional), the address book with its verification methods, cooling-off and Immediate override,
allowance read and revoke, and the browser run of a $10M protected swap on the local stack. Nothing in
`PrivacyCore`, the vaults, the circuits or the escrow bytecode changed; the service holds no per-user state;
UniswapX / OTC, multi-device approval and push notifications stay deferred as interfaces (spec §19).

**V4 (done 2026-10-08 — plan "High-Value Execution Engine V1.0")**: the implementation contract the plan asked for first —
[`docs/high-value-execution-contract-v1.0.md`](docs/high-value-execution-contract-v1.0.md) (the engine map, the policy table
and the exposure tiers R0–R4, the twelve frozen types verbatim from the code, the state machines with the plan's §70 names,
the §113–§115 invariant lists each with the test that executes it, the phases) — then the deltas over V3 in six stages on
`main` (`docs/roadmap.md`, V4 table): the policy core (`packages/protocol/src/wallet/exposurePolicy.ts`: the §4 cap table
per value band, exposure tiers derived from the risk class and the live facts, the effective cap, the impact remedies, the
velocity window; `privacyAssessment.ts`: six linkabilities measured from stated facts; I6 — a provider's in-flight share
bounded — and the plan's §26 ledger; the destination's approval step and its staleness), the service (the plan's §43 scoring
presets as policies, PAES beside the total, every quote normalized to the eight §42 fields, the recommendation's exposure tier,
the §4 caps, the impact remedy, the 30 % share cap), the wallet (the fraction 1–5 % with the band's ceiling, Maximum Safety
1 %, the fourth mode Best Execution, the deliberate opt-out, the Protected policy at $100K–$1M on request, concentration and
velocity; the runner's confirmed state, unknown / reconnecting, the reorg rule, the velocity pause), the screens (the EXECUTION
verdict line, "Cross-chain settlement is not atomic", the first-time explanation, "Executing in protected steps", Home's
Protection line, the Activity row, approve / re-check in the address book), the plan's §116 tests tree (`tests/high-value/`,
with the §117 property test over 1,000 random campaigns and the §118 chaos test) and the policy benchmark
([`docs/HighValuePolicyBenchmark.md`](docs/HighValuePolicyBenchmark.md): one execution vs 5 % vs 2.5 % vs 1 % over $1M–$50M —
at $10M on ETH → BTC one execution reaches the whole order in 4.5 h, 2.5 % reaches at most ≈ $180K in 137 h, 1 % ≈ $77K in
349 h; the stated §123 rule keeps 2.5 %). Nothing in `PrivacyCore`, the vaults, the circuits or the escrow bytecode changed;
UniswapX (the R1 controlled-RFQ tier), multi-device approval and push notifications stay deferred (contract §10).

**V5 (done 2026-10-08 — plan "Privacy Wallet Web V1")**: the web wallet rebuilt as a mobile-first product on its own design
system and shell, every engine underneath unchanged — [`docs/privacy-wallet-web-spec-v1.0.md`](docs/privacy-wallet-web-spec-v1.0.md)
first, then thirteen stages on `main` (`docs/roadmap.md`, V5 table): the design system (tokens, wrapped Radix primitives, inline
icons, the component inventory, a gallery under axe), the encrypted IndexedDB container with byte-identical formats and a
one-time migration, the shell (react-router; Home / Swap / Activity / More; Welcome → the experience → Create at first launch),
the wallet connection (EIP-6963, a lazy WalletConnect) and the transport policy (credentials omitted, redirects refused, a host
allow-list, one module for every request), the fee engine (the relayer's percentage privacy fee through the fee note,
exact-input / exact-output, the executor tip as a swap's privacy fee) and the consumer bands ($20K review, $50K protected
execution in four quarters) below the V4 tiers, the operation state machine (twenty states, one journaled record per Protect /
Send / Swap, the error catalog with its funds classes, recovery without a blind retry), Protect / Send / Receive / Swap /
Activity rebuilt on the record, More (Security, Wallet, Advanced), the Privacy Center on computed facts, Classic Privacy on a
mock pool behind a frozen interface, and the gates — the privacy leakage suite through the real engine, lint over all of
`src`, the content security policy and the headers, artifacts pinned and checked by the prover worker, the dependency audit,
locale detection with a pseudo-locale, screen-level axe — with the local stack's browser run across five viewports. Nothing in
`PrivacyCore`, the vaults, the circuits or the escrow bytecode changed; the services hold no portfolio, address list or
identity; the AI never signs; the §81 monorepo move, the native shells, the Classic contracts and circuit port, UniswapX and
multi-device approval stay deferred (spec §23).

**V6 (done 2026-10-14 — the owner's complete document "Privacy Wallet Web V1 — Core Product → UX → Application → Privacy →
Swap → Security → Production", §1–§96)**: the wallet a first-time user can understand, spec first —
[`docs/privacy-wallet-web-spec-v2.0.md`](docs/privacy-wallet-web-spec-v2.0.md) — then eighteen stages on `main`
(`docs/roadmap.md`, V6 table; the evidence for every line of the doc's Definition of Done:
[`docs/definition-of-done-v6.md`](docs/definition-of-done-v6.md)). The owner's six decisions:
1. **The full monorepo** (`apps/`, `packages/`, `privacy-core/`).
2. **1 % everywhere**: the privacy fee on the input through one fee note, the relayer enforcing it on every withdrawal,
   and **ProtectRouter** for Protect.
3. **`apps/api`**: Express 5 + node:sqlite; swaps only get server records.
4. **Swaps with one confirmation**: the order runner funds, checks, signs and hands over, and asks again only if the
   price got worse.
5. **Same-chain swaps into the protected balance** through a one-time **ShieldReceiver**.
6. **A CI workflow.**

On top of them:
- the design system V6 and the five core screens as pure Views on fixtures, under a screenshot harness and the Golden UX
  rule's vocabulary scan;
- the operation contract (fifteen states and CANCELLED, I-O6, I-O7, the settlement states);
- protection from $50,000 without a mode to choose;
- the Privacy Center's seven sections and Classic Privacy behind its own boundary;
- hardening: auto-lock with holds, offline with a lost answer found by its nullifier, the long-lived crypto worker with a
  cached and pinned proving key, the bundle scan, the services' headers;
- the desktop layouts, Korean complete with a language picker, accessibility (axe on every fixture state, the keyboard
  paths, a dialog alternative to holding, 200 % text, more contrast, forced colours), and a performance budget.

Nothing in `PrivacyCore`, the vaults, the circuits or the escrow bytecode changed. The services hold no portfolio,
address list or identity. The React Native apps, the Classic contracts and the legal review, external audits, the
ceremony and a testnet broadcast stay with the owner (spec v2.0 §23).

## Status (this environment)
| Part | Verified |
|------|----------|
| contracts | **146/146 forge** (V6: ProtectRouter 20 — `fee + net == gross` for every gross, the vault from `vaultOf`, fee-on-transfer and false-return tokens, re-entry, the fuzz; ShieldReceiver 15 — predict = deploy, the 2300-gas send before and after deployment, dust, WETH, foreign and unsupported tokens, re-entry, the fuzzed accounting, the vector shared with TypeScript; the periphery gas bench; the e2e deployment fixture pinned). Before V6, 107: 47 mock-based (5 fuzz invariants, token zoo, issuer isolation, reentrancy matrix, no-privilege bytecode scan incl. periphery, the pool's storage slots and the nullifier mapping pinned for the light client) + Poseidon2 KAT 5 + real verifier 8 + **end-to-end 10** (four real proofs: withdrawal with a private fee note, the relayer spending it, **a note exiting to a swap-order escrow, and the order's refund note being spent**) + swap periphery 32 (incl. an ERC-20 order paid to a plain deposit address with the token's own transfer, a USDT-like order that executes, tips and refunds, a token a provider paid back in re-shielded into its canonical vault, provider refunds that fit the gas THORChain and Chainflip forward, an ETH order refunded in WETH — Across' refund form — unwrapped and re-shielded, and a USDC order paid back in WETH or ETH re-shielded as ETH) + **native-prover proofs 5** (proofs made by `privacy-core/privacy-prover` accepted by the same verifier) |
| circuits | compiled (23,343 constraints, 14 public inputs); KAT **18/18**; soundness **17/17**; Groth16 harness **14/14** |
| reference | TypeScript **173/173** vitest (V6: the fee formulas of spec v2.0 §3 — the §80 matrix, inverses and minimality over 10k seeded cases, bigint only —, the settlement states and the doc §82 scenarios, the privacy timing; V5: the fee formulas, the consumer bands in the ladder and the exposure policy, the classic note's vectors; V4: the exposure policy, the privacy assessment, I6 and the ledger, the approval step; V3: the campaign core, the risk classes, the address book, the campaign lab; incl. reorg indexer, amount engine, the **layered Merkle view** (one hashing pass for the root and every path), **wallet-side prover against the real artifacts**, the **payload envelope + privacy address** with pinned vectors, the **Chain Key Abstraction** against the BIP-84 / SLIP-0010 / Phantom vectors, the **privacy scorecard**); Python **31/31** vectors; **Rust core 14/14 suites** (`privacy-core`: the same vectors plus the web wallet's keystore / journal / BIP-39 / chain-key vectors, the layered tree, batch discovery) and the **native witness + Groth16 prover 12/12** (`privacy-core/privacy-prover`: the native witness equals snarkjs' for every fixture and reproduces the soundness manifest's verdicts, the snarkjs proving key parsed to the published verification key, native proofs ⇄ snarkjs proofs verified both ways, calldata identical; inputs → proof ≈ 0.6 s native vs ≈ 1.1 s snarkjs), and the **UniFFI bindings 11/11 from Python** (`privacy-core/privacy-ffi`: the generated surface the Swift / Kotlin apps call, held to the same vectors and producing the forge-verified proof bytes), and its **WASM package reproduces the TypeScript reference 9/9 from node** (Poseidon2 ≈ 8× faster than BigInt; a whole tree sync ≈ 10×, discovery ≈ 4×); five implementations agree on every primitive |
| web wallet | `apps/web`: **515/515 vitest + 9 leakage + 6 live**, the build under the performance budget (the first route 185.6 KB gzipped of 250, Home +33.1 KB of 80; snarkjs and the WASM only when needed), the bundle scan, the screenshot harness (**189 screenshots** against reviewed baselines, 363 layout checks at ten sizes, 124 acceptance and accessibility checks). **V6**: the five core screens as pure Views on fixtures, Protect / Send / Swap with one confirmation / the $50K steps / Activity windowed / the Privacy Center / Classic / More on the new screens, the operation contract under 2,000 random sequences, auto-lock, offline and the lost answer, the crypto worker's boundary, Korean complete with the picker and no English on a Simple screen read in Korean, the desktop parity, axe on every fixture state with the keyboard paths and the hold's dialog. Before V6, 406 (**V5**: the design system under axe, the secure store and the migration, the shell and the first launch with zero requests, the connection and the transport, the fee engine and the bands, the operation machine under 2,000 random sequences, Protect / Send / Swap / Activity / More / the Privacy Center / Classic on the record, the privacy leakage gate through the real engine, the policy, the pins, the locale and the pseudo-locale, fourteen screens under axe; **V4**: the runner's confirmed state, unknown / reconnecting, the reorg pause, the velocity pause, the user-cap rules per exposure tier; the EXECUTION line and the §69 sentence, the opt-out, the knobs, the address book's approval; **V3**: the campaign runner against a scripted world, the protection screens, the $1M / $5M / $10M flows against the real engine and risk layer, the address book on the screens, allowances through the injected provider; **V2**: the four-tab shell makes zero requests at first launch; a $3.4M review flow against the real engine with Chainlink on the mock RPC — the hold, the second factor, the institutional hold; the pre-trade simulation on mock endpoints; settlement tracking; housekeeping; the sanitized trade check) (**the swap service cannot redirect money or signatures**: the escrow recomputed by CREATE2 == the forge vector, an honest engine order passes, ten ways to bend one are refused, the order key signs only the digest of the call shown; **the wallet reads the provider call before signing**: pinned contracts, the fresh address as receiver, refunds to the escrow, the approved minimum (a lower one needs consent), THORChain's vault from the wallet's own gateway quorum, honest calls built with the service adapters' own encoders, every tamper refused, and the Swap screen clicked through against the real engine (happy-dom): a bent call refused with nothing signed and the order returned to the private balance by a refund-only job, a lower minimum signed only after consent; **a guest's deposit instruction checked in the browser before it is shown** (vault from the gateways, typed destination, OP_RETURN size, quoted minimum); **an Ethereum light client proves the pool before every transaction**: sync committees with BLS on a synthetic chain offline and on mainnet (Fulu) + Sepolia (Gloas) live, incl. a two-period walk across the Gloas fork, the execution header by hash, storage proofs, and every bent link refused; **the Rust core in the browser**: sync / discovery / planning through the WASM batches give the same tree, notes and witness as the TypeScript path, which also runs when no package is served; **private ERC-20 assets + per-vault fee terms + relayer failover**, **capability failures at the wallet**, **keystore / phrase / encrypted journal / backup**, **fresh per-chain addresses** incl. a viem cross-check, **RPC endpoint quorum** vs a stale endpoint, **first launch without a network request** (happy-dom), **randomized scheduling**, zkAPI policy, fresh funding provider signing vs a mock RPC, tree sync vs the reference tree, **note discovery from encrypted payloads**, withdrawal planning incl. the **relayer fee note** and **multi-note merges**, relayer client); **client-side proving**: the normative prover (`packages/protocol/src/prover.ts`) reproduces the forge-verified e2e public inputs and proves a fresh withdrawal in ~1 s (`test/prover.test.ts`); shield / send / withdraw / fund-escrow are wired end to end through the Web Worker and the injected wallet (type-checked; not clicked here — no browser or chain on this machine) |
| local stack (browser) | [`scripts/local-stack`](scripts/local-stack/README.md): **V6**: at every stage that changed the flows (`results/report-2026-10-13-v6-stage1.json` … `results/report-2026-10-14-v6-stage16.json`); the final run on the V6 code: **212/212** (`results/report-2026-10-14-v6.json`; the first full run that day, 209/212, met a market that moved past the $10M campaign's bound and an $80K step that landed seconds after the harness's wait) — Welcome → Create, Protect 5,000 USDC (4,950 + 50 read on chain), Send 2,500 (exactly 2,470.90 received), the large Reviews, ETH → BTC with one confirmation, USDC → ETH into the protected balance through a ShieldReceiver, the $80,000 protected steps, the $10M campaign, the viewport matrix and the pseudo-locale, reload / tab close / browser restart / offline / a disconnected wallet, the leakage twin. **V5** (2026-10-08, after the V5 stages): **166/166** checks; the follow-up run of 2026-10-13 after the relayer executor's fix: **167/167** (`results/report-2026-10-13-v5.json`) — the money flow on the rebuilt screens (Welcome → Create, Protect, Send ×2 with the exact-input fee, the $850K swap through the order panel, the reload, Activity), the $10M protected swap on the new screens, the viewport matrix (1280x800, 1440x900, 360x800, 390x844, 412x915, 768x1024) with the pseudo-locale pass, the leakage twin; the V4 run: 48/48 (`results/report-2026-10-08-v4.json`), the V3 run: 35/35 |
| privacy lab | amount unique-link **0.00 %** (Nova-like 11.5 %); joint effective anonymity **10 → 349 / 1,073**; **cross-chain lab**: provider cover traffic would hide an arrival only with bucketed amounts and high traffic (native-chain class: joint set 5.9 at 100 swaps/h, 1.2 at 5/h; arbitrary amounts ≈ linked) — but every adapter publishes the escrow → destination link anyway, and that link reaches only the privately funded escrow, so a swap is exactly as private as its pool withdrawal; the score multiplies the two links instead of taking the worse ([`docs/privacy-lab.md`](docs/privacy-lab.md), correction of 2026-10-07) |
| gas | `transact` 1.79M, `deposit` 1.52M; **live cost**: `node benchmarks/gas/cost.mjs` (≈ $0.75 / $0.64 at 0.15 gwei) |
| periphery (swap exit) | **19** forge (`contracts/test/periphery`) + no-privilege scan + **2 real-proof e2e tests** (pool → escrow → provider; pool → escrow → refund note → pool, spent with a real proof); TS endpoint/digest == forge vector |
| private-swap engine | **103 offline + 107 live** vitest (V6: the gas-based tip, same-chain quotes into the protected balance, selection — the lowest fee, a partial quote refused; V5 and before: 85 offline + 107 live; V5: the $50K band's four exact quarters, the ladder's seven names; V4: the §43 presets, PAES, quote normalization, the recommendation's exposure tier / caps / remedy / share cap; V3: the risk database loader, the security breakdown, the breaker's triggers and half-open probe, the protection recommendation, the execution window; V2: the five policies and filters, the competition record, the health tracker and breaker, the valuer, the zkAPI gateway; THORChain streaming plans, Chainflip DCA and Mayan swap & lock live): live THORChain, LI.FI, Chainflip, Mayan, NEAR Intents and Across quotes (provider calldata decoded/verified or built locally), **the wallet's own check agrees on every call the engine prepares** (live), **56 adversarial** (plan §71 matrix + §74 compromise with tampered provider responses), **the Uniswap-Across leg** (Across's Swap API: a swap on Ethereum then the bridge, its periphery call and destination message read in full by the service and the wallet), **4 cross-chain privacy-flow** tests (plan §72, incl. **USDC-sourced orders**: no ETH forwarded, the provider pulls from the escrow, refunds re-shield into the USDC vault), the escrow call per ingress and asset, order **restore** after a service restart, and the **walletless guest deposit** (plan §49: THORChain deposit address confirmed by the gateway quorum, memo with destination + locally built limit) — [`docs/test-matrix.md`](docs/test-matrix.md); `npx tsx src/cli.ts 1 SOL best-privacy` |
| API | `apps/api`: **26/26** — the schema pinned, the routes (the §46 quote's keys, opaque ids), reconcile over the §82 legs, retention, security (CORS, headers, 413 / 415 / 429, a forged X-Forwarded-For ignored), the logs' allowed keys, the database after a full flow ([`apps/api/README.md`](apps/api/README.md)) |
| packages (V6) | sdk **94**, ui **49**, contracts **19**, server-kit **9**, risk-engine **7**, privacy-engine **6**, config **5**, protocol-types **4**, wallet-engine **3**; the package boundaries (`scripts/check-boundaries.mjs`, eight rules) |
| high-value tests tree | [`tests/high-value`](tests/high-value/README.md): **62/62** — V6: the $50K band's in-flight exposure property; V5: the ladder monotone with the consumer bands, the $50K quarter unmoved by tier and mode; the plan's §116 areas over the pure modules; the §117 property test (1,000 random campaigns and event sequences: I1, I2, I6 and the identity after every event), the §118 chaos test (36 random faults: invariants held, each step funded and handed over once, deterministic per seed), the §105–§112 scenarios, the §113–§115 lists (`docs/security-invariants.md`, V4) |
| policy benchmark | [`docs/HighValuePolicyBenchmark.md`](docs/HighValuePolicyBenchmark.md) (`node benchmarks/whale/run-policy.mjs`, gas at the live price): 72 rows, invariants held in every run; the §123 rule keeps **2.5 %** |
| relayer (private submission + swap executor) | `apps/relayer`: **59/59** vitest — V6: the 1 % rule on every withdrawal incl. a swap's escrow funding, the actual gas on the job, the shield executor against forge's vector, the edge (headers, CORS, rate limit by socket, 415), the logs, a job found by its nullifier; V5: the swap executor's one pass at a time (a hand-over's tick and the interval's never send an execution twice); the percentage privacy fee (the terms on `/info`, `fee_below_percent`, the escrow exemption, a transfer on the minimum only, the floor); V3: the job list behind `RELAYER_ADMIN_TOKEN`; **fee notes in ERC-20 vaults** (fixed per-vault minimums, unknown vaults refused) and the forge-verified e2e transaction (0.05 ETH private fee note to the relayer) is validated (domain, payload hashes, fee note opening, live minimum fee, in-flight nullifiers), simulated, signed from the relayer's own key and broadcast on a mock chain; the swap executor predicts the escrow exactly like forge, admits only an execution signed by the order key with the committed refund payload, sends `deployAndExecute` once funded (native ETH or the ERC-20) and `deployAndRefund` after the window (counting WETH an ETH order was paid back in), takes refund-only jobs for orders the wallet will not execute, re-shields a token a route swapped into through the escrow's `refundToken`, watches an executed order for 24 h past its window for a provider's late refund, marks expiry, accepts a re-signed execution for an expired order, watches ERC-20 escrows, and resumes from its file journal after a restart; reverting calls never spend gas ([`apps/relayer/README.md`](apps/relayer/README.md)) |
| Private AI (zkAPI) | the wallet's Private AI tab on the pinned zkAPI SDK, runtime-key mode, fresh funding address from the pool; assets built + verified, pin check **12 + 23 lab checks, 0 fail** on Sepolia; funded browser flow pending ([`docs/private-ai.md`](docs/private-ai.md)) |
| testnet / audits | deploy scripts dry-run (core + swap periphery; creation-code hash == artifact), runbook [`docs/testnet.md`](docs/testnet.md); audit package [`docs/audit-package.md`](docs/audit-package.md); broadcast + engagement pending |
| zkAPI lab | SDK 309/309, contracts 29/29, mainnet + Sepolia pins **23/23** each; Rust protocol 45/45, app 67/67 runnable (34 socket tests + e2e blocked by the machine's Winsock LSP — `docs/zkapi/reproduction.md`) |

## Quickstart
```
# contracts (local solc + offline — see contracts/README.md for why)
cd contracts && FOUNDRY_OFFLINE=true forge test --use <solc-0.8.24> -vv

# one install for every workspace (apps/*, packages/*: one root lockfile, checked by scripts/check-lockfile.mjs)
npm ci

# references
cd packages/protocol && npm test && npm run vectors && npm run fixtures
cd reference/python && python test_vectors.py

# circuit — needs a circom 2.x binary; full pipeline in circuits/README.md
cd circuits && npm install

# everything in one go (+ --live for the provider suites, --forge <solc> for the contracts, --rust for the core, the native prover and the FFI,
# --browser for the screenshot harness in Chrome, --ledger <file> for the per-step counts): 52/52 with --forge --rust --live --browser on 2026-10-14
node scripts/verify-all.mjs --forge $SOLC --rust --browser    # CARGO / WASM_BINDGEN env point at the offline toolchain (docs/mobile.md)
# the CI form (.github/workflows/ci.yml, on every push and pull request): node scripts/check-lockfile.mjs && npm ci && node scripts/verify-all.mjs --ci --forge 0.8.24
# run order for a workstation with a browser and a chain: docs/local-run.md (.env.example in apps/web/, apps/relayer/, packages/swap-engine/)

# the wallet (+ the API the Swap screen talks to and the relayer); Private AI needs the zkAPI clone beside this repository
# (or ZKAPI_SDK_DIR), else the build carries a stub that says so (docs/private-ai.md)
cd apps/web && npm run build
cd apps/api && npm start
cd apps/relayer && npm run serve

# benchmarks
node benchmarks/gas/cost.mjs          # live gas price × measured gas
node benchmarks/privacy/run.mjs       # the study's adversary vs the shipped wallet policy (~1 min)

# V1.1 services
cd packages/swap-engine && npm test && npx tsx src/cli.ts 1 BTC best-privacy
cd tools/zkapi-lab && npm install && node verify-mainnet.mjs mainnet
```

## How it answers the study's findings
- **TC-01** mutable frontend / note-at-rest → frontend-independent client; raw secret never in
  dapp-origin storage (`packages/sdk/src/keys`).
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
A wallet review found **PP-P03**: after a restore from the phrase alone the note counter started at 0
again, so new notes reused old notes' secrets, and a deposit publishes its secret, re-opening PP-P01's
dictionary attack on the old notes' amounts; a rescan now finds the wallet's own notes by their secrets
and moves the counter past them.

The swap-path review (2026-10-07) found and fixed five defects, each with a regression test
([`docs/security-invariants.md`](docs/security-invariants.md), periphery section):
**PP-S01** LI.FI's Across facet recomputes the bridged output on chain from a multiplier the engine
did not check, so a tampered API response could deliver about zero; **PP-S02** THORChain memos carried
no refund address, so a refund would have paid the relayer instead of the escrow; **PP-S03** LI.FI's
Mayan facet sweeps value to a recipient the engine did not check; **PP-S04** Across refunds an unfilled
ETH deposit as WETH, which the escrow could not re-shield; **PP-S05** the wallet took the provider
call's receiver and minimum on the swap service's word. Two more in guest mode: **PP-S06** the
walletless screen showed the service's deposit address and memo unchecked, so a dishonest service
could have named its own address; **PP-S07** a guest memo for a token target (BTC → USDC) was 109
bytes, over the 80-byte OP_RETURN a Bitcoin deposit can carry. **PP-S08**: LI.FI routed ETH → USDC (Base)
by swapping ETH into USDT on Ethereum and bridging USDT with the escrow as refund address, so an unfilled
deposit would have come back as USDT, which an ETH order's escrow could never re-shield; the escrow
now re-shields such a token into its canonical vault (`refundToken`), and the service and the wallet
accept a source swap only into a token the pool has a vault for. For an order in a token, WETH and ETH
need no vault: `refundToken` unwraps the WETH and re-shields both as ETH. **PP-S10**: an order in a token whose
`approve` / `transfer` return nothing (USDT) could neither execute nor refund, since the escrow's typed
calls reverted on the empty return. **PP-S11**: the executor closed an executed order as completed when
its escrow was empty at `refundAfter`, but Across refunds an unfilled deposit hours after its fill
deadline, after that point; executed orders are now watched for 24 h past the window. **PP-S12**: that
watch re-shielded any non-zero balance, though after execution no tip pays for a re-shield (a vault
deposit, about 1.5M gas): anyone could send 1 wei each tick to drain the relayer, and an order's owner
could do it with amounts that come back to them; the executor now sends at most three such re-shields
per order, each above its floor (twice its gas for ETH and WETH, 1% of the order for its own token, the
floor the wallet states for a listed token), and only into a vault the pool already has. **PP-S09**: a
refunded order's note never reached the wallet: the refund re-shields with the order's random payload,
which note discovery cannot open, so the funds were back in the pool but not in the balance; the wallet
now finds every refund of its journaled orders and accepts it only if the commitment recomputes from the
vault's deposit.

## Mobile / desktop
The shared core is built (`privacy-core`, `docs/mobile.md`) and now covers the whole key surface — keystore + recovery phrase + journal ([`docs/wallet-formats.md`](docs/wallet-formats.md): a backup made in the browser opens in the native wallet), BIP-44 / BIP-84 / SLIP-0010 chain keys — with a WASM package for the web; the React Native and Tauri shells need the platform toolchains (Xcode / Android Studio / MSVC) and are the next step on a workstation.

## Non-goals (V1)
No bridge, governance, DAO, proxy/upgrade, AMM/lending, NFTs, arbitrary private calls, cross-chain,
or central compliance gate. No production verifier/ceremony/audit yet.
