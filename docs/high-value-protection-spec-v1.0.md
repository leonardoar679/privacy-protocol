# High-Value Protection Specification V1.0

Normative. How a large private order ($100K to $50M+) is executed so that no more than a bounded
fraction of it is ever exposed to one external risk boundary, and no more than that fraction is ever
unsettled at one time: the risk classes of the routes, the execution bounds one confirmation binds, how
an order becomes a sequence of tranches, how exposure is counted, what releases the next tranche, when
and why the wallet pauses and never continues on its own, how it recovers, what it shows, and what the
labs must measure (plan V3 §1–§155). It extends `docs/whale-execution-spec-v1.0.md` (V2) and
`docs/private-swap-spec-v1.1.md`, which stay normative where this document does not restate them.
**`PrivacyCore`, the vaults, the circuits and the `SwapOrderEscrow` / `SwapOrderFactory` bytecode are
unchanged by this document** (plan V3 §123–§125): every rule here is wallet (replaceable), engine
(replaceable), relayer (replaceable) or research. The service never holds a user's portfolio, address
list or identity (V2 §22, §25): every per-user state of this document lives in the wallet's encrypted
journal. The AI recommends, simulates, explains and warns; it never signs (plan V3 §92).

Status words MUST / MUST NOT / SHOULD are RFC-2119. Code: `reference/typescript/src/wallet/`,
`frontend/src/`, `services/private-swap/`, `services/relayer/`, `benchmarks/whale/`.

Status (2026-10-08): a section marked *Stage N* is built by the V3 pass in that stage, in order (the
roadmap tracks completion). Constants marked *lab-calibrated* take their final value from Stage 2
(`benchmarks/whale/campaign.md`); until then the value written here is the default the labs start from.

---

## 1. Principles (plan V3 §1–§4, §121, §138–§139)

- **The same simple wallet.** A small user sees the one-tap flow of V2; a large user sees the same
  screens with protection added underneath. Nothing in this document adds a control a user must set
  to be protected (plan §1, §140).
- **No single unnecessary risk boundary.** A large order MUST NOT be executed as one external
  execution when the route carries protocol, counterparty, bridge, liquidity or operational risk
  (§2). It is executed as **tranches**, each one external execution risk boundary (§4).
- **The fraction is a ceiling on exposure, not a transaction count** (plan §3–§4). A 2.5 % tranche
  MAY be one contract call that guarantees its own bounds, one THORChain streaming order with hundreds
  of internal sub-swaps, or one intent. The user sees "Swap $10M", never "Swap #1 … #40" (§15).
- **Unsettled exposure is what is at risk** (plan §18, §133). The in-flight cap (§5) bounds the sum of
  tranches handed over and not yet settled; it is stronger than, and independent of, the tranche size.
- **Never continue automatically after an anomaly** (plan §22, §45, §86). A pause is a wallet state the
  protocol never has (plan §59–§60).
- **Safety hierarchy** (plan §138), in order: do not lose funds; do not send to the wrong destination;
  do not execute outside the price limits; do not expose unnecessary identity; then cost; then speed.
- **Privacy hierarchy** (plan §139), in order: protect the keys; prevent direct identity linkage;
  prevent timing linkage; prevent amount fingerprinting; prevent provider / RPC correlation; then speed.
- **What this adds** (plan §121): execution privacy and financial-history privacy (V1.0–V2) plus
  capital-exposure control. Splitting is not privacy: §11 says what a campaign reveals.

## 2. Risk classes (plan V3 §5–§12, §73–§74, §135–§137)

Every route of a large order is classified before anything is funded. The class decides the default
tranche band, the settlement gate (§6) and the prior failure probability (§10).

| Class | Meaning | Today's routes | Default band (of the order) | Gate (§6) |
|---|---|---|---|---|
| R1 | atomic smart-contract execution that guarantees minimum output, deadline, destination and maximum input in the transaction | none (every adapter has `Capabilities.atomic: false`) | lab-calibrated, MAY exceed 3 % when impact ≤ cap | source final |
| R2 | RFQ / solver execution with signed bounds | Mayan SWIFT (auction), NEAR Intents (intent); UniswapX RFQ when built (V2 §11) | 2.0–3.0 % | destination submitted |
| R3 | DEX execution | the Across swap leg (a source swap before the bridge), LI.FI source swaps | the carrying class's band, and the thin-market rule | the carrying class's gate |
| R4 | cross-chain execution that can stop in a partial state (plan §9) | LI.FI (aggregation), Mayan Fast-MCTP, Across (relayer-bridge), as the second class of their routes | 2.0–3.0 % | destination submitted (R2/R4) or final (R5) |
| R5 | bridge / MPC / TSS custody of funds in flight | THORChain (TSS vaults), Chainflip (MPC vault), Across (relayer inventory + bridge), Mayan Fast-MCTP (CCTP), LI.FI bridges | 1.0–2.5 % (default 2.5 % Balanced, 2.0 % Maximum Safety and ≥ $5M) | destination final |
| R6 | external OTC / counterparty | none; interface only (§19) | 1.0–2.5 % | destination final |
| R7 | issuer-controlled asset on either leg (USDC, USDT) | any route whose source or destination asset has an issuer | the carrying class's band; the issuer line and the isolated vault (V2 §24) | the carrying class's gate |

- The class of a route is the **highest-risk class among its legs** (R5 over R4 over R2), with R3 and R7
  as flags on top. The risk database (§10) states each provider's class and custody model; the shared
  `riskModelOf(provider, quote, from, to)` applies it to a quote (`reference/typescript/src/wallet/riskClasses.ts`).
- **Why not 2 % everywhere** (plan §73–§74): the optimal fraction depends on counterparty, technology,
  liquidity, settlement, market and privacy risk. The risk engine MAY narrow a class's band (never widen it
  above 3 %) from live facts: a provider whose security score is below 70, whose breaker opened in the
  last 24 h or with an incident in the last 30 days gets the lower edge of its band.
- **The thin-market rule** (plan §135–§137): a tranche is not safe just because it is 2.5 %. A piece whose
  quoted impact exceeds `IMPACT_CAP_BPS` (50, V2 §4) MUST be halved until it fits or the route is left
  to streaming / another venue; a piece above a provider's stated instant limit (`Quote.limits.maxInstant`,
  Across ≈ 180 WETH) MUST be reduced to that limit. **The large-market rule**: when a tranche is tiny
  relative to liquidity (impact < 5 bps) the engine MAY recommend the band's upper edge.

