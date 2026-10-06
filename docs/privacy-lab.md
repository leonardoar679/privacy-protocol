# Privacy Lab — the study's adversary vs the V1 design (plan §65–§68)

**Question.** Given the blockchain's public surface — shields (depositor address, amount, time) and
withdrawals (fresh address, amount, time) — how much of a withdrawal's origin can an observer recover,
and does the wallet's default policy close the two channels the Tornado study found decisive (timing,
amount, and their multiplicative combination)?

**Method.** The study's simulation (`research/09-testing/privacy-sim/combined_linkability.js`: Poisson
arrivals, exponential delays, Bayesian posterior per withdrawal, effective set = 2^H, guess-hit with
tie-breaking, seeded) ported to the UTXO design and driven by the **shipped wallet logic**
(`reference/typescript/src/wallet/amounts.ts`: 1-2-5 bucket alphabet, bucketed shields and withdrawals,
delay floor + randomized delay, fresh address per piece, relayer fee paid as a private note).
Adversary strength is the study's upper bound: it knows the delay law and which users still hold a
shielded balance. Real observers do worse. Run: `node benchmarks/privacy/run.mjs` (≈1 min).

## Results (8,000 users, 10/h, seed 4242, 20 % warm-up)
| Policy | pieces/user | nominal set | eff. timing | eff. amount | **eff. joint** | guess-hit | unique by amount | unique joint |
|---|---|---|---|---|---|---|---|---|
| P0 naive — one shield of A, withdraw A − fee (Nova-like) | 1.00 | 235 | 193 | 12.1 | **10.0** | 24.1 % | 11.5 % | 11.5 % |
| C classic — fixed denominations 0.1 / 1 / 10 / 100 | 1.00 | 239 | 197 | 86.3 | **71.2** | 1.9 % | 0.1 % | 0.1 % |
| **P1 standard — this wallet, default** | 5.80 | 5,040 | 656 | 1,727 | **349** | 0.7 % | **0.00 %** | **0.00 %** |
| **P2 high — this wallet** | 8.71 | 5,482 | 1,897 | 2,190 | **1,073** | 0.2 % | 0.00 % | 0.00 % |

The P0 row reproduces the study's headline for arbitrary-amount pools (joint collapse 23.4×; the
study measured ~23×, amount-only ~19.5× vs 19.4× here), which validates the port.

## Reading
- **Amount channel closed.** Under P1 no withdrawal is ever amount-unique (0.00 %, §68 target
  "near-zero"), because every public amount is one of ~18 buckets shared by everyone, and the odd
  remainder stays shielded. Nova-like pools fingerprint 11.5 % of withdrawals outright.
- **Timing channel blunted, not closed.** The delay floor plus randomized delay raise the timing-only
  effective set from 193 to 656 (P1) and 1,897 (P2). Timing is a property of *when* users act; the
  protocol cannot remove it, only widen it. P2's 72 h mean delay is the price of 1,897.
- **The multiplicative collapse the study warned about is contained.** Joint effective set
  10 → 349 (×35) in default mode, → 1,073 (×107) in high mode; guess-hit 24 % → 0.7 % / 0.2 %.
  Classic's fixed denominations (71) are beaten ×5 while keeping arbitrary values, because the
  arbitrary part lives in private notes instead of on the public side.
- **"Collapse vs nominal" is the wrong comparison across policies.** P1's nominal set (5,040) is far
  larger than P0's (235) because users keep shielded balances and stay candidates; compare absolute
  effective sets.
- **Cost of privacy.** P1 makes ~5.8 public pieces per user instead of 1 — at today's gas
  (`benchmarks/gas/cost.mjs`: $0.64 per shield, $0.77 per withdrawal) a full cycle is ≈ $8.
  P2's 8.7 pieces and 72 h delays buy the next ×3.

## §68 acceptance
| Target | Result |
|---|---|
| amount attack → near-zero unique-link under default wallet behaviour | **0.00 %** (P0: 11.5 %) ✔ |
| timing attack → substantially reduced linkability | timing-only effective set ×3.4 (P1), ×9.8 (P2) vs P0 ✔ |
| timing × amount tested (multiplicative collapse) | joint effective set 10 → 349 / 1,073; guess-hit 24 % → 0.7 % / 0.2 % ✔ |

## Limits of the model
Single asset, one pool; users deposit from one address (pieces of one user are linkable at the
shield); withdrawals go to fresh addresses as the wallet enforces; private hops are not modelled
beyond their absence from the public surface; the observer's balance oracle is stronger than
reality; network-layer channels (RPC, mempool, relayer — L3/L4) are outside this lab and are the
reason the wallet's privacy score still discounts them (`frontend/src/privacy/privacyScore.ts`).
