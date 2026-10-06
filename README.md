# Privacy Protocol V1

An immutable, non-custodial, Ethereum-L1 **shielded pool** for ETH + ERC-20s — the protocol specified
by the Tornado Cash study in [`../research`](../research). Thesis: *keep Classic's immutability and
fund-safety, adopt an expressive UTXO shielded pool, and close the whole metadata stack by default* —
with one central refinement: an **asset-free core** plus **one canonical vault per asset**, so a
stablecoin issuer's freeze can only ever touch its own vault.

> Pre-production. The exact specification is [`docs/protocol-spec-v1.0.md`](docs/protocol-spec-v1.0.md);
> contracts, circuit, two crypto references and the wallet shell are **built and tested to it**, and
> real Groth16 proofs drive a shield → private withdrawal → relayer fee spend **end to end on the EVM**
> with nothing mocked. The trusted setup is a dev setup (insecure by design), in-browser proving is
> still a stub, and nothing is externally audited. Not for production. See
> [`docs/roadmap.md`](docs/roadmap.md) and [`docs/circuit-audit.md`](docs/circuit-audit.md).

## Layout
```
privacy-protocol/
├─ docs/        protocol-spec-v1.0 (normative) · crypto · vault · threat-model · security-invariants · circuit-audit · privacy-lab · roadmap
├─ contracts/   Foundry — immutable PrivacyCore + vaults + factory + Poseidon2 + verifier + deploy script   [65/65 tests ✅ incl. e2e]
├─ circuits/    circom — 2-in/3-out transaction, Poseidon2, KAT, soundness harness, dev setup             [compiled + proven ✅]
├─ reference/   typescript (vectors, witness builder, wallet policy, reorg indexer) · python (differential) [35/35 ✅ · 31/31 ✅]
├─ frontend/    Vite+React+viem wallet shell (shield/send/withdraw + privacy score)                        [builds ✅; proving stubbed]
└─ benchmarks/  gas (live cost tool) · privacy (the study's adversary vs this design) · proof · mobile
```

## Status (this environment)
| Part | Verified |
|------|----------|
| contracts | **65/65 forge**: 44 mock-based (5 fuzz invariants, token zoo, issuer isolation, reentrancy matrix, no-privilege bytecode scan) + Poseidon2 KAT 5 + real verifier 8 + **end-to-end 8** |
| circuits | compiled (23,343 constraints, 14 public inputs); KAT **18/18**; soundness **17/17**; Groth16 harness **14/14** |
| reference | TypeScript **35/35** vitest (incl. reorg indexer, amount engine); Python **31/31** vectors; four implementations agree on every primitive |
| frontend | `tsc -b` clean + `vite build` → `dist/` |
| privacy lab | amount unique-link **0.00 %** (Nova-like 11.5 %); joint effective anonymity **10 → 349 / 1,073** ([`docs/privacy-lab.md`](docs/privacy-lab.md)) |
| gas | `transact` 1.79M, `deposit` 1.52M; **live cost**: `node benchmarks/gas/cost.mjs` (≈ $0.75 / $0.64 at 0.15 gwei) |

## Quickstart
```
# contracts (local solc + offline — see contracts/README.md for why)
cd contracts && FOUNDRY_OFFLINE=true forge test --use <solc-0.8.24> -vv

# references
cd reference/typescript && npm install && npm test && npm run vectors && npm run fixtures
cd reference/python && python test_vectors.py

# circuit — needs a circom 2.x binary; full pipeline in circuits/README.md
cd circuits && npm install

# frontend
cd frontend && npm install && npm run build

# benchmarks
node benchmarks/gas/cost.mjs          # live gas price × measured gas
node benchmarks/privacy/run.mjs       # the study's adversary vs the shipped wallet policy (~1 min)
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

## Non-goals (V1)
No bridge, governance, DAO, proxy/upgrade, AMM/lending, NFTs, arbitrary private calls, cross-chain,
or central compliance gate. No production verifier/ceremony/audit yet.
