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

## Cross-chain leg (plan §72, step 17) — `benchmarks/privacy/run-crosschain.mjs`
**Question.** A private swap leaves the pool through a one-time escrow that pays the provider
(amount A·(1 − tip), time t_e) and a fresh address receives ≈ A·rate·(1 − fee) at t_e + ETA. The
escrow address ties the withdrawal to the provider ingress by construction, so the pool side is the
lab above; what remains is: can an observer tell WHICH destination arrival belongs to WHICH ingress?

**Method.** `services/private-swap/src/sim/crossChainLab.ts`: Poisson provider traffic (background
users with the study's amount law; a share of 0.2 are this wallet's users),
three provider classes (ETA / spread / fee / execution noise), a random-walk market rate, and the
study's Bayesian observer with a lognormal ETA likelihood and a log-amount likelihood whose tolerance
is the execution noise plus the rate drift over the ETA. Seeded, 6000 swaps per row,
20 % warm-up.

| class | swaps/h | amounts | median candidates | eff. timing | eff. amount | **eff. joint** | guess-hit | uniquely linked |
|---|---|---|---|---|---|---|---|---|
| fast-intent | 5 | arbitrary | 1 | 1.2 | 1.0 | **1.0** | 100.0 % | 99.9 % |
| fast-intent | 5 | bucketed | 1 | 1.1 | 1.1 | **1.0** | 99.7 % | 98.0 % |
| fast-intent | 20 | arbitrary | 3 | 1.6 | 1.0 | **1.0** | 99.9 % | 99.8 % |
| fast-intent | 20 | bucketed | 3 | 1.5 | 1.3 | **1.1** | 97.3 % | 87.3 % |
| fast-intent | 100 | arbitrary | 13 | 3.8 | 1.0 | **1.0** | 99.7 % | 97.5 % |
| fast-intent | 100 | bucketed | 13 | 3.7 | 2.6 | **1.4** | 86.5 % | 51.3 % |
| native-chain | 5 | arbitrary | 11 | 2.7 | 1.1 | **1.0** | 99.2 % | 97.4 % |
| native-chain | 5 | bucketed | 11 | 2.8 | 2.3 | **1.2** | 92.0 % | 66.3 % |
| native-chain | 20 | arbitrary | 41 | 7.8 | 1.4 | **1.1** | 98.2 % | 86.7 % |
| native-chain | 20 | bucketed | 41 | 8.0 | 6.2 | **2.0** | 75.5 % | 18.1 % |
| native-chain | 100 | arbitrary | 206 | 35.8 | 2.8 | **1.3** | 90.9 % | 55.4 % |
| native-chain | 100 | bucketed | 204 | 35.5 | 27.6 | **5.9** | 34.5 % | 0.3 % |
| bridge-aggregator | 5 | arbitrary | 26 | 4.0 | 1.1 | **1.0** | 99.6 % | 97.9 % |
| bridge-aggregator | 5 | bucketed | 26 | 4.1 | 3.1 | **1.4** | 90.4 % | 51.0 % |
| bridge-aggregator | 20 | arbitrary | 103 | 13.8 | 1.3 | **1.0** | 98.9 % | 92.8 % |
| bridge-aggregator | 20 | bucketed | 101 | 13.4 | 9.7 | **2.6** | 68.5 % | 9.3 % |
| bridge-aggregator | 100 | arbitrary | 495 | 62.1 | 2.6 | **1.2** | 96.1 % | 67.8 % |
| bridge-aggregator | 100 | bucketed | 511 | 63.7 | 49.8 | **8.9** | 33.7 % | 0.2 % |

**Reading.**
- **Arbitrary amounts are linked** across every class and throughput (joint effective set ≈ 1,
  55–100 % uniquely linked): the output amount is a near-deterministic function of the input.
- **Bucketing helps only with cover traffic.** Bucketed amounts share the wallet's alphabet, so the
  cover is the other bucketed swaps inside the provider's ETA window: native-chain class at
  100 swaps/h → joint set 5.9, 0.3 % unique; at 5/h → 1.2, 66 % unique. Fast intents (1 min ETA)
  have almost no window to hide in whatever the throughput.
