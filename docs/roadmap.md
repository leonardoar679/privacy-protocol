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

## Decisions still open (owner needed)
- **Gas vs §79 targets** — `transact` 1.79M / `deposit` 1.52M vs 650k / 150k. At today's gas that is
  under a dollar per operation; the levers (direct library calls, Yul body hash, deposit queue,
  shallower tree, proven updates) are in `benchmarks/gas/README.md`.
- **Proof system** (plan §41–42): Groth16 + ceremony, or a universal/transparent system — needs the
  Halo2/FRI benchmark.
- **Payload encryption scheme** (spec §12 defines the envelope, not the cipher binding to the view key).

## Deferred
Wallet-side proving (Web Worker + wasm); mobile proving benchmarks; Halo2/FRI comparison; production
ceremony + verifier; external audits; everything in plan §92 (UI beyond the shell, relayer, website).