*Implemented (Stage 1):* `reference/typescript/src/wallet/riskClasses.ts` (`riskModelOf`, `narrowedBand`, `expectedLossPerFailure`; `test/riskClasses.test.ts`). *Lab-calibrated (Stage 2):* the R5 band [1.0, 2.5] % and the R2 band [2.0, 3.0] % stand; because the 1-2-5 alphabet rarely holds a bucket at 2–2.5 % of an order, pieces land at 1.3–2.5 % (50 ETH of 2,353; 5 ETH of 389): 70–97 steps from $1M to $50M (`benchmarks/whale/campaign.md`). *Stage 3* (the risk database, the recommendation).

## 3. Execution bounds (plan V3 §31–§34, §78–§82)

One confirmation (§14) binds the **execution bounds** of a campaign — the whale spec's phase-2 fields
(V2 §3) lifted to the campaign — and no tranche MAY leave them without a new confirmation:

```
ExecutionBounds {
  orderId            bytes32  the campaign id: uniformly random, never derived from identity (V2 §1)
  assetIn, chainIn            the source asset and chain
  amountInLimit      uint     the whole order in base units; the sum of all tranches funded MUST NOT exceed it
  assetOut, chainOut          the destination asset and chain
  destination                 { kind: "fresh-per-tranche" } (the wallet's next unused address per tranche, V2 §21)
                              | { kind: "entered" | "book", address, bookId? } (one verified address for every tranche, §12)
  minimumOutput      uint     the minimum output PER SOURCE UNIT (1e18 fixed point): the confirmation quote's
                              toAmountMin / amount, less the tier's slippage (50 bps; the provider's recommended
                              tolerance when lower, V2 §14); every tranche's hard quote MUST guarantee at least
                              amount × minimumOutput, pro rata for a stream (V2 §12)
  expiry             unix s   the campaign expiry: no tranche is committed after it
  maxFeeBps          bps      the tip (≤ 25 bps, V1.1) plus the relayer fee ceiling per tranche; a tranche above it pauses
  privacyMode                 balanced | max-privacy | max-safety (§14)
  maxExternalExposure uint    the in-flight cap (§5) in base units
  executeWindowSeconds        the per-tranche execution window (§4): executeDeadline = quote expiry + window
}
```

- **What the user approves** (plan §32): what, where, at least how much, at most which fee, until when
  — never "the provider may do whatever it wants". **What a provider never gets**: more than one tranche's
  escrow balance (V1.1 D1, now per tranche), a different destination, a lower minimum, a later deadline, a
  larger fee (V2 §3 per escrow, unchanged).
- **The price bound** (plan §78, §80): a tranche whose hard quote at `/prepare` guarantees less than
  `amount × minimumOutput` MUST NOT be signed (the V2 `MinimumMoved` consent is replaced inside a campaign by
  a **pause**, `price-deviation`, §8: consent to a lower minimum is a campaign-level decision, never a
  per-tranche tap). Because V2's price guard is silent when one venue answers (V2 §14), the campaign
  keeps its own second check: the **Chainlink cross-rate** (the destination feed over the source feed,
  V2 §13) at release MUST NOT have moved by more than `MAX_DEVIATION_BPS` (100, lab-calibrated) against
  the rate at confirmation; otherwise the campaign pauses and requotes. Unlimited slippage (5 %, 10 %) is
  never a default (plan §80).
- **Stale quotes never execute** (plan §82): the signed deadline of a tranche is
  `min(quote.expiresAt, executeDeadline)` (V2 §14); a tranche past it is not handed over.
- **No unlimited approvals** (plan §33): see §13.

*Implemented (Stage 1):* the types and `checkWithinBounds` in `reference/typescript/src/wallet/campaign.ts` (`test/campaign.test.ts`). *Implemented (Stage 3):* `executeWindowSeconds` — `QuoteHint.executeWindowSeconds` on `/quote` and `/order`, clamped by `executeWindowFor(policy, window)` into `[EXECUTE_WINDOW_MIN_SECONDS (600), the policy's delay budget]` and written into `executeDeadline` (so `refundAfter` follows) by `buildOrder` (`services/private-swap/src/engine.ts`, `test/risk.test.ts`). *Stage 4* (the wallet).

## 4. Tranche sizing and cadence (plan V3 §3–§4, §15–§17, §27–§29, §52–§53)

- **Pieces come from the bucket alphabet.** A tranche is one bucket, or the sum of two buckets, of the
  asset's alphabet (`amounts.ts bucketsFor(decimals)`: {1, 2, 5} × 10^k; 0.001…500 ETH, 1…500,000 USDC)
  inside the band `[band.min, min(band.max, cap / maxParallel)]` of the order (§2, §5). Two sizing modes:
  - `bucket`: every piece is the largest bucket inside the band (a $10M ETH order at $4,250 = 2,353 ETH →
    50 ETH ≈ 2.1 %, 47 pieces; a $1M order → 5 ETH ≈ 2.1 %); the public amounts are the common sizes of
    the pool, and consecutive pieces are equal;
  - `varied`: consecutive pieces differ (50 / 60 / 70 ETH: a bucket plus a smaller bucket), so no two
    consecutive external executions have the same size (plan §15, §52), at the cost of less common amounts.
  **`varied` is the default** and `bucket` is Maximum Privacy's choice (Stage 2: the two are equal within the labs'
  noise, `docs/privacy-lab.md`; `varied` takes fewer steps). The last piece absorbs the remainder when it is below the
  dust floor; a re-plan after a refund sizes its pieces against the order, never against the remainder.
- **The user never chooses** sizes, fractions, sub-swap counts or intervals (plan §15, §28; V2 §1 kept).
  Advanced information MAY show the fractions (plan §65).
- **Streaming inside a tranche** (plan §27–§29): the engine's plan per tranche is V2 §12 unchanged
  (THORChain streaming or Rapid when it fits, Chainflip DCA): one tranche, one escrow call, many internal
  legs, one destination settlement. Streaming is execution, not privacy (plan §30; V2 §12).
- **Cadence** (plan §53): the release of a tranche after its predecessor settled waits a random delay drawn
  from the mode's cadence window (`CADENCE_SECONDS`, Balanced [10 min, 90 min], Maximum Privacy
  [30 min, 6 h], Maximum Safety [10 min, 60 min]; lab-calibrated, Stage 2: kept), from the CSPRNG (`schedule.ts
  sampleDueAt`), never a fixed interval. The wallet MUST NOT produce an exact-interval pattern.