- **The delay policy does nothing for this leg** (by construction); it protects the pool side.
  Slower providers with wider ETA spread are *more* private here — the opposite of the UX ranking.
- **Consequence for the score (spec §10) — corrected 2026-10-07, see below.** The fit stays
  (`eff = 1 + k·candidates`, k = 0.02 bucketed, 0.0006 arbitrary; `1 − log2(eff)/4` as the
  probability-like link penalty), but it is a *second hurdle* that multiplies the pool-side
  penalties, and only for a provider that keeps the escrow → destination link private.
- **Design options this suggests** (not implemented): splitting one swap across providers / time
  windows (more candidates per piece), preferring the provider with the most same-bucket traffic
  for the pair, and showing the user the live cover size next to the score.

**What the escrow architecture makes of this (correction, 2026-10-07).** The question above —
which arrival belongs to which ingress — is answered on-chain for every adapter we run: THORChain's
deposit memo names the destination (`=:ASSET:DEST/ESCROW:LIMIT`) and its outbound carries `OUT:<inbound tx>`;
Across' deposit event names the recipient; Mayan's order payload carries `destAddr`; Chainflip's
vault-swap calldata encodes the destination; LI.FI's bridge call carries the receiver; NEAR Intents
pays out on the NEAR intents contract (unverified, so treated as public). The adapters declare this
(`Capabilities.destinationLinkPublic` + where, shown under "View route"). The public link reaches
only the one-time escrow, which a private withdrawal funded, so it costs nothing: to tie a
destination to a user the observer must link the user's deposit to that withdrawal (the pool side,
measured by the amount / timing penalties above) **and** the destination to the withdrawal. The two
links multiply; with the second one public the swap is exactly as private as the pool side, whatever
the provider's traffic. The first version of the score instead took the *worse* of the pool-side and
cross-chain penalties, which charged low-traffic providers for a link that is public on every route
and harmless on all of them; it now multiplies (`privacyScore.ts`), the cross-chain leg can only add
privacy, and for every adapter today it adds none. Consequences: no throughput-based penalty; a live
provider-volume feed would only matter for a provider verified to keep the link private (none is),
so it is not built; the design options above remain valid for such a provider.

**Limits.** The observer knows the provider's fee and ETA law exactly; background amounts follow the
study's law, not measured provider histograms; one pair per run; no provider-internal batching
(Chainflip's batched egress or THORChain's outbound queue would add cover not modelled here).

### Streamed settlement (plan V2 §22–§23, spec V2 §12) — added 2026-10-07

The native-chain class now also runs as a stream of 1,200 s and 6,000 s (`STREAM_SECONDS`): the
provider swaps in parts over that long and sends one outbound at the end, so the arrival is the ETA
law shifted by the stream and the output carries the rate drift over the stream. The observer knows the
stream length — a THORChain memo publishes `INTERVAL/QUANTITY`, Chainflip's calldata its DCA
parameters — so on the timing side it is a shift, not uncertainty. Hypothetical private-link rows
(the only case where this leg counts, see the correction above):

| swaps/h | amounts | stream | median candidates | eff. amount | **eff. joint** | uniquely linked |
|---|---|---|---|---|---|---|
| 20 | arbitrary | 0 / 1,200 / 6,000 s | 42 / 49 / 74 | 1.3 / 1.5 / 2.0 | **1.1 / 1.1 / 1.1** | 88 / 86 / 84 % |
| 20 | bucketed | 0 / 1,200 / 6,000 s | 42 / 47 / 74 | 6.6 / 6.8 / 11.5 | **2.0 / 1.9 / 2.0** | 19 / 20 / 17 % |
| 100 | arbitrary | 0 / 1,200 / 6,000 s | 206 / 240 / 373 | 2.8 / 3.2 / 5.4 | **1.3 / 1.3 / 1.4** | 56 / 57 / 46 % |
| 100 | bucketed | 0 / 1,200 / 6,000 s | 207 / 237 / 375 | 26.9 / 30.8 / 51.8 | **5.7 / 5.6 / 6.1** | 0.2 / 0.4 / 0.0 % |

