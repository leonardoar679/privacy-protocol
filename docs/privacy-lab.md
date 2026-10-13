# Privacy Lab — the study's adversary vs the V1 design (plan §65–§68)

**Question.** Given the blockchain's public surface — shields (depositor address, amount, time) and
withdrawals (fresh address, amount, time) — how much of a withdrawal's origin can an observer recover,
and does the wallet's default policy close the two channels the Tornado study found decisive (timing,
amount, and their multiplicative combination)?

**Method.** The study's simulation (`research/09-testing/privacy-sim/combined_linkability.js`: Poisson
arrivals, exponential delays, Bayesian posterior per withdrawal, effective set = 2^H, guess-hit with
tie-breaking, seeded) ported to the UTXO design and driven by the **shipped wallet logic**
(`packages/protocol/src/wallet/amounts.ts`: 1-2-5 bucket alphabet, bucketed shields and withdrawals,
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
reason the wallet's privacy score still discounts them (`apps/web/src/privacy/privacyScore.ts`).

## Cross-chain leg (plan §72, step 17) — `benchmarks/privacy/run-crosschain.mjs`
**Question.** A private swap leaves the pool through a one-time escrow that pays the provider
(amount A·(1 − tip), time t_e) and a fresh address receives ≈ A·rate·(1 − fee) at t_e + ETA. The
escrow address ties the withdrawal to the provider ingress by construction, so the pool side is the
lab above; what remains is: can an observer tell WHICH destination arrival belongs to WHICH ingress?

**Method.** `packages/swap-engine/src/sim/crossChainLab.ts`: Poisson provider traffic (background
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
or many pieces of the alphabet that ships, each at its own random delay? `packages/protocol/src/sim/whaleUtxoLab.ts`:
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
- **Consequence for the product** (spec V2 §12, §13, Stage 8; revised by V3): under V2 a large *swap*
  kept one escrow — the exact amount, the "fast" option — and the lint said what that means ("a whale
  among whales"). V3 (`docs/high-value-protection-spec-v1.0.md` §4–§5, §11) executes a large swap as
  bucketed tranches under an in-flight exposure cap, for capital-exposure reasons first; what that earns
  or costs in privacy is measured by the campaign rows of its Stage 2, not assumed. The V2 wording: the
  lint says what one escrow means ("a whale among whales": the
  pool side links it to the set of large holders, whose size the Privacy Center can state from the
  pool's public deposit sizes). A large *balance* is kept as standard-bucket notes (≤ 100 ETH, ideally
  10 ETH) by the housekeeping planner, so that a withdrawal to the user's own addresses can leave as
  pieces over the policy window when privacy is preferred over speed; the number of concurrent large
  holders bounds what any single large piece can hide behind. *Shipped in Stage 8:*
  `packages/protocol/src/wallet/noteStrategy.ts` (the planner: 100-unit then 10-unit pieces, dust
  merged, fee-aware), `apps/web/src/wallet/housekeeping.ts` (one private self-transfer per step inside
  the policy window, the daily fee cap, the opt-out); the lint's `large-piece` item counts the holders
  from the pool's public deposit sizes (`sdk/poolDeposits.ts`).

**Limits.** Whales share one amount here; the background law has no whales of its own (the pool's
real deposit-size distribution is public and could replace it); the observer uses the piece's own delay
law for every candidate; no clustering of a whale's pieces.

## The policy benchmark (V4) — added 2026-10-08

`benchmarks/whale/run-policy.mjs` (→ `packages/protocol/src/sim/policyBenchmark.ts`) runs the campaign lab over the cap
variants the High-Value Execution Engine plan asks to compare (§121: one execution vs 5 % vs 2.5 % vs 1 %), the §119
conditions and the §120 privacy matrix, and writes `docs/HighValuePolicyBenchmark.md` with the plan's §122 columns. Its
§123 rule keeps 2.5 % (contract §9). The privacy columns come from the whale UTXO lab below and the six-component
assessment (`packages/protocol/src/wallet/privacyAssessment.ts`); nothing new is measured there — the matrix maps the
plan's four configurations onto what these labs already quantify and says which column is a measurement and which a score.

## High-value protection (V3: tranches under an in-flight cap) — added 2026-10-08

V3 (`docs/high-value-protection-spec-v1.0.md`) executes a large order as a sequence of tranches, each one external
execution risk boundary, with at most the cap unsettled at any time. The labs below measure what that costs and what
it reveals; they decided the constants marked *lab-calibrated* in the spec (its §4, §6, §10, §14, §18). Three runs,
all read-only and seeded: the **campaign lab** (`benchmarks/whale/run-campaign.mjs` →
`packages/protocol/src/sim/campaignLab.ts`: the reducer of `wallet/campaign.ts` against a simulated clock fed by
the measured quotes of `execution.json`), the **whale UTXO lab** with two campaign strategies
(`benchmarks/whale/utxo.json` at 1,330 ETH and `utxo-10m.json` at 3,894 ETH ≈ $10M at the probe's price) and the
**cross-chain observer lab** with campaign rows (`benchmarks/privacy/crosschain.json`).

### Steps, time and gas (campaign lab, `benchmarks/whale/campaign.md`)

ETH → BTC through THORChain streaming (class R5: the gate is destination final, Bitcoin's margin 60 min; one tranche in
flight at a time; the cadence between releases drawn in the mode's window), gas at the price the runner fetched when it
ran (0.17 gwei, ETH $2,558 — never a constant):

| order | mode | tranches | tranche | cap | wall time | gas |
|---|---|---|---|---|---|---|
| $1M | Balanced (varied) | 70 | $10K–$24K | $25K | 141 h | $92 |
| $1M | Maximum Privacy (bucket) | 78 | $11K–$13K | $25K | 333 h | $103 |
| $1M | Maximum Safety | 71 | $10K–$18K | $20K | 133 h | $93 |
| $5M | Balanced | 78 | $51K–$82K | $100K | 169 h | $103 |
| $10M | Balanced | 78 | $113K–$128K | $200K | 167 h | $103 |
| $10M | Maximum Privacy | 78 | $113K–$128K | $200K | 363 h | $103 |
| $10M | Maximum Safety | 78 | $113K–$128K | $200K | 146 h | $103 |
| $25M | Balanced | 97 | $257K–$347K | $500K | 207 h | $128 |
| $50M | Balanced | 97 | $514K–$695K | $1M | 215 h | $128 |

- **The step count is set by the bucket alphabet, not by the fraction**: a 2 %–2.5 % piece of $10M in ETH is 78–97
  ETH and no 1-2-5 bucket sits there, so the splitter takes 50 ETH (1.3 %) or 50 + 20 (1.8 %) — 78 steps rather than
  40. `varied` (a bucket or two of adjacent decades, consecutive pieces different) gives the fewest steps; `bucket`
  (single buckets only) the most common sizes. The lab saw no privacy difference between them (below), so
  **`varied` is the default** and `bucket` is Maximum Privacy's choice.
- **Time is the finality margin plus the cadence, not the stream**: a $128K tranche streams in ≈ 18 min, then waits
  60 min for Bitcoin's margin and 10–90 min of cadence (Balanced) — ≈ 2.1 h per step, a week for $10M. Maximum
  Privacy's wider cadence (30 min–6 h) doubles it. A route whose destination is an EVM chain (15 min margin) or Solana
  (1 min) finishes in 1–4 days. This is the price of the owner's gate decision (destination final for bridge routes);
  the screen states the estimate before the start (spec §15) and the campaign resumes at unlock.
- **Parallel release does not apply to bridge routes** (plan V3 §19): R5 (THORChain, Chainflip, Across, Mayan Fast-MCTP,
  LI.FI) runs sequentially whatever the size; the assumed R2 SOL → ETH row (Mayan auction) is the only parallel one and
  finishes a $1M campaign in 35 h against 61–143 h sequential.

### Faults (plan V3 §152–§153): the $10M ETH → BTC campaign, one fault at its middle tranche

| fault | maximum loss | outcome |
|---|---|---|
| provider outage, quote mismatch, reorg, wrong chain, wrong token, destination error | $0 | a pause before any money moved; the wrong-destination / wrong-asset cases are cancelled and the rest returns |
| price spike, chain congestion, RPC failure, app crash, network disconnect | the tranche in flight ($128K) | a pause; nothing is sent again; completed after the pause |
| solver failure | the tranche in flight ($128K) | the executor reports the failed call; the step returns at its refund window and is re-planned as one more tranche; completed |
| bridge timeout | the tranche in flight ($128K) | no outbound: an anomaly pause after three times the expected time; the step returns when the provider refunds it hours later (4.5 h extra) and is re-planned; completed |

One external fault reaches at most one active tranche (the cap is $200K; the tranche $128K), never the order; at $1M
the most a fault reaches is $10K. Every run funded and handed over each tranche exactly once, including the app crash
(the journal is the state). ELPF with the assumed class priors (2 % for R5): $2.6K per tranche, $4K per campaign cap.

### What a campaign reveals (whale UTXO lab; cross-chain lab)

| strategy (1,330 ETH) | pieces | span | eff. timing | eff. amount | eff. joint | unique | burst | gas |
|---|---|---|---|---|---|---|---|---|
| exact (one escrow, V2) | 1 | — | 1.6 | 1.7 | 1.6 | 42 % | 100 % | 2M |
| pieces-100 (housekeeping, V2) | 15 | 228 h | 12.7 | 17.2 | 12.7 | 0.3 % | 6 % | 27M |
| pieces-10 | 133 | 400 h | 74.0 | 95.7 | 74.0 | 0.0 % | 4 % | 238M |
| **tranches-bucket (V3)** | 45 | 95 h | 24.3 | 29.9 | 24.3 | 3.2 % | 24 % | 81M |
| **tranches-varied (V3)** | 45 | 95 h | 22.6 | 27.7 | 22.6 | 0.1 % | 24 % | 81M |

| strategy (3,894 ETH ≈ $10M) | pieces | span | eff. joint | unique | burst | gas |
|---|---|---|---|---|---|---|
| exact | 1 | — | 1.6 | 42 % | 100 % | 2M |
| pieces-100 | 43 | 324 h | 22.9 | 1.2 % | 8.5 % | 77M |
| tranches-bucket | 77 | 162 h | 8.4 | 0.6 % | 17 % | 138M |
| tranches-varied | 77 | 162 h | 8.8 | 0.4 % | 16 % | 138M |

- Per piece, a campaign's withdrawal hides as well as any bucketed piece of its size (joint set 8–24 against 1.6 for
  one escrow). **The campaign itself is visible**: 17–24 % of the same-size withdrawals inside a campaign's window are
  the campaign's own (against 6–8 % for housekeeping pieces spread by the privacy delay), because the protection clock
  releases a piece every ≈ 2 h while the privacy policy spreads pieces over days. A clustering observer sees a
  campaign; the per-piece numbers are upper bounds on what it earns.
- On the cross-chain side (`crosschain.json`, native-chain class, bucketed, campaigns of 40 pieces): the per-arrival
  joint set is 1.4 at 20 swaps/h and 2.1 at 100/h, with 23–49 % of arrivals uniquely linked, against 2.0 / 5.7 and
  19 % / 0.2 % for the same wallet's independent bucketed swaps — a campaign's pieces are large buckets (10–50 ETH)
  whose cover at that size is thin — and 65–72 % of the same-size arrivals inside a campaign's window are the
  campaign's. Streaming the pieces (1,200 s) changes nothing: execution, not privacy (spec §12).
- **Consequence for the product**: tranching protects capital (one external fault reaches one piece) and gives each
  piece a pool-side crowd, but a campaign is a public pattern on both sides of the swap. The wallet says so (the lint:
  `tranche-link`, `same-size-consecutive`, the Privacy Center), Maximum Privacy widens the cadence and keeps single
  buckets, and nothing claims a campaign is invisible. What the labs do not score: an observer who models the
  protection clock exactly (the timing posterior here uses the privacy delay law), and the provider's own view (it sees
  every tranche's escrow and memo).

*Lab-calibrated from these runs*: `capBps` 250 (200 at ≥ $5M and in Maximum Safety), the R5 band [100, 250] bps and
the R2 band [200, 300], `varied` sizing by default (`bucket` in Maximum Privacy), the cadence windows [10 min, 90 min] /
[30 min, 6 h] / [10 min, 60 min], the finality margins (BTC 60 min, SOL 1 min, EVM 15 min — kept: the time is the
gate's price), `MAX_DEVIATION_BPS` 100 (the measured drift over a 2 h step is a few bps), sequential release for R5 /
R6, and the class priors as assumptions until settlement history exists.