- **The note shape** (plan §54): before the first tranche the wallet MAY reshape its notes so that every
  tranche spends at most two notes (`campaign-shape`, §7): private self-transfers through the housekeeping
  planner with the campaign's piece as the target (the daily fee cap of V2 §25 is lifted for a confirmed
  campaign and the cost is shown in the maximum-loss model, §15). Above 64 × 100 ETH the campaign's shape
  policy overrides the balance planner's `maxNotes` (it would otherwise split and merge in a loop).

*Implemented (Stage 1):* `planTranches` (`campaign.ts`: single buckets, or two of the same or adjacent decade, inside the band; `bucket` / `varied`; the remainder rule; every piece under the cap — `test/campaign.test.ts` at $1M, $4.25M, $10M and $50M in ETH and USDC). *Calibrated (Stage 2):* `varied` by default, the cadence windows as written, `reference` for re-plans. *Stage 4* (the wallet).

## 5. Exposure accounting and the in-flight cap (plan V3 §18, §46–§48, §96–§100, §132–§134)

For a campaign with total `T` and cap fraction `capBps` (§14):

```
cap        = floor(T × capBps / 10000)                          the maximum external exposure
inFlight   = Σ amount of tranches handed over and not yet past their gate (§6)   externally reachable
prepared   = Σ amount of tranches funded or signed but not handed over           in our own escrows: D1
completed  = Σ amount of settled tranches + the delivered share of partial ones
refunded   = Σ amount back in the pool (returns to `remaining` and is re-planned)
remaining  = T − completed − inFlight − prepared
protected  = T − completed − cap                                 what no single fault can reach
maxLoss    = min(cap, inFlight + the next tranche)               what the screen calls "at most $X at risk"
```

Invariants, each pinned by a test:
- **I1** a tranche `i` is handed over only if `inFlight + amount[i] ≤ cap`;
- **I2** every piece satisfies `amount[i] ≤ cap` (the splitter guarantees it, §4);
- **I3** a tranche whose settlement cannot be read (the tracker unreachable, the job unknown) stays in
  flight — fail closed;
- **I4** at most `maxParallel` tranches are prepared at once (capital in escrows is bounded even though D1
  keeps it ours);
- **I5** completed and in-flight are reported separately and never netted (plan §47, §133).

The scenario of plan §132 — completed $247K, in flight $263K, cap $250K — is unreachable: I2 forbids a
$263K piece under a $250K cap, and I1 forbids a second release while the first is unsettled. **Only
unsettled funds count against the cap** (plan §133): a settled tranche frees its exposure the moment its
gate is reached. The provider-concentration limit (§10) is a separate, weaker control over the whole order.