A 100-minute stream widens the amount channel (the drift over the stream blurs the predicted output)
and admits more candidates, but the joint set barely moves, and with the link public — every adapter
today — the set is 1 whatever the plan. **Streaming is execution, not privacy** (plan §23); the
privacy score does not change with the plan (spec V2 §12, §17).

### Whale UTXO strategy (plan V2 §73–§74, §120) — `benchmarks/whale/run-utxo.mjs`, added 2026-10-07

**Question.** A wallet holding $1M–$10M wants to withdraw 1,330 ETH (≈ $3.4M at the probe's price).
One withdrawal of the exact amount, one piece of an extended bucket alphabet (1,000 / 2,000 / 5,000 ETH),
or many pieces of the alphabet that ships, each at its own random delay? `reference/typescript/src/sim/whaleUtxoLab.ts`:
8,000 ordinary users at 10/h on the standard policy, 24 whales arriving uniformly, the privacy lab's
oracle-strength observer (delay law + remaining balances), seed 4242.

| strategy | pieces | piece sizes (ETH) | span | eff. timing | eff. amount | **eff. joint** | guess-hit | uniquely linked | burst share | gas |
|---|---|---|---|---|---|---|---|---|---|---|
| exact (one escrow, today) | 1 | 1,330 | — | 1.6 | 1.7 | **1.6** | 79 % | 42 % | 100 % | 1.8M |
| bucket-ext | 1 | 1,000 | — | 1.7 | 1.8 | **1.7** | 79 % | 54 % | 100 % | 1.8M |
| pieces-500 | 6 | 500 / 200 / 100 / 20 / 10 | 59 h | 18.4 | 23.7 | **18.4** | 41 % | 16 % | 2.3 % | 11M |
| pieces-100 | 15 | 100 / 20 / 10 | 228 h | 12.7 | 17.2 | **12.7** | 24 % | 0.3 % | 6.2 % | 27M |
| pieces-10 | 133 | 10 | 400 h | 74.0 | 95.7 | **74.0** | 1.6 % | 0.0 % | 3.9 % | 238M |

**Reading.**
- **A single large piece is "a whale among whales".** Only users who can still pay the piece are
  candidates; for 1,000 ETH or 1,330 ETH those are the other whales, so the set is 1.6–1.7 and 42–54 %
  of such withdrawals are uniquely linked. **An extended alphabet buys nothing by itself**: a
  1,000 ETH bucket has no cover because nobody else withdraws 1,000 ETH. It is not adopted (Stage 8).
- **Splitting into the shipped alphabet is what helps, and it costs time and gas.** Pieces of at most
  100 ETH over about nine days reach a per-piece set of 12.7 and 0.3 % unique links; 133 pieces of
  10 ETH over about 17 days reach 74 and no unique link, at 238M gas (the USD cost follows the live gas
  price, `benchmarks/gas/cost.mjs`). The 500-ETH plan sits between because its two 500-ETH pieces are
  again whale-only.
- **The per-piece view misses the campaign.** The burst share (the whale's own pieces among all
  withdrawals of that size inside its window) stays at 2–6 % because the window is long, but 133 equal
  pieces over 17 days are a pattern this lab does not score. A real observer would cluster them; the
  numbers above are upper bounds on what splitting earns.
- **Consequence for the product** (spec V2 §12, §13, Stage 8): a large *swap* keeps one escrow — the
  exact amount, the "fast" option — and the lint says what that means ("a whale among whales": the
  pool side links it to the set of large holders, whose size the Privacy Center can state from the
  pool's public deposit sizes). A large *balance* is kept as standard-bucket notes (≤ 100 ETH, ideally
  10 ETH) by the housekeeping planner, so that a withdrawal to the user's own addresses can leave as
  pieces over the policy window when privacy is preferred over speed; the number of concurrent large
  holders bounds what any single large piece can hide behind.

**Limits.** Whales share one amount here; the background law has no whales of its own (the pool's
real deposit-size distribution is public and could replace it); the observer uses the piece's own delay
law for every candidate; no clustering of a whale's pieces.