*Implemented (Stage 1):* `exposure`, `canRelease` (I1, I2, the first tranche alone, the mode's concurrency), `canPrepare` (I4), `maximumLossModel`, `providerShares` (`campaign.ts`; the §132 state pinned unreachable in `test/campaign.test.ts`). *Stage 4* (the wallet), *Stage 5* (the screens).

## 6. Release modes and the settlement gate (plan V3 §19–§21, §83)

- **Sequential safety mode**: tranche N+1 is released only after tranche N reached its gate and the
  campaign is healthy on fresh facts (§8). The **first tranche is always alone** — the live health test
  of plan §21 — in every mode.
- **Parallel mode** (plan §20): in Balanced and Maximum Privacy, when two pieces fit under the cap
  (`maxParallel` 2, lab-calibrated), two tranches MAY be in flight, with different providers when two
  venues quote the size; the cap is the total, never per provider. **Never for an R5 or R6 route** (plan §19:
  sequential safety mode for the highest-risk routes — every bridge / MPC route runs one piece at a time).
  Maximum Safety and the institutional tier are sequential only.
- **The gate per class** (the owner's decision, 2026-10-08): R5 routes settle at **destination final**;
  R2/R4 routes at **destination submitted**; R1 at **source final**. Maximum Safety raises every gate to
  destination final.
- **Destination finality** (plan §83) is the provider's delivered state (`TrackStatus.completed` with a
  destination transaction) plus an **elapsed-time margin** after the outbound: Bitcoin 60 min, Solana
  1 min, EVM chains 15 min (lab-calibrated). The wallet MUST NOT query a third-party explorer for the
  destination (it would hand the destination to that service); the screen distinguishes "received" from
  "finalized" by the margin. "Destination submitted" is the provider's outbound observed.
- **What the trackers report** (informative): THORChain and Chainflip report partial fills with delivered
  and refunded amounts (V2 §12, §19); LI.FI reports partial without amounts; Mayan, NEAR and Across report
  completed, refunded or executing only. A route whose tracker cannot distinguish states settles on
  `completed` under I3.

*Implemented (Stage 1):* `gateFor`, `settledBy` and `FINALITY_MARGIN_SECONDS` (`campaign.ts`; an unknown state never settles). *Lab-calibrated (Stage 2):* the margins stand — a Bitcoin-bound step costs ≈ 2.1 h (an 18-minute stream, the 60-minute margin, the Balanced cadence), a week for $10M ETH → BTC; an EVM or Solana destination 1–4 days (`docs/privacy-lab.md`). *Stage 4* (the runner).

## 7. The campaign state machine (plan V3 §44)

The wizard steps DRAFT → QUOTING → RISK ANALYSIS → PRIVACY ANALYSIS → DESTINATION VERIFIED are screen
state (nothing is journaled, nothing is funded). The journal starts at the confirmation:

```
USER CONFIRMED ─▶ PREPARING NOTES ─▶ RUNNING ─▶ … ─▶ COMPLETED
                                       │  ▲
                                       ▼  │ resume (§8)
                                     PAUSED ─▶ REASSESSING ─▶ REQUOTING ─▶ REROUTING (a new Review)
                                       │
                                       └──▶ WINDING DOWN ─▶ CANCELLED
tranche:  planned ─▶ ready ─▶ committed ─▶ funded ─▶ signed ─▶ executing ─▶ source confirmed
          ─▶ destination submitted ─▶ settled | partial | refunding ─▶ refunded | failed | skipped
```

- A tranche is **one V1.1/V2 order**: `committed` = `/order` journaled as a child `StoredSwap`
  (`StoredSwap.campaign = { id, index }`), `funded` = the private withdrawal into its escrow (V2 §3 phase 2
  per tranche; the escrow holds it, D1), `signed` = prepare → the wallet's own check of the provider call →
  the signature → the simulation on every endpoint (V2 §24), kept in the wallet, `executing` = the
  hand-over to the executor (the only moment money becomes externally reachable), then the V2 §19 states
  through the tracker. The order machine of V1.1 §3 and the relayer's job machine of V2 §20 are unchanged.
- **One action per tick.** The runner (`frontend/src/wallet/campaignRunner.ts`) computes the next action
  from the journal and fresh facts with the pure reducer `nextAction(campaign, facts, now)`
  (`reference/typescript/src/wallet/campaign.ts`: `none | wait | shape-notes | commit | fund | sign |
  hand-over | track | pause | release-next | wind-down | complete`), journals the tranche state before the
  network call and re-reads the journal at the next tick. It runs on any tab while the wallet is unlocked
  (the scheduler of V2 §25) and resumes at unlock after a reconcile (§9).
- **Progressive confidence** (plan §21): `release-next` requires the previous tranche at its gate, the
  exposure invariants (§5), the bounds (§3), no pause condition on fresh facts (§8) and the cadence delay (§4).
- **Partial fills** (V2 §12) are not anomalies by themselves when the delivered amount meets the
  tranche's pro-rata minimum: the refunded part returns to `remaining` and is re-planned; a delivered amount
  below the minimum is an anomaly (§8).

*Implemented (Stage 1):* `nextAction`, `createCampaign`, `replan`, `withTrancheState`, `withCampaignState` (`campaign.ts`; every state walked in `test/campaign.test.ts`, incl. the continuation after a crash at each step: never a second funding or hand-over). *Implemented (Stage 4):* the runner `frontend/src/wallet/campaignRunner.ts` (`runCampaignTick`: reconcile every open tranche → track what is in flight → the pause facts → `nextAction` → one action → the next tick scheduled under the campaign's own `campaign-tick` action; the scheduler keeps a re-scheduled action pending), the wallet's campaign module `wallet/campaigns.ts` (`startCampaign` from the service's `protection` and the confirmation: the pieces from `planTranches` with the CSPRNG, the bounds, the reference rate, the risk snapshot, the first tick; `pauseCampaign`, `resumeCampaign`, `acceptReroute`, `cancelCampaign`, `replanRemainder`), and the three money-moving steps of an order extracted from the Swap screen into `sdk/swapExecute.ts` (`commitOrder`, `prepareAndSign`, `handOverSigned`, `returnOrderToBalance`, `resumeOrder`) so a tranche runs exactly a single order's machinery (the swap-flow and Review tests are unchanged and green). A tranche's child order carries `StoredSwap.campaign = { id, index }` and never gets a `fund-escrow` action. A partial fill whose remainder returned settles for the delivered part (source-unit equivalent at the tranche's expected rate) and the rest is re-planned. The reducer now holds a pause condition before the first commit too (`campaign.ts`). Tests: `frontend/test/campaign-runner.test.tsx` (9).

## 8. Pause, resume, reroute, cancel (plan V3 §22, §45, §76–§78)

A pause stops releasing tranches; it cannot recall an execution already handed over; in-flight tranches
are still tracked and may settle during the pause. Every pause journals its reason and raises an alert
(§15). Reasons:

| Reason | Fact |
|---|---|
| `price-deviation` | a tranche's hard quote below the price bound, or the Chainlink cross-rate moved beyond `MAX_DEVIATION_BPS` (§3) |
| `provider-error` | the relayer job `execute-failed` / `refund-failed`, the tracker `failed`, or the provider's breaker open (§10) |
| `chain-congestion` | the relayer's live gas price above 3 × its value at confirmation (lab-calibrated) |
| `route-degraded` | the chosen provider's reliability below 60 (V2 §16) or no live quote for the tranche size |
| `unexpected-destination` | the provider call's receiver differs from the tranche's destination (the wallet already refuses the call, V2 §21; the campaign pauses too) |
| `security-incident` | an incident for the provider dated after the campaign started (§10) |
| `anomaly` | a delivered amount below the tranche's guaranteed minimum (plan §45: $241K for $250K), a partial fill below the pro-rata minimum, or a settlement older than 3 × the plan's expected time |
| `reconcile` | a money-moving step ended with an unknown outcome (§9) |
| `bounds` | the next tranche would leave the bounds (§3): remaining limit, fee, expiry, destination |
| `user` | the campaign's Pause button |
| `wallet-pause` | the global "Pause large operations" switch (plan §59): it pauses the wallet's automation only, never the protocol (plan §60) |

- **Resume** always goes **reassess** (fresh facts: health, incidents, the cross-rate; the guards must
  clear) → **requote** (a fresh competition for the remaining amount: a new plan and risk snapshot) →
  **reroute** when the chosen provider changed: a route change on a high-value order is a major event
  (plan §77) that MUST be confirmed on a new Review (moment `reroute`) unless `settings.protection.autoReroute`
  is on and the tier is below high-value-secondary; at ≥ $5M the second factor is asked again. The wallet
  never changes the execution strategy quietly (plan §76).
- **Cancel** ("Return the rest to my private balance") → WINDING DOWN: planned tranches become `skipped`,
  funded unsigned tranches get a refund-only job (V2 §20: `deployAndRefund` at `refundAfter`, hours away
  with the short window of §3), in-flight tranches finish; COMPLETED or CANCELLED when nothing is open.
- **Never automatically continue** after an unexplained anomaly (plan §45): the engine determines why
  before releasing the next tranche; "why" is the user's decision on the Review when the facts cannot settle it.

*Implemented (Stage 1):* `detectPause` with `MAX_DEVIATION_BPS`, `CONGESTION_FACTOR`, `STALL_FACTOR` (`campaign.ts`; each reason in `test/campaign.test.ts`). *Implemented (Stage 4):* the runner's facts — the global switch, the Chainlink cross-rate from the price store (`crossRateFromPrices`), the provider's incidents and breaker from `GET /risk/:provider`, the relayer's gas price against the one journaled at confirmation, the tracker's state and the executor's job of the lowest in-flight tranche, its age against its plan, the delivered amount of a tranche settled in this tick against its guaranteed minimum (facts a minute old are re-read on a resume); every pause journals its reason and tranche, raises the §15 alert (`wallet/alerts.ts`) and notifies (`wallet/notifications.ts`); a hard quote below the price bound at signing pauses `price-deviation` (never a per-tranche consent); resume → `reassessing` → `requoting` (a fresh competition for the remaining amount) → `running` when the provider holds, `rerouting` with `pendingReroute` otherwise (adopted without a Review only under `settings.protection.autoReroute` below high-value-secondary; `acceptReroute`); cancel → `winding-down`: planned tranches `skipped`, a funded one handed a refund-only job, in-flight ones tracked to the end. *Stage 5* (the screens).

## 9. Recovery and duplicate-send protection (plan V3 §84–§89)

- **Reconcile before every money movement.** Before funding, signing or handing over, the runner reads
  the facts — the funding receipt through the RPC quorum, the predicted escrow's balance (V2 §19), the
  relayer job (`GET /swap/:orderId`), the tracker — and sets the tranche's state from them. A tranche with
  `fundedTx`, or whose escrow already holds the amount, is never funded twice; a tranche with a `jobId` is
  never handed over twice; the relayer keys jobs by `orderId` and replaces only its `REPLACEABLE` states
  (V2 §20). **No automatic retry on money movement** (plan §86): a network failure after a send is
  `reconcile` (§8), never "send again".
- **Unique ids** (plan §87): one `orderId` per tranche attempt (a requote after a pause is a new attempt
  with a new one-time key, `keys/swapKeys.ts`); the relayer's job id is the execution id; a retry MUST first
  prove the previous attempt did not settle (the facts above).
- **Provider timeout / destination failure** (plan §85): the tranche follows its own order's refund path
  (V2 §20); the amount returns to `remaining`; the campaign pauses with `provider-error` and reassesses.
- **Application crash / lock** (plan §85): the `campaign-tick` action survives in the journal; the first
  tick after unlock reconciles every non-terminal tranche before acting.
- **The local audit trail** (plan §88): the campaign journals every event — created, quote selected, risk
  assessment, confirmation, each tranche's transitions, every pause and resume, settlement — in the
  encrypted journal; it is exportable (V2 §24) and never uploaded.
- **Server logs** (plan §89, restating V2 §22/§25): the service and the relayer MAY hold random order
  ids that name nobody, provider, state and timestamps; never a user id, a portfolio, a private note, a source wallet, a
  private balance, a campaign id or a step index (none is sent to them). The relayer's job list
  (`GET /swap`) MUST require `RELAYER_ADMIN_TOKEN`: a campaign's N jobs are not listable by a third party.

*Implemented (Stage 4):* before funding the runner reads the journal's `fundedTx` and the predicted escrow's balance; before a hand-over the journal's `jobId` and `GET /swap/:orderId`; a tranche whose signature left memory (a reload) is signed again, never handed over without one; a funding that failed after the submission started (the withdrawal's status line) pauses `reconcile`, a failure before it is thrown to the scheduler's backoff; a hand-over whose answer was lost pauses `reconcile` and the next tick finds the executor's job; the `campaign-tick` action survives a lock and the first tick after unlock reconciles every open tranche (`campaignRunner.ts`, pinned in `campaign-runner.test.tsx`). *Implemented (Stage 3):* the relayer token.

## 10. Provider risk (plan V3 §23–§25, §49–§50, §113–§118, §134, §155)

- **The risk database** (plan §115): `services/private-swap/risk/providers/<id>.json` (class, custody
  model, upgradeability, audits with dates and scope, bug bounty, TVL, 30-day volume, security events,
  privacy events, last reviewed), `assets/<symbol>.json` (issuer, freeze and pause risk, decimals),
  `routes/<provider>-<from>-<to>.json` (gate, band, share cap, minimum tranche; **generated by the lab from
  measured data with `measuredAt`**, plan §116 — never hard-coded forever). An operator file
  (`INCIDENTS_FILE`, V2 §16) is reloaded on an interval; a malformed file adds nothing.
- **Security scoring with separate fields** (plan §114): `securityBreakdown(provider)` = baseline −
  incident penalties (V2 §16 decay) ± audit recency ± code-change recency ± TVL and volume bands ± bug
  bounty ± upgradeability (immutable > timelock > multisig > admin) ± bridge / validator model; "audited" is
  never a binary. The route health score (plan §24) is the V2 §4 components (security, liquidity, execution
  as price, latency, failure as reliability, privacy) shown per provider.
- **Histories** (plan §117–§118): security events (provider, incident, date, impact, affected chains and
  assets, recovery, status) and privacy events (metadata behaviour, address reuse, timing leakage, provider
  visibility) are kept and feed the score; the route engine never forgets a previous failure.
- **Circuit breaker extensions** (plan §23, §113): besides V2's three consecutive failures, the breaker
  opens on a failure-rate spike in the window, a settlement stall counted from `/track` (an execution
  older than 3 × its plan's time and unfinished), quote divergence (the price guard's gap at `/prepare`),
  and a new incident less than 24 h old; an expired breaker closes half-open (one probe).
- **Concentration** (plan §49–§50, §134): for very large orders no provider SHOULD carry more than
  `PROVIDER_SHARE_CAP_BPS` (500, lab-calibrated) of the whole order **when two or more providers quote the
  tranche size**; with one venue the recommendation says "single venue" and never diversifies for
  appearance; the privacy engine weighs diversification against metadata fragmentation (§11).
- **Expected loss per failure** (plan §155): `ELPF = P(failure) × capital exposed`, per tranche
  (`exposed` = the tranche) and per campaign (`exposed` = the cap); `P(failure)` = the class prior (an
  assumption until settlement history exists — Stage 2: 2 % for TSS / MPC vaults, 1.5 % for a relayer bridge or
  CCTP, 3 % for an intent — the service's failure window and incidents move it) × (1 + failures in the window / 3)
  × an incident factor. It is shown under Advanced and
  compared across modes.
- **The recommendation** (`recommendProtection`, `QuoteSet.protection`): class, band, cap fraction, gate,
  release mode, estimated steps and time, per-tranche impact and the thin-market flag, concentration, ELPF,
  and `staged` for $100K–$1M (true when the single venue's impact exceeds the cap or its reliability is
  below 60). It is advice: the wallet computes its own bounds and accounting from the shared core.

*Implemented (Stage 3):* `services/private-swap/src/risk/riskDb.ts` (`RiskDb.load(RISK_DB_DIR)`: `providers/`, `assets/`, `routes/` validated field by field, `problems` listed, `override(provider, pair)` for the shared risk model, `incidents()`), `risk/security.ts` (`securityBreakdown`: baseline − decaying incidents ± audit recency ± code change ± bug bounty ± TVL ± upgradeability, every field reported, unknown adjusts nothing; `securityScore` in `health.ts` is its total — the V2 pins hold), `health.ts` (`incidents()` = the database's security events + `INCIDENTS_FILE` re-read every 60 s; `ProviderHealthTracker.recordSettlementStall(provider, key)`, `recordQuoteDivergence`, `recordIncident`; the breaker opens on 3 consecutive failures, 6 in the window, 2 stalls, 3 divergences or an incident < 24 h, closes on any success, and after expiry allows one probe whose failure reopens it; `state(provider)`), `risk/protection.ts` (`recommendProtection` → `Protection`; `protectionFor` attaches `QuoteSet.protection` and `QuoteSet.risk` from the enhanced tier in `quoteAll`, USD per unit from the same valuation as the tier; `CADENCE_SECONDS`, `PROVIDER_SHARE_CAP_BPS` 500, `capBpsFor`), the routes `GET /risk` and `GET /risk/:provider` (record without its events, breakdown, breaker state, routes), `/health` (incident counts, database counts and problems), `/prepare` feeding `recordQuoteDivergence` on the price guard's refusal, `/track?since&expected` counting a stall (`stalled: true`) once per execution, and `mode` on `/quote`, `/order`, `/guest/quote`. Records shipped: six providers (THORChain's GG20 incident moved here from the code; audits deliberately *not recorded* until taken from the published reports), three assets, fourteen lab-generated routes. Tests: `services/private-swap/test/risk.test.ts` (12).

## 11. Privacy under protection (plan V3 §16, §30, §50–§55, §101–§103, §129–§130, §154)

- **Randomization is not security** (plan §16): varying sizes and times is one component; the set still
  needs common amounts, fresh destinations, private submission, provider separation and timing diversity.
  The wallet MUST NOT say "anonymous" or "100 % private" (V2 §18).
- **What a campaign reveals** (honest statement): N public withdrawals of common sizes to N fresh escrows
  on a random cadence, each followed by a provider deposit whose memo or calldata publishes the destination
  (V2 §17: every adapter's link is public). An observer who clusters them sees a campaign; the labs
  measure how much (§18) and the Privacy Center says it. Diversifying providers adds timestamps, amounts
  and endpoints (plan §50): the engine optimises diversification against fragmentation, not either alone.
- **Lint additions** (V2 §18): `same-size-consecutive` (warn: two consecutive tranches of the same size
  under `varied`; informative under `bucket`), `tranche-link` (warn: an entered destination links every
  tranche publicly; fresh-per-tranche does not), `exact-cadence` (block: a release pattern with a fixed
  interval — the wallet never produces one), `destination-cooling` (block at ≥ high-value until the
  entered destination is verified and out of cooling-off, §12).
- **Private restructuring first** (plan §51, §55): a large cross-chain operation goes public funding wallet
  → private pool → private restructuring (§4) → tranche → fresh escrow → provider → fresh destination,
  never permanent wallet → provider → permanent address (plan §127: one-time source and destination).
- **Modes** (plan §101–§105): Maximum Privacy = fewer public exits (the `bucket` sizing, the widest
  cadence, `best-privacy` scheduling) under the same cap; Maximum Safety = the lowest band, sequential,
  mandatory destination verification, the second device, diversification where possible, "execution may
  take longer"; Balanced = the default of §14. The wallet, not the user, finds the balance (plan §101).
- **The cross-chain privacy metric** (plan §130): source, destination, cross-chain, amount, timing and
  provider linkability per route → the cross-chain privacy score (the V2 §17 cross-chain term extended
  with the campaign's arrival pattern, measured in §18).

*Implemented (Stage 1):* the four items and `LintFacts.campaign` (`reference/typescript/src/wallet/privacyLint.ts`; `test/privacyLint.test.ts`). *Measured (Stage 2, `docs/privacy-lab.md` "High-value protection"):* per piece a campaign's withdrawal hides as well as any bucketed piece of its size (joint effective set 8–24 against 1.6 for one escrow), but 17–24 % of the same-size withdrawals inside a campaign's window are the campaign's own, and on the cross-chain side 65–72 % of the same-size arrivals — a campaign is a public pattern on both sides; the wallet says so. *Stage 5* (the screens).

## 12. Destination protection (plan V3 §35–§40, §126–§128)

- **The address book** is journaled (`journal.addressBook`, optional): `{ id, chain, asset?, address,
  normalized, label, addedAt, lifecycle: generated | verified | used | settled | retired, verification:
  { status, method, at }, coolingUntil?, override?, lastUsedAt, usedBy }`. It is local; it is never sent
  anywhere (plan §35; V2 §22).
- **Verification methods**: `derived` (the wallet's own fresh addresses, re-derived at use — verified by
  construction), `groups-read` (the grouped address re-typed group by group, V2 §21), `signed-message`
  (an EVM address proves control by a signed message the wallet checks), `test-transaction` (one smallest
  piece sent first; the wallet says "⚠ This test creates public transaction metadata", plan §40).
  Cryptographic verification is preferred; the test transaction is the fallback.
- **Rules**: an entered destination MUST be verified before any operation at ≥ high-value (plan §36);
  a newly added entered destination is in **cooling-off** for 24 h (plan §38) before a ≥ high-value
  operation may fund toward it — the campaign MAY be confirmed, its first funding waits like the review hold;
  the **Immediate** override requires the typed phrase, the second factor (or the second device at
  institutional) and the hold, and is journaled. Fresh addresses skip cooling. A `retired` entry is never
  selected automatically (plan §128); a reused entry is warned (`tranche-link`).
- **Lifecycle** (plan §128): fresh addresses are `generated` at reservation, `verified` by derivation,
  `used` at hand-over, `settled` when the tranche settles, `retired` afterwards; entered addresses go
  `verified` → `used` → `settled` and stay usable but warned.
- **Simplified allowlisting** (plan §37): the book is the allowlist; velocity and threshold controls are the
  tiers and the cap (§5, §14); roles and multi-operator approval are out of scope (§19).

*Implemented (Stage 1):* `reference/typescript/src/wallet/addressBook.ts` (`addEntry`, `verifyEntry`, `overrideCooling`, `canUse`, `markUsed`, `markSettled`, `retire`, `selectable`, `useStatus`; `test/addressBook.test.ts`). *Stage 6* (the screens).

## 13. Approvals (plan V3 §33–§34)

- The wallet never approves `MAX_UINT256`: the shield approves the exact amount (V1.1, `shieldERC20`),
  and after a failed deposit the remaining allowance is shown and can be revoked (approve 0) from Settings
  → Advanced; the wallet reads allowances through the injected wallet's own provider (no address ↔ RPC link).
- The escrow approves the provider for its whole post-tip balance at execute and the vault for the exact
  amount at refund (bytecode, unchanged). A provider that pulls less keeps an allowance over that one
  escrow only: D1 bounds it to the tranche. This is documented as a known limit (audit package).

*Stage 6.*

## 14. Value modes and controls (plan V3 §68–§72, §104–§105)

The V2 §13 tiers gain the protection columns (USD thresholds configurable as before):

| Tier | Value | Confirmation (V2 §24) | Protection |
|---|---|---|---|
| standard | < 100,000 | one tap | none (plan §68) |
| enhanced | ≥ 100,000 | Review + lint | simulation, destination verification, lint; **staged only when `staged`** (a single venue with impact > cap or reliability < 60), then one tranche band of 2.0–3.0 % (plan §69) |
| high-value | ≥ 1,000,000 | + simulation + hold | **tranches** (band per class), the destination lock (§12), route competition, execution monitoring; cap 2.5 % Balanced (plan §70) |
| high-value-secondary | ≥ 5,000,000 | + the second factor | + cap 2.0 %, provider diversification when two venues quote the size, the second factor again on reroute (plan §71) |
| institutional | ≥ 10,000,000 | + the review hold and the export | + sequential only, band 2.0–2.5 %, the strongest route verification, the **second factor on a separate device** (a WebAuthn cross-platform credential — a security key or a phone — with no password fallback), the cooling-off never bypassed without it (plan §72) |

- **Modes** (`settings.protection.mode`): Balanced (cap 2.5 %, streaming, fresh endpoints, hard minimum
  output, automatic lint — the recommended default, plan §105), Maximum Privacy (plan §103), Maximum
  Safety (plan §104). The exposure fraction is user-adjustable within 2.0–3.0 %; 3 % only when the risk
  engine permits (an R1/R2 route with impact under the cap, plan §72, §74).
- **The global switch** "Pause large operations" (plan §59) pauses every campaign's automation; it never
  touches the protocol (plan §60: a protocol pause is forbidden and does not exist, V1.0).
- **Device protection** (plan §61–§64): the platform authenticator at ≥ $5M (V2 §24), the separate device
  at ≥ $10M; a compromised phone does not reach the institutional threshold alone; threshold signing across
  devices is out of scope (§19).

*Implemented (Stage 4):* `settings.protection` — `mode`, `capBps` (inside 200–300; above the recommendation only on an R1 / R2 route), `pauseLargeOperations`, `autoReroute`, `notifications { inApp, system, generic }`, `secondDevice { enabled, credentialId }` — healed from a V2 journal (`healProtection`), with `PROTECTION_DEFAULTS` per mode (cap, sizing, cadence, the words) mirroring the lab's constants (`frontend/src/wallet/settings.ts`). *Implemented (Stage 5):* the controls `campaign` (from high-value; at enhanced only when the service says `staged`), `destinationLock`, `coolingOff` (from high-value) and `secondDevice` (institutional) in `frontend/src/sdk/tiers.ts`; the separate device is a cross-platform WebAuthn credential registered under Settings → Protected execution (`registerSecondDevice`, `sdk/secondFactor.ts`) and asked by the Review after the second factor with no password fallback (an unregistered device refuses the confirmation); Settings → Protected execution offers the three modes with their words, the exposure fraction bounded to 2.0–3.0 %, the global switch, the notification choices and the device. Tests: `frontend/test/campaign-screens.test.tsx`, `campaign-flow.test.tsx`.

## 15. Screens, alerts and notifications (plan V3 §43, §46–§47, §65–§67, §75–§77, §93–§94, §140–§146)

- **Before the start** (plan §46, §93): the Swap screen at ≥ high-value shows the protection line
  ("Protected execution · about N steps of ≈ $X · one at a time · at most $Y at risk · about T"); the
  Review (moment `campaign`) shows the **maximum-loss model** — Order, in-flight cap, maximum external
  exposure, remaining protected, preparation cost — the five lines of V2 §24 plus **Exposure** (the cap
  and the gate in words), and the **combined verdict** (plan §43): SECURITY ("Safe to execute" / "Review" /
  "Do not execute") and PRIVACY (the level word). "Safe to execute" MUST NEVER be shown without the privacy
  line. Advanced (plan §94): the provider, streaming and internal legs, LP fee, gas, settlement confidence,
  the band, the gate, ELPF, concentration, the alternative and its price difference.
- **During** (plan §47, §66–§67, §143): "Step k of ~N", completed ✓, executing …, remaining, the protection
  bar (completed · in flight · prepared · protected), the privacy level; Completed / In progress /
  Protected / Remaining are visible at all times (the user never wonders where the funds are); "You can
  safely leave this screen — keep the wallet unlocked" (the web wallet; native background execution is
  out of scope, §19). The three statuses ✓ Protected / ⚠ Review / ● Processing; no red walls (plan §141).
- **The exposure dashboard** (plan §75, Advanced): order, in flight, maximum allowed, provider, provider
  exposure, remaining, the per-tranche table, the pause history, ELPF.
- **Alerts** (plan §76): provider degraded, price changed, liquidity dropped, destination changed, route
  changed, execution delayed, chain congested, security incident, paused, step settled — in-app always;
  the browser `Notification` API only when enabled and the tab is hidden, with the text "Your private
  operation has updated" unless amount previews are enabled (plan §145–§146). No push server.
- **Wording**: "Best execution", never "<provider> is our official bridge" (plan §112); never "atomic",
  never "anonymous".

*Implemented (Stage 5):* the Swap screen shows the protection line under the quote from high-value (`Protected execution: about N steps of ≈ $X · one at a time · at most $Y at risk · about T`), runs the wizard (risk analysis → privacy analysis → destination check; screen state only) and the Review at the `campaign` moment with the five lines plus **Exposure** and **Security**, the maximum-loss block (order, in-flight cap, maximum external exposure, remaining protected, preparation cost from the relayer's live fee), the combined verdict (SECURITY: Safe to execute / Review / Do not execute from the provider's security total, reliability, incidents and the thin-market flag; PRIVACY: the level word — one block, pinned: never one without the other) and, under Advanced, the class, band, cap, gate, steps, duration, cadence, ELPF, concentration and the alternative (`components/Swap.tsx`, `components/Review.tsx`); the confirmation journals the campaign and shows `protection/CampaignProgress.tsx` (Step k of ~N, the protection bar completed · in flight · prepared · protected, the four amounts always visible, the privacy level, the statuses ✓ Protected / ⚠ Review / ● Processing, the pause with its reason and Resume, the reroute with its Review, Pause and Return the rest, the per-step lines under Advanced, the last alerts, the one sentence about leaving the screen); the reroute Review at the `reroute` moment; Home shows the campaign line with the global switch while a campaign runs; Activity shows one row per campaign and its steps under Advanced only; the trade check carries the plan (§16). *Stage 7* (the dashboard).

## 16. zkAPI and the AI (plan V3 §90–§92)

The trade check of V2 §22 carries the protection plan (class, band, steps, gate, ELPF, concentration)
in its sanitized summary — never an address, hash, balance or identity — and the private session may
recommend, simulate, explain and warn about a campaign; it cannot sign, authorize, bypass a limit or
change a destination (the module imports nothing that can, pinned). The metered quote gateway stays as
in V2 §22. *Implemented (Stage 5):* `TradeSummary.protection` (`frontend/src/zkapi/tradeCheck.ts`: class, custody, band, cap, steps, gate, concurrency, ELPF rounded, concentration in words, `staged`), sent from the campaign Review; the import pin of V2 holds.

## 17. The journal and the relayer's list (plan V3 §88)

- `JournalData.campaigns?: Campaign[]` (id, state, mode, tier, value, request, bounds, plan, tranches
  with their histories, the reference rate, the risk snapshot, the lint, the pause, confirmations, alerts,
  history), `JournalData.addressBook?`, `StoredSwap.campaign?: { id, index }`, `ScheduledAction.kind` +
  `campaign-tick | campaign-shape`, `ActivityRecord.kind` + `campaign`, `settings.protection`. **Every field
  is optional and never written by `emptyJournal()`** (V2 §25): the pinned at-rest vectors stay valid and a
  V2 journal round-trips byte-identically (pinned).
- `GET /swap` on the relayer requires `RELAYER_ADMIN_TOKEN` (§9).

*Implemented (Stage 4):* `campaigns?`, `addressBook?`, `StoredSwap.campaign?`, the two action kinds and the `campaign` activity kind (`frontend/src/wallet/journal.ts`, `activity.ts`; `docs/wallet-formats.md`); `emptyJournal()` is unchanged and a V2 journal round-trips byte for byte (pinned in `campaign-runner.test.tsx`); the shared `Campaign` gained optional `provider`, `policy`, `gasPriceAtConfirmationWei`, `pendingReroute`, `alerts`, `lint`, `value`, and a tranche `outcome.deliveredOut`, `quoteExpiresAt`, `jobId` (all optional). *Implemented (Stage 3):* the relayer's `GET /swap` answers 403 `admin_closed` without `RELAYER_ADMIN_TOKEN` and 401 `admin_token` without the exact bearer token (`services/relayer/src/admin.ts`, timing-safe; `test/admin.test.ts`); the local stack sets the token and its browser run sends it.

## 18. Labs and acceptance (plan V3 §131–§132, §151–§155)

- **The campaign lab** (`benchmarks/whale/run-campaign.mjs`, `reference/typescript/src/sim/campaignLab.ts`):
  the reducer against a simulated world for $1M, $2M, $5M, $10M, $25M, $50M on EVM → EVM, EVM → BTC,
  EVM → SOL, BTC → EVM, SOL → EVM, from the measured quotes of `benchmarks/whale/execution.json`: steps,
  wall time with the gate margins, pauses, gas at the live price, the providers that serve a tranche.
- **Failure injection** (plan §152): provider outage, quote mismatch, price spike, chain congestion, RPC
  failure, destination error, wrong chain, wrong token, reorg, bridge timeout, solver failure, app crash,
  network disconnect — each against each campaign state. **Capital-loss simulation** (plan §153): the
  maximum possible loss per fault, which MUST be at most one active tranche plus nothing (the cap), never
  the order. **ELPF** per fault and mode (§10).
- **Privacy simulation** (plan §154): timing, amount, timing × amount, provider and cross-chain
  linkability for the Tornado baseline, the V2 single escrow, and V3 campaigns (`bucket` and `varied`,
  gated cadence), in `whaleUtxoLab.ts` and `crossChainLab.ts`; the numbers go to `docs/privacy-lab.md`
  and decide the defaults of §4 and §14.
- **Acceptance** (plan §131): $1M — destination validation, simulation, lint, a tranche plan; $5M — plus
  the second confirmation and provider-health monitoring; $10M — plus ≤ 2.5–3 % exposure, sequential
  settlement, automatic route re-evaluation. The §132 scenario and the invariants of §5 are tests; the
  local-stack browser run (V2) shows a $10M campaign's first tranche executing and the campaign waiting
  at the gate (a devnet never delivers), the dashboard, the switch, cancel and a reload.

*Measured (Stage 2):* `benchmarks/whale/campaign.md` — ETH → BTC through THORChain streaming: $1M 70 steps of $10K–$24K in 141 h, $10M 78 steps of $113K–$128K in 167 h (Maximum Safety 146 h, Maximum Privacy 363 h), $50M 97 steps of $514K–$695K in 215 h; gas $92–$128 per campaign at the price fetched when the lab ran; every one of the 192 campaigns completed with the invariants held. The thirteen faults at the middle tranche of the $10M campaign: a pause before any money moved for an outage, a quote mismatch, a reorg, a wrong chain or token and a wrong destination (the last three cancelled, the rest returned); the tranche in flight ($128K, under the $200K cap) for a price spike, congestion, an RPC failure, a crash or a disconnect; the same for a solver failure (returned at the refund window and re-planned as one more tranche) and a bridge timeout (an anomaly pause after three times the expected time; the step returns when the provider refunds it hours later, 4.5 h in the lab). Each tranche was funded and handed over exactly once in every run. ELPF with the assumed priors: $2.6K per tranche, $4K per campaign cap. `reference/typescript/test/campaignLab.test.ts` pins the invariants, the single funding per tranche and the loss bound per fault. *Stage 1 / 4 / 5* (the tests), *Stage 7* (the browser run).

## 19. Study notes and out of scope here

- **`PrivateExecutionEscrow`** (plan §124–§125): a trust-minimized temporary execution boundary with strict
  amount bounds, destination, expiry, refund and no arbitrary call is what `SwapOrderEscrow` already is for
  one order, except that its provider call is arbitrary calldata signed by the one-time key. A stricter
  escrow (a provider allowlist on chain, a bounded call shape) would add bytecode, a new creation hash and
  an attack surface; "prefer no escrow where possible" and the one-use execution account (plan §125–§126)
  are the direction when a provider can execute from a user-controlled fresh address — a separate security
  study, not this pass.
- **UniswapX RFQ (R2)**: the interface of V2 §11 and its escrow requirement (EIP-1271) stay deferred.
  **OTC / R6** (plan §11): an interface only — counterparty, settlement, collateral, reputation, legal
  entity and settlement method as risk-database fields; no desk is integrated.
- **Multi-device threshold approval** (plan §61–§64): a 2-of-3 across devices needs a second-device
  channel the server only orchestrates; the separate-device second factor of §14 is the in-scope control.
- **Push notifications, background execution, native shells** (plan §144–§149): the web wallet runs
  campaigns while unlocked and resumes at unlock; in-app alerts and local notifications only.
- Third-party explorer queries for destination finality (§6); execution with real funds and the testnet
  broadcast; independent audits.
