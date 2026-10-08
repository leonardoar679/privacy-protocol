# High-Value Execution Engine — Implementation Contract V1.0

Normative. This is the implementation contract between the **Privacy Wallet** (`frontend/`, with the pure
modules it shares under `reference/typescript/src/wallet/`), the **HighValueProtectionEngine** (the campaign
core and its three users: the wallet's runner, the service's recommendation and the labs) and the
**PrivateSwapEngine** (`services/private-swap/`, `services/relayer/`). It is the "immediate next document"
asked for by the High-Value Execution Engine plan §133 (the "plan" below; its §1–§133 are the authority for
the V4 pass): it freezes the twelve types the plan names and their state transitions, maps the plan's
thirteen engines (§8) onto the modules that exist, and states section by section what the V4 pass changes.
The High-Value Protection Specification V1.0 (`docs/high-value-protection-spec-v1.0.md`, the "V3 spec") stays
in force; where the plan and the V3 spec use different names both are given, and the code's name is the one
in `Code:` lines. The whole V3 spec is implemented at commit `12089c4`; the V4 additions are marked *V4*.

**What this contract leaves unchanged.** PrivacyCore, the vaults, the circuits, the escrow bytecode
(`SwapOrderEscrow` / `SwapOrderFactory`), the V1.1 order machine, the relayer's job machine, the V2 whale
layer and the V3 protection layer except where a section says *V4*. The service never holds a user's
portfolio, address list or identity (whale spec §22, §25); the AI never signs (plan §75); the wallet never
claims atomicity (V1.1 §3) and never says "anonymous" (plan §51).

The key words MUST, MUST NOT, SHOULD, MAY are RFC-2119.

---

## 1. The parties and the engine map (plan §8, §61, §74, §130)

The plan's thirteen engines are not thirteen services: they are modules of the three parties, and the
contract between the parties is the set of types in §3 and the state machines in §4.

| Plan §8 engine | Code | Party |
|---|---|---|
| OrderClassifier | `reference/typescript/src/wallet/valuation.ts` (`tierOf`, the fail-safe at high-value when no price is available), `services/private-swap/src/valuation.ts`; *V4* `exposurePolicy.ts` (the value band → policy row, §2) | wallet + service (the higher tier applies) |
| RiskEngine | `riskClasses.ts` (`riskModelOf`, `narrowedBand`, `expectedLossPerFailure`), `services/private-swap/src/risk/{riskDb,security}.ts`; *V4* `exposurePolicy.ts` (`exposureTierOf`), `privacyAssessment.ts` | shared core + service |
| ExposureManager | `campaign.ts` (`exposure`, `canRelease`, `canPrepare`; *V4* `ledger`, `byProvider`, invariant I6) | shared core, run by the wallet |
| TrancheEngine | `campaign.ts` (`planTranches`, `replan`), `frontend/src/wallet/campaigns.ts` (`buildCampaign`, `replanRemainder`) | shared core + wallet |
| QuoteEngine | `services/private-swap/src/engine.ts` (`quoteAll`: every capable provider in parallel, the competition record); *V4* `normalize.ts` | service |
| RouteEngine | `scoring.ts` (`scoreRoutes`, `chooseRoute`, `priceGuard`), `adapters/*` | service |
| SimulationEngine | `frontend/src/sdk/simulate.ts` (the provider call on every RPC endpoint before a signature), `reference/typescript/src/sim/campaignLab.ts` (the labs) | wallet + labs |
| PrivacyEngine | `privacyLint.ts`, `services/private-swap/src/privacyScore.ts`, `privacyCenter.ts`; *V4* `privacyAssessment.ts` (§3.11) | shared core + service |
| DestinationGuard | `addressBook.ts`, `destinations.ts`, `frontend/src/wallet/addressBook.ts`, `frontend/src/components/protection/AddressBook.tsx`, `DestinationCard.tsx` | shared core + wallet |
| ProviderHealth | `services/private-swap/src/health.ts` (`ProviderHealthTracker`, the breaker), `GET /risk`, `GET /risk/:provider` | service |
| SettlementMonitor | `frontend/src/sdk/orderTracker.ts` (`deriveState`, `trackOrder`), the runner's `reconcileAndTrack`, `GET /track/:provider` | wallet + service (stateless) |
| RecoveryEngine | the runner's reconcile (`frontend/src/wallet/campaignRunner.ts`), `sdk/swapExecute.ts` (`returnOrderToBalance`), the relayer's refund-only jobs and late-refund watch, the escrow's `refund` / `refundToken` | wallet + relayer + chain |
| PolicyEngine | `frontend/src/wallet/settings.ts` (`protection`), `sdk/tiers.ts` (`controlsFor`); *V4* `exposurePolicy.ts` (`capBpsFor`) | wallet (software policy, no administrator: plan §129) |

- **The wallet's journal** (plan §73) holds, encrypted: the campaign with its bounds, plan, tranches, risk
  snapshot, lint and alerts; each tranche's child order (`StoredSwap`) with its quote, params, funding and
  execution transactions, job id, settlement reads and history; the address book. `Code:`
  `frontend/src/wallet/journal.ts` (`campaigns?`, `addressBook?`, `StoredSwap.campaign?`), `docs/wallet-formats.md`.
- **The server-side journal** (plan §74) is the relayer's job list — job id, escrow, state, transaction
  hashes, timestamps — behind `RELAYER_ADMIN_TOKEN`, and the service's stateless reads. No wallet identity,
  no notes, no master key, no financial history. `Code:` `services/relayer/src/journal.ts`, `admin.ts`.
- **Mobile architecture** (plan §59–§61): the Rust core (`core/rust`, with the UniFFI and WASM bindings) is the
  crypto / prover layer; the engine runs above it in TypeScript. A native shell is out of scope here (§10);
  the web wallet runs campaigns while unlocked and resumes at unlock.

---

## 2. The policy table and the exposure tiers (plan §2–§6, §22, §80–§81, §90–§93) — *V4*

**Principle (plan §2–§3).** Never expose more capital to an external execution risk boundary than
necessary. The policy is a **maximum simultaneous unsettled exposure**, not a maximum transaction size: a
tranche MAY be executed by its provider as a stream of many parts and still counts as one exposure (V3 §4).

### 2.1 Value bands (plan §4)

The V2 tiers (`valuation.ts`, thresholds configurable in Settings) carry the plan's rows. Every figure is an
engineering default (plan §4) that the benchmark of §9 revises; the caps are bps of the order.

| Plan §4 band | Tier | Mode word | Default cap | User range | Protection layer |
|---|---|---|---|---|---|
| < $100K | standard | Normal | — | — | none |
| $100K – $1M | enhanced | Protected | 500 | 100 – 500 | a campaign when the service says `staged` (V3 §14) **or the user opts in** ("Protect this order", *V4*) |
| $1M – $5M | high-value | High Value | 250 | 100 – 300 | always (plan §91, §126) |
| $5M – $10M | high-value-secondary | Very High Value | 250 | 100 – 300 | always, + the second factor |
| > $10M | institutional | Extreme Value | 200 (inside the plan's 1 – 2.5 %) | 100 – 250 | always, sequential, + the separate device |
| an unknown / high-risk route (exposure tier R4, §2.2) | any | Maximum Safety | 100 | 100 | always |

The mode (`settings.protection.mode`) applies on top: **Balanced** keeps the band's default; **Maximum
Privacy** keeps it with bucket sizing and the widest cadence; **Maximum Safety** is 100 bps everywhere,
sequential, destination-final (plan §90); **Best Execution** (*V4*, plan §90) keeps the band's default,
releases in parallel where the class allows, uses the `best-execution` scoring preset (§7) and the shortest
cadence. The plan's §91 default for a high-value user is Balanced with the protection layer on.

### 2.2 Exposure tiers R0–R4 (plan §5–§6)

An exposure tier is **derived** at quote time and at every requote from the V3 risk model and the live facts,
never stored as policy:

| Tier | Plan §6 | Derived from | Cap range |
|---|---|---|---|
| R0 Atomic | same-chain, atomic, audited, deep liquidity | risk class R1 (no provider today) | 500 – 1000, subject to the simulation |
| R1 Controlled RFQ | a signed hard quote with strict bounds, a reliable counterparty | class R2 whose hard quote is a signed bound (UniswapX: deferred, §10; none today) | 250 – 500 |
| R2 Streaming | a provider-controlled stream of a large trade | a streamed plan (`plan.mode` streaming / dca) on class R5 | 250 |
| R3 Cross-chain intent | solver, bridge, MPC / TSS, non-atomic settlement | every other R2 / R4 / R5 route | 100 – 250 |
| R4 Unknown / high-risk | low liquidity, a new provider, an unstable chain, a recent incident, uncertain settlement | a thin market (§2.3), no record in the risk database, a halted chain, an incident ≤ 30 days, an open breaker, class R6 | ≤ 100 |

The effective cap is `min(band default, tier maximum, mode cap, the user's fraction clipped to the band's
range)`; a fraction above the band's default is allowed only on an R0 / R1 route (V3 §14's "3 % only where the
risk engine permits" kept). `Code:` `reference/typescript/src/wallet/exposurePolicy.ts` (`EXPOSURE_POLICY`,
`exposureTierOf`, `capBpsFor`), `services/private-swap/src/risk/protection.ts` (`Protection.exposureTier`),
`frontend/src/wallet/settings.ts` (`capCeilingFor`).

### 2.3 The market-impact limit (plan §80–§81)

`IMPACT_LIMIT_BPS` (50, lab-calibrated 2026-10-07) is a control **separate** from the exposure cap. A tranche
whose quoted impact exceeds it MUST be remedied, in this order, and the remedy applied MUST be reported:
`reduce-tranche` (the piece is halved until its impact fits, V3), `rfq` (an R1 venue that quotes the size — none
today), `streaming` (the provider's streamed plan), `other-venue` (the competition at the step's size, V3 §8). A
piece that cannot be remedied under the cap stays a thin-market finding on the Review. `Code:`
`risk/protection.ts` (`impactRemedy`), `scoring.ts` (`IMPACT_CAP_BPS`).

### 2.4 Velocity (plan §62) — *V4*

`settings.protection.velocity.maxUsdPer24h` is optional and off by default. The runner MUST NOT hand over a
tranche when the hand-overs of the trailing 24 h plus it would exceed the limit; the campaign pauses with
reason `velocity` and resumes under the ordinary resume rules. The limit lives in the wallet's journal only
(self-custody, plan §63). `Code:` `campaign.ts` (`PauseReason`), `campaignRunner.ts`.

---

## 3. The twelve frozen types (plan §9, §133)

The interfaces below are the code's, verbatim where a `Code:` line names the file (bigints travel as decimal
strings in the journal and on the wire; the type says which). The plan's name heads each item; the code's name
follows. Changing a frozen field is a new contract version.

### 3.1 ExecutionEnvelope → `ExecutionBounds` (plan §9–§10, §16; V3 §3)

The plan's `HighValueOrder` (§9) is the campaign (§3.6 carries the rest of its fields); what one confirmation
binds (§10) is:

```ts
export interface ExecutionBounds {
  orderId: string;                       // the campaign id: uniformly random, never derived from identity
  assetIn: AssetRefLike; chainIn: string;
  amountInLimit: string;                 // the whole order in base units; the sum of every tranche funded never exceeds it
  assetOut: AssetRefLike; chainOut: string;
  destination: DestinationPolicy;        // { kind: "fresh-per-tranche" } | { kind: "entered" | "book"; address; bookId? }
  minimumOutput: string;                 // the minimum output PER SOURCE UNIT, 1e18 fixed point (plan §13–§14)
  expiry: number;                        // unix seconds: no tranche is committed after it (plan §12)
  maxFeeBps: number;                     // the tip plus the relayer fee ceiling per tranche (plan §15)
  privacyMode: ProtectionMode;           // "balanced" | "max-privacy" | "max-safety" | "best-execution" (V4)
  maxExternalExposure: string;           // the in-flight cap in base units (plan §2, §26)
  executeWindowSeconds: number;          // the per-tranche execution window: executeDeadline = quote expiry + this
}
export interface AssetRefLike { chain: string; asset: string; decimals: number; symbol: string }
```

What the user signs (plan §10) is bound twice: per tranche **on chain** by the escrow (asset, amount, the
destination inside the provider call, the approved minimum inside the calldata, the deadline, the tip — V1.1
§6, V2 §3) and for the campaign **in the journal** by these bounds, checked by `checkWithinBounds` before every
commit and by the pause facts before every hand-over. A provider never gets more than one tranche's escrow
balance, a different destination, a lower minimum, a later deadline or a larger fee (V1.1 D1 per tranche).
Unbounded slippage is prohibited (plan §14): `minimumOutput` is derived from the confirmation quote's minimum
less the tier's tolerance (50 bps at ≥ high-value), never from a percentage the user types. `Code:`
`reference/typescript/src/wallet/campaign.ts`.

### 3.2 Quote → `Quote` + `NormalizedQuote` (plan §11–§12, §41–§42; V2 §2)

```ts
export interface Quote {
  provider: ProviderId; category: RouteCategory;
  toAmount: bigint; toAmountMin: bigint;        // expected and guaranteed, destination base units
  fees: Fee[]; etaSeconds: number;
  expiresAt: number;                            // unix seconds: after it, DO NOT EXECUTE (plan §12)
  nativeAssets: boolean; minOutEncoded: boolean; minOutVerified?: boolean;
  refundTarget?: "escrow" | "destination"; hops: string[]; raw: unknown; obtainedAt: number;
  plan?: ExecutionPlan;                         // { mode: "single" | "streaming" | "dca" | "auction" | "intent"; parts; intervalBlocks; expectedSeconds }
  impactBps?: number; limits?: { min?: bigint; max?: bigint; maxInstant?: bigint }; sizeSignals?: string[];
}
/** V4 (plan §42): every provider's quote in one shape, so routes compare like with like. */
export interface NormalizedQuote {
  provider: ProviderId;
  netAmountOut: string;        // toAmountMin: what the destination is guaranteed, base units of `to`
  grossAmountOut: string;      // toAmount: the expected output before the provider's own deductions
  providerFee: string | null;  // protocol + affiliate + liquidity fees in the source asset's USD, when stated
  networkFee: string | null;   // network + gas fees, USD, when stated
  estimatedGas: string | null; // the source-side gas of the provider call in units, when the adapter states it
  estimatedDuration: number;   // seconds: the plan's expected time, else etaSeconds
  routeRisk: { class: RiskClass; flags: RiskClass[]; exposureTier: ExposureTier; security: number; reliability: number };
  privacyRisk: { score: number; linkPublic: boolean };
}
```

Indicative quotes (phase 1) carry a placeholder destination (V2 §5); the hard quote at `/prepare` carries the
chosen provider only. `Code:` `services/private-swap/src/types.ts`, `normalize.ts` (*V4*).

### 3.3 HardQuote → the prepared order (plan §11, §108; V2 §3, §14)

```ts
/** What /prepare returns and the wallet checks before it signs (sdk/providerCall.ts), per tranche. */
export interface HardQuote {
  orderId: `0x${string}`; provider: ProviderId;
  quote: Quote;                       // refreshed at prepare; toAmountMin ≥ the approved minimum or the wallet refuses
  ingress: Ingress;                   // { kind; to; calldata; value; memo?; expiresAt; minOutEncoded; verified?; refundTokens? }
  approvedMin: string;                // the minimum the user approved (destination base units), encoded in the call
  signedDeadline: number;             // min(quote.expiresAt, params.executeDeadline): the Execution's deadline
  plan?: ExecutionPlan;
}
```

The lifecycle INDICATIVE → USER REVIEW → USER SIGN → HARD RFQ → FINAL EXECUTION (plan §11) is quote →
commit → prepare → sign → hand-over (V3 §7). A hard quote that guarantees less per unit than
`minimumOutput` MUST NOT be signed (plan §108: the bounds, not the provider, decide); the price guard
(`priceGuard`, 50 bps at ≥ high-value) refuses a re-quote far below the best live alternative; an expired
quote never executes (the signed deadline). `Code:` `services/private-swap/src/engine.ts` (`prepareExecution`),
`frontend/src/sdk/swapExecute.ts` (`prepareAndSign`), `sdk/providerCall.ts`.

### 3.4 RiskAssessment → `Protection` + `ProviderRisk` (plan §5–§7, §41–§46, §88; V3 §10)

```ts
export interface Protection {
  provider: ProviderId; riskClass: RiskClass; flags: RiskClass[]; custody: string;
  bandBps: [number, number]; capBps: number; sizing: Sizing; concurrency: "sequential" | "parallel"; maxParallel: number;
  gate: Gate; cadenceSeconds: [number, number]; providerShareCapBps: number; executeWindowSeconds: number;
  estimatedTranches: number; estimatedSeconds: number;
  trancheUsd: [number, number] | null; capUsd: number | null; trancheImpactBps: number | null; thinMarket: boolean; maxPieceUnits: string | null;
  concentration: { providers: { id: ProviderId; shareBps: number }[]; singleVenue: boolean; capBps: number };
  elpf: { prior: number; pFailure: number; perTrancheUsd: number | null; perCampaignUsd: number | null };   // plan §88
  staged: boolean; reasons: string[];
  // V4
  exposureTier: ExposureTier;                                            // §2.2
  impactRemedy: "none" | "reduce-tranche" | "rfq" | "streaming" | "other-venue";   // §2.3
  ledgerPreview: { totalOrderValue: string; maxExternalExposure: string; firstTranche: string };  // plan §26, before anything is funded
}
export interface ProviderRisk { model: RiskModel; security: SecurityBreakdown; incidents: Incident[]; reliability: number | null }
```

The wallet keeps the service's recommendation as `Campaign.riskSnapshot` (advice) and recomputes its own
bounds and accounting from the shared core. `Code:` `services/private-swap/src/risk/protection.ts`,
`riskClasses.ts` (`RiskModel`), `risk/security.ts` (`SecurityBreakdown`).

### 3.5 ExposureLedger → `ledger(c)` + `Exposure` (plan §25–§27, §65–§68) — *V4*

```ts
/** The plan's §26 ledger, derived from the tranche states alone (pure, never stored). */
export interface ExposureLedger {
  orderId: string;
  totalOrderValue: string; maxExternalExposure: string;
  completed: string;       // settled inputs plus the delivered share of partials — never counted as in flight (I-HV 10)
  inFlight: string;        // handed over and not yet past the gate (unsettled, plan §27); an unknown state stays here (I3)
  pending: string;         // funded or signed, not handed over: in our own escrow, not externally reachable (V3 "prepared")
  remaining: string;       // total − completed − inFlight − pending; a refund returns here
  byProvider: Record<string, { inFlight: string; limit: string }>;   // plan §25, §67: limit = total × providerShareCapBps
}
```

Invariants (V3 §5, extended): **I1** a tranche is handed over only if `inFlight + amount ≤ maxExternalExposure`;
**I2** every piece ≤ the cap; **I3** an unknown tracking state keeps a tranche in flight; **I4** at most
`maxParallel` tranches prepared or in flight; **I5** completed and in-flight are reported separately, never
netted; **I6** (*V4*, plan §67) `byProvider[p].inFlight + amount ≤ byProvider[p].limit` for the tranche's
provider; bridge, solver and provider exposure of one route are one boundary (plan §68). The §25 example
(THORChain $100K + Chainflip $80K + Mayan $70K under a $250K cap: admitted; $250K each: refused) is pinned.
`Code:` `reference/typescript/src/wallet/campaign.ts` (`exposure`, `ledger`, `canRelease(c, size, provider)`).

### 3.6 Tranche → `Tranche` (plan §22–§24, §70; V3 §7)

```ts
export type TrancheState = "planned" | "ready" | "committed" | "funded" | "signed" | "executing" | "source-confirmed"
  | "destination-submitted" | "destination-confirmed" /* V4 */ | "settled" | "partial" | "refunding" | "refunded" | "failed" | "skipped";
export interface Tranche {
  index: number; amount: string; state: TrancheState; attempt: number;
  orderId?: string; destination?: string; destinationIndex?: number; provider?: string; riskClass?: RiskClass; gate?: Gate;
  notBefore?: number;                                                  // the cadence draw (unix ms)
  expected?: { minOut: string; rateE18: string; etaSeconds: number };
  outcome?: { delivered?: string; deliveredOut?: string; refunded?: string; deviationBps?: number };
  quoteExpiresAt?: number; jobId?: string; handedOverAt?: number; deliveredSince?: number; settledAt?: number;
  lastReadFailedAt?: number;                                           // V4 (plan §110): the last failed settlement read → "Unknown / reconnecting"
  history: { state: TrancheState; at: number; note?: string }[];
}
```

and the campaign that owns it (the plan's `HighValueOrder` §9 is this record plus §3.1):

```ts
export interface Campaign {
  id: string; createdAt: number; state: CampaignState; mode: ProtectionMode; tier: Tier;
  request: { from: AssetRefLike; to: AssetRefLike; amount: string; preference: string };
  bounds: ExecutionBounds; plan: TranchePlan; tranches: Tranche[]; referenceRateE18: string;
  riskSnapshot?: unknown; provider?: string; policy?: string; gasPriceAtConfirmationWei?: string;
  pendingReroute?: { provider: string; protection?: unknown; at: number }; alerts?: CampaignAlert[]; lint?: unknown; value?: unknown;
  pause?: { reason: PauseReason; detail: string; at: number; trancheIndex?: number };
  confirmations: { commit: number; secondFactor?: number; secondDevice?: number; destinationVerified?: number; emergencyOverride?: number };
  history: { state: CampaignState; at: number; note?: string }[];
}
```

Sizing (plan §22–§24): pieces are one bucket, or the sum of two, inside the band; `bucket` sizing repeats the
largest common size, `varied` sizing never puts two equal pieces side by side; randomness alone is never the
privacy argument (the lint measures the pattern, §3.11). `Code:` `campaign.ts` (`planTranches`).

### 3.7 Execution → `Execution` + `SwapJob` (plan §34, §70; V1.1 §6, V2 §20)

```ts
/** What the relayer submits (SwapOrderTypes.Execution): authored only by the tranche's one-time order key. */
export interface Execution { provider: string; value: bigint; providerCalldata: `0x${string}`; deadline: number; signature: `0x${string}` }
/** The execution id is the relayer's job id; the job is the executor's durable record (plan §74). */
export type SwapJobState = "waiting-funding" | "expired" | "refund-only" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
export interface SwapJob { id: string; escrow: Address; state: SwapJobState; txHash?: Hex; executionTx?: Hex; error?: string; balance?: string; updatedAt: number }
```

`executionTx` is recorded once and never overwritten (V2 §19). The plan's adapter interface (§34) maps onto
the V2 §5 one: `quote` = `quote`, `prepare` = `prepareIngress`, `validate` = the local decode-and-check of the
provider call (the adapter's and, independently, the wallet's), `execute` = the relayer's `deployAndExecute`,
`track` = `track`, `recover` = the escrow's refund plus the provider's own refund path. `Code:`
`services/private-swap/src/types.ts`, `frontend/src/sdk/relayer.ts`, `services/relayer/src/swapExecutor.ts`.

### 3.8 Settlement → `Tracked` + `TrackStatus` (plan §69–§70; V2 §19)

```ts
export interface TrackStatus {
  state: "pending" | "executing" | "destination-submitted" | "destination-final" | "completed" | "partial" | "refunded" | "failed" | "unknown";
  destinationTxHash?: string; deliveredAmount?: bigint; deliveredAsset?: string; refundedAmount?: bigint; progress?: { parts: number; done: number }; raw?: unknown;
}
export interface Tracked {
  state: OrderState;            // the V1.1 machine's state as the wallet derives it (§4.3)
  label: SettlementLabel;       // "Preparing" | "Waiting for source" | "Executing" | "Waiting for destination" | "Partial" | "Refunding" | "Refunded" | "Completed" | "Not started" | "Needs attention"
  steps: [boolean, boolean, boolean, boolean];   // Quote locked · Source confirmed · Destination sent · Destination finalized
  detail: string;               // where the money is, what came back, what happens next — never a bare "failed"
  deliveredAmount?: string; refundedAmount?: string; destinationTxHash?: string; progress?: { parts: number; done: number };
}
```

Finality is the provider's delivered state plus the destination chain's elapsed-time margin (Bitcoin 60 min,
Solana 1 min, EVM 15 min, lab-calibrated); no third-party explorer is ever asked (it would leak the
destination). The gate per class: R5 bridge / MPC at destination final, R2 / R4 solver and intent at
destination submitted, R1 at source final, Maximum Safety destination final everywhere (V3 §6). `Code:`
`frontend/src/sdk/orderTracker.ts`, `campaign.ts` (`settledBy`, `FINALITY_MARGIN_SECONDS`).

### 3.9 Recovery → the pause reasons and the reconcile rules (plan §31–§33, §71–§72, §84–§87)

```ts
export type PauseReason = "price-deviation" | "provider-error" | "chain-congestion" | "route-degraded" | "unexpected-destination"
  | "security-incident" | "anomaly" | "reconcile" | "bounds" | "user" | "wallet-pause" | "velocity" /* V4 */;
export type CampaignState = "user-confirmed" | "preparing-notes" | "running" | "paused" | "reassessing" | "requoting" | "rerouting" | "winding-down" | "completed" | "cancelled";
```

The rules are in §8. Recovery never retries blindly (plan §33): a tranche with `fundedTx`, or whose escrow
already holds the amount, is never funded twice; a tranche with a `jobId` is never handed over twice; an
unknown outcome pauses with `reconcile`. `Code:` `campaign.ts` (`detectPause`), `campaignRunner.ts`.

### 3.10 ProviderHealth → `Health` + the breaker state + `SecurityBreakdown` (plan §44–§45; V2 §16, V3 §10)

```ts
export interface Health { provider: ProviderId; reachable: boolean; apiLatencyMs: number; halted: boolean; haltedChains: string[]; checkedAt: number; note?: string;
  failures?: { consecutive: number; lastAt?: number; windowCount: number } }
/** GET /risk/:provider */
export interface RiskView { provider: string; model: RiskModel; security: SecurityBreakdown;
  breaker: { open: string | null; failures: { consecutive: number; windowCount: number }; stalls: number; divergences: number; probe: boolean; lastIncidentAt: number | null };
  record: ProviderRiskRecord | null; routes: RouteRiskRecord[] }
export interface SecurityBreakdown { provider: string; baseline: number; incidents: number; audit: number; codeChange: number; bugBounty: number; tvl: number; upgradeability: number; total: number;
  fields: { custody?: string; bridgeModel?: string; validatorModel?: string; upgradeability?: string; audits: number; lastAudit: string | null; lastCodeChange: string | null; tvlUsd: number | null; volume30dUsd: number | null; bugBountyUsd: number | null; lastReviewed: string | null } }
```

Eligibility (plan §44): healthy, a fresh quote, liquidity for the size, destination and asset supported, the
security threshold (70 narrows the band, 60 refuses). The breaker (plan §45) opens on 3 consecutive failures,
6 in an hour, 2 settlement stalls, 3 quote divergences or an incident < 24 h, closes on a success, and allows one
probe after it expires. `Code:` `services/private-swap/src/health.ts`, `risk/security.ts`, `server.ts`.

### 3.11 PrivacyAssessment → `privacyAssessment.ts` (plan §7, §48–§54, §112, §114) — *V4*

```ts
/** The PrivacyEngine's six linkabilities, each 0 (unlinkable) … 1 (linked), with the measurable fact behind each. */
export interface PrivacyAssessment {
  components: { source: number; amount: number; timing: number; destination: number; provider: number; crossChain: number };
  score: number;                 // 0–100: 100 × Π (1 − weight_i × component_i), the service's weights (privacyScore.ts)
  level: "Excellent" | "Good" | "Reduced";
  basis: string[];               // one sentence per component naming the fact it was measured from
  pattern: { sameSizeConsecutive: boolean; cadenceFixed: boolean; destinationShared: boolean };   // plan §112: the fingerprint of a campaign
}
```

Source: the pool funds a one-time escrow (0) or a public address pays (1). Amount: a bucket size (0), a sum of
two (0.3), an exact amount (the uniqueness share, ≥ 0.8). Timing: the cadence window's lower bound (≥ 6 h → 0,
≥ 1 h → 0.3, ≥ 5 min → 0.7, else 1), × the campaign's fixed-cadence flag. Destination: a fresh address per
tranche (0), one entered address for every tranche (1), the public wallet's own (1, blocked). Provider: the
escrow → destination link public (1 − the cover-traffic effective set in bits / 4, from the cross-chain lab) or
kept private (0). Cross-chain: the lab's effective-set fit (`crossChainEffectiveSet`). The level is
`levelOf(score)` (`privacyCenter.ts`), the figure the Review and the Home badge show; "Safe to execute" is never
shown without it (V3 §15). The plan's §112 pattern test (equal pieces on a fixed cadence) MUST flag amount and
timing together. `Code:` `reference/typescript/src/wallet/privacyAssessment.ts`, `privacyLint.ts`.

### 3.12 DestinationRecord → `AddressBookEntry` (plan §16–§21; V3 §12)

```ts
export type AddressLifecycle = "generated" | "verified" | "approved" /* V4 */ | "used" | "settled" | "retired";
export type VerificationMethod = "derived" | "groups-read" | "signed-message" | "test-transaction";
export interface AddressBookEntry {
  id: string; chain: "evm" | "bitcoin" | "solana"; asset?: string; address: string; normalized: string; label: string;
  source: "fresh" | "entered"; addedAt: number; lifecycle: AddressLifecycle;
  verification: { status: "unverified" | "verified"; method?: VerificationMethod; at?: number };
  coolingUntil?: number; override?: { at: number; by: "second-factor" | "second-device" }; lastUsedAt?: number; usedBy: string[];
  approvedAt?: number;           // V4 (plan §19): the explicit approval for large payments; stale after APPROVAL_IDLE_MS (90 days) idle
}
```

The plan's UNKNOWN → VERIFIED → APPROVED → USED → RETIRED (§19) maps onto generated → verified → approved →
used → settled → retired; a destination does not return to APPROVED after a long idle period without a
re-check (`canUse` refuses `stale`). The verification methods are V3 §12's; the test transaction warns that it
creates observable activity (plan §21); the cooling-off is 24 h; the Immediate override takes the phrase, the
hold and the second factor (the separate device at institutional). `Code:`
`reference/typescript/src/wallet/addressBook.ts`, `frontend/src/wallet/addressBook.ts`.

---

## 4. State machines (plan §19, §44, §70)

### 4.1 The campaign (V3 §7, unchanged)

```
USER CONFIRMED ─▶ PREPARING NOTES ─▶ RUNNING ─▶ … ─▶ COMPLETED
                                       │  ▲
                                       ▼  │ resume
                                     PAUSED ─▶ REASSESSING ─▶ REQUOTING ─▶ REROUTING (a new Review)
                                       │
                                       └──▶ WINDING DOWN ─▶ CANCELLED
```

One action per tick from the pure reducer `nextAction(campaign, facts)`; the runner journals before and after
every network call and re-reads the journal at the next tick.

### 4.2 The tranche, with the plan's §70 names

```
planned ─▶ ready ─▶ committed ─▶ funded ─▶ signed ─▶ executing ─▶ source-confirmed ─▶ destination-submitted
        ─▶ destination-confirmed (V4) ─▶ settled | partial | refunding ─▶ refunded | failed | skipped
```

| Plan §70 | Tranche state | Fact |
|---|---|---|
| DRAFT | `planned` | the piece exists in the journal; nothing left the private balance |
| QUOTING | `ready` | the destination reserved, `/order` in flight |
| QUOTED | `committed` | the child order journaled with its hard-quote expiry |
| SIGNED | `funded` → `signed` | the private withdrawal mined into the escrow; the provider call checked, signed and simulated, kept in the wallet |
| SUBMITTED | `executing` | handed to the executor (the job id is the execution id): money is externally reachable from here |
| SOURCE_CONFIRMED | `source-confirmed` | `deployAndExecute` mined (job `executed`, `executionTx`) |
| EXECUTING | `source-confirmed` | the provider's stream / solver is running (`PROVIDER_EXECUTING`) |
| DESTINATION_PENDING | `destination-submitted` | the provider sent the destination transaction |
| DESTINATION_CONFIRMED | `destination-confirmed` | the destination delivered; the finality margin is running (`deliveredSince`) |
| FINALIZED | `settled` | the gate reached (the margin elapsed, or the class's earlier gate) |
| COMPLETED | `settled` + the campaign `completed` | every piece settled |
| PAUSED | (the campaign's state) | a tranche keeps its own state while the campaign is paused |
| REFUND_PENDING | `refunding` | a refund-only job, a provider refund or the window |
| REFUNDED | `refunded` | the refund note found in the pool |
| FAILED | `failed` | the executor or the provider failed; the detail says where the money sits |

A tranche in `executing`, `source-confirmed`, `destination-submitted`, `destination-confirmed` or `partial` is
**in flight** for the ledger; `funded`, `signed`, `failed` are **pending** (in our escrow). "Unknown /
reconnecting" (plan §110) is a tranche whose last read failed (`lastReadFailedAt`): it keeps its state and
stays in flight (I3). `Code:` `campaign.ts` (`IN_FLIGHT`, `PREPARED`), `campaignRunner.ts` (`trancheStateOf`).

### 4.3 The order (V1.1 §3, unchanged) — every legal transition

```
QUOTED            commit → COMMITTED · quote-expired → EXPIRED · cancel → CANCELLED
COMMITTED         submit-source → SOURCE_SUBMITTED · quote-expired → EXPIRED · cancel → CANCELLED
SOURCE_SUBMITTED  source-final → SOURCE_FINAL · source-failed → SOURCE_FAILED
SOURCE_FINAL      executed → PROVIDER_EXECUTING · refund-window → REFUND_PENDING · provider-timeout → PROVIDER_TIMEOUT
PROVIDER_EXECUTING destination-submitted → DESTINATION_SUBMITTED · provider-timeout → PROVIDER_TIMEOUT · partial → PARTIAL · refund-window → REFUND_PENDING
DESTINATION_SUBMITTED destination-final → DESTINATION_FINAL · destination-failed → DESTINATION_FAILED · partial → PARTIAL
DESTINATION_FINAL completed → COMPLETED · partial → PARTIAL
SOURCE_FAILED     give-up → FAILED · submit-source → SOURCE_SUBMITTED
PROVIDER_TIMEOUT  refund-window → REFUND_PENDING · destination-submitted → DESTINATION_SUBMITTED · give-up → FAILED
PARTIAL           refund-window → REFUND_PENDING · give-up → FAILED
DESTINATION_FAILED refund-window → REFUND_PENDING · give-up → FAILED
REFUND_PENDING    refunded → REFUNDED · give-up → FAILED
FAILED            refund-window → REFUND_PENDING
terminal: COMPLETED, EXPIRED, CANCELLED, REFUNDED
```

`Code:` `services/private-swap/src/order.ts` (`nextState`: anything else throws).

### 4.4 The relayer's job (V2 §20, unchanged)

`waiting-funding → executing → executed → completed`; `waiting-funding → expired`; `refund-only → refunding →
refunded`; `executing → execute-failed`; `refunding → refund-failed`; the late-refund watch after `executed`.
`Code:` `services/relayer/src/swapExecutor.ts`.

### 4.5 The destination (plan §19) — *V4*

`generated → verified → approved → used → settled → retired`, with: an entered address added `generated`
(unverified, cooling-off 24 h); `verified` by one of the four methods; `approved` by the user's explicit
approval for large payments once the cooling-off passed (or the Immediate override); `used` at the first
hand-over; `settled` when the payment settled (a fresh address retires here: one use); `retired` by the user or
after one use; an approval idle for more than `APPROVAL_IDLE_MS` (90 days) is **stale** and the entry needs a
re-verification before a payment at ≥ high-value. A retired entry is never selected automatically. `Code:`
`addressBook.ts` (`approveEntry`, `canUse`).

---

## 5. The invariant lists (plan §113–§115), each with the test that executes it

The tests live under `tests/high-value/` (*V4*, plan §116: one directory per area; `tests/high-value/README.md`
maps the directories) beside the package suites named below.

### 5.1 High-value invariants (plan §113)

| # | Invariant | Enforced in | Test |
|---|---|---|---|
| 1 | `inFlight ≤ maxExternalExposure` | `canRelease` (I1) | `tests/high-value/exposure/ledger.test.ts`, `exposure/property.test.ts` (random campaigns, 1,000 cases) |
| 2 | `providerExposure[i] ≤ providerLimit[i]` | `canRelease` (I6, *V4*) | `exposure/ledger.test.ts`, `exposure/property.test.ts` |
| 3 | `minimumOutput` is never relaxed | `checkWithinBounds`, the `price-deviation` pause | `order/envelope.test.ts` |
| 4 | `maximumFee` is never exceeded | `checkWithinBounds` (`maxFeeBps`) | `order/envelope.test.ts` |
| 5 | the destination never changes after signing | the escrow's call (receiver check), `checkWithinBounds`, `unexpected-destination` | `order/envelope.test.ts`, `frontend/test/swap-guard.test.ts` |
| 6 | the chain never changes after signing | `ExecutionBounds.chainOut`; the child order's request is the bounds' | `order/envelope.test.ts` |
| 7 | the asset never changes after signing | `ExecutionBounds.assetOut`; the escrow's asset | `order/envelope.test.ts` |
| 8 | an expired quote never executes | the signed deadline, `quoteExpiresAt > expiry` refused | `quote/lifecycle.test.ts`, `contracts` (forge: executeDeadline) |
| 9 | an unknown transaction state never auto-retries | I3, the `reconcile` pause, `fundedTx` / `jobId` checks | `recovery/rules.test.ts`, `frontend/test/campaign-runner.test.tsx` |
| 10 | completed value is never counted as in-flight | `exposure` (I5) | `exposure/ledger.test.ts` |
| 11 | failed value is not assumed settled | `exposure` (`failed` is pending, never completed) | `exposure/ledger.test.ts` |
| 12 | a provider incident pauses the affected routes | `detectPause` (`security-incident`), the breaker | `provider-failure/scenarios.test.ts` |

### 5.2 Privacy invariants (plan §114)

| # | Invariant | Enforced in | Test |
|---|---|---|---|
| 1 | a permanent wallet identity is not required for private execution | the one-time escrow funded by a private withdrawal; placeholders at phase 1 | `privacy/assessment.test.ts`, `services/private-swap/test/privacy-flow.test.ts` (live) |
| 2 | fresh high-value execution addresses are preferred | `DestinationPolicy` `fresh-per-tranche` default; one-time order keys | `privacy/assessment.test.ts`, `reference/typescript/test/chainkeys.test.ts` |
| 3 | destination reuse is discouraged | the lint `destination-fresh` / `tranche-link`; fresh addresses retire after one use | `privacy/assessment.test.ts`, `reference/typescript/test/addressBook.test.ts` |
| 4 | identical tranche patterns are discouraged | `varied` sizing, the lint `same-size-consecutive` | `tranche/sizing.test.ts` |
| 5 | the timing fingerprint is measured | `PrivacyAssessment.components.timing`, the lint `exact-cadence` | `privacy/assessment.test.ts` |
| 6 | the amount fingerprint is measured | `PrivacyAssessment.components.amount`, the lint `amount-fingerprint` | `privacy/assessment.test.ts` |
| 7 | provider correlation is measured | `PrivacyAssessment.components.provider`, `crossChain` | `privacy/assessment.test.ts` |
| 8 | the user receives a privacy assessment before signing | the Review's paired verdict (never "Safe to execute" without the level) | `frontend/test/campaign-screens.test.tsx` |

### 5.3 Security invariants (plan §115)

| # | Invariant | Enforced in | Test |
|---|---|---|---|
| 1 | no company custody | funds sit only in the pool or a one-time escrow the user's key controls | `contracts` (forge e2e), `frontend/test/swap-guard.test.ts` (the escrow recomputed) |
| 2 | no unlimited token approval | exact approvals; the escrow's approve bounded by D1 (V3 §13); allowances read and revoked | `frontend/test/allowances.test.tsx`, `contracts` |
| 3 | no AI signing | the AI gets a sanitized summary and no keys | `frontend/test/trade-check.test.ts`, `campaign-screens.test.tsx` |
| 4 | no admin route override | the service has no order-changing endpoint; the relayer's admin token lists only | `services/relayer/test/admin.test.ts`, `services/private-swap/test/adversarial.test.ts` (live) |
| 5 | no hidden destination change | the wallet reads the receiver from the calldata before signing | `frontend/test/swap-sign.test.ts`, `order/envelope.test.ts` |
| 6 | no blind retry | §5.1 #9 | `recovery/rules.test.ts` |
| 7 | no single mandatory provider | the competition, the breaker, the reroute Review | `provider-failure/scenarios.test.ts`, `routing/eligibility.test.ts` |
| 8 | no single mandatory RPC | the RPC quorum on every read, the light client on the pool | `frontend/test/verified-reads.test.ts`, `lightclient.test.ts` |

---

## 6. The risk formula (plan §7) — the measurable basis of every component

The plan's `RouteRisk` and `PrivacyRisk` are reported **beside each other** (the paired verdict, V3 §15), never
collapsed into one number without their parts. Each component names the measurement behind it:

| Component | Basis | Code |
|---|---|---|
| protocolRisk | `SecurityBreakdown`: the custody baseline, decaying incidents, audit recency, code change, bug bounty, TVL, upgradeability (unknown adjusts nothing) | `risk/security.ts` |
| providerRisk | `reliabilityScore` (reachable, halted, latency, the failure window), the breaker state, the ELPF prior | `health.ts`, `riskClasses.ts` |
| liquidityRisk | the provider's own impact figure against `IMPACT_LIMIT_BPS`, its instant limit, the thin-market remedy | `risk/protection.ts` |
| settlementRisk | the class's gate, the finality margin, the stall history (`/track?since&expected`) | `campaign.ts`, `health.ts` |
| marketRisk | the Chainlink cross-rate against the confirmation rate (`MAX_DEVIATION_BPS` 100) | `campaign.ts` (`detectPause`) |
| operationalRisk | the relayer's gas price against the confirmation's (`CONGESTION_FACTOR` 3), the RPC quorum's agreement, a halted chain | `campaignRunner.ts`, `orderTracker.ts` |
| PrivacyRisk | the six linkabilities of §3.11 | `privacyAssessment.ts` |

ELPF (plan §88): `expected loss = P(failure) × exposed`, with the class prior × (1 + failures in the window / 3)
× 1.5 within 90 days of an incident; reported per tranche and per campaign, and used by the benchmark (§9) to
compare one trade against the cap fractions — the plan's Route A / Route B example is exactly this comparison.

---

## 7. Route scoring, quote normalization and PAES (plan §41–§47, §82, §87) — *V4*

- **Normalization** (§3.2): every competition line carries `NormalizedQuote`; a provider that states no fee
  or gas figure gets `null`, never a guess.
- **Presets** (plan §43, configuration values, not protocol constants). `scoring.ts` `WEIGHTS` gains:

  | Policy | net output (price) | security | liquidity | reliability | privacy | speed (latency) |
  |---|---|---|---|---|---|---|
  | `best-execution` (the plan's initial score; the Best Execution mode) | 0.35 | 0.20 | 0.15 | 0.10 | 0.10 | 0.10 |
  | `high-privacy` (the plan's High Privacy; the Maximum Privacy mode from high-value) | 0.25 | 0.20 | 0.10 | 0.10 | 0.25 | 0.10 |

  The V2 policies (`balanced`, `best-price`, `best-privacy`, `fastest`, `privacy-execution`) are unchanged;
  `policyFor(preference, tier, mode)` picks the preset from the protection mode at ≥ high-value.
- **PAES** (plan §87), reported per route under Advanced and in the benchmark, never the chooser by itself:
  `PAES = price − 0.25 × (100 − privacy) − 0.25 × (100 − security)` on the 0–100 components.
- **Eligibility** (plan §44), the breaker (§45), concentration (§46: when two or more venues quote the size at
  ≥ $5M no provider SHOULD carry more than `PROVIDER_SHARE_CAP_BPS` = 3000 of the order; a single venue is
  disclosed, never diversified for appearance, §47) and the strategy hierarchy (plan §82: RFQ → deep native
  liquidity → streaming → multi-provider → AMM only when justified) are the filters and the order the
  competition applies at every step's size.

`Code:` `services/private-swap/src/{scoring,normalize}.ts`, `risk/protection.ts`.

---

## 8. Recovery rules (plan §31–§33, §71–§72, §84–§87, §109–§111)

| Situation | Rule | Code |
|---|---|---|
| source not confirmed | wait; the funding transaction is journaled (`fundedTx`), never sent twice | the runner's `fund` (escrow balance read first) |
| source confirmed, destination pending | track the provider (`/track`), stay in flight | `reconcileAndTrack` |
| the provider reports complete, destination missing | the finality margin and the delivered amount decide; a delivered amount below the guaranteed minimum is an `anomaly` pause | `trancheStateOf`, `detectPause` |
| unknown state | STOP — the tranche stays in flight (I3), the campaign pauses `reconcile`; no retry until the chain and the executor are read again | `detectPause`, the runner |
| timeout | settlement older than 3 × the plan's time → `anomaly` pause; the service counts a stall; never a second send | `STALL_FACTOR`, `recordSettlementStall` |
| provider incident | `security-incident` pause for the affected provider's campaigns; the breaker skips it in the next competition | `detectPause`, `health.ts` |
| price divergence | the hard quote below the bound → `price-deviation`; the cross-rate moved > 1 % → pause and requote | `detectPause` |
| destination change | the provider call pays another receiver → `unexpected-destination`; nothing signed | `providerCall.ts`, `detectPause` |
| chain congestion | the relayer's gas price > 3 × the confirmation's → `chain-congestion` | `detectPause` |
| reorg (plan §111) — *V4* | a funding seen in the escrow and then gone (the quorum's balance below the amount after `fundedTx`) invalidates the local assumption: the tranche returns to `committed`-with-`fundedTx`, the campaign pauses `reconcile` naming a possible reorganization, the chain is re-read before anything is sent; `fundedTx` set → never funded again | the runner's reconcile |
| app crash (plan §109) | at unlock the runner reconciles every open tranche from the journal, the escrow balance and the executor's job; never sends again | `reconcileAndTrack` |
| network outage (plan §110) — *V4* | a failed read keeps the state and marks `lastReadFailedAt`; the screens say "Unknown / reconnecting", never "failed" | the runner, `CampaignProgress` |
| pause → resume | reassess on fresh facts → requote at the next step's size → the same route continues, or a reroute Review (automatic below the second-confirmation tier when allowed) | `nextAction`, the runner's `requote` |
| cancel | unfunded steps skipped, funded ones to refund-only jobs, in-flight ones finish; the campaign winds down | `cancelCampaign`, `wind-down` |

---

## 9. Development order (plan §132) and the benchmark (plan §116–§123)

| Phase | Deliverable | Status |
|---|---|---|
| 1 | requirements | V3 spec + this contract |
| 2 | Order / ExecutionEnvelope types | §3.1, §3.6 (V3 Stage 1) |
| 3 | exposure ledger | §3.5 (V3 Stage 1; I6 and `ledger` *V4* Stage 1) |
| 4 | risk engine | §3.4, §3.10, §6 (V3 Stage 3; exposure tiers *V4* Stage 1–2) |
| 5 | tranche engine | §3.6 (V3 Stage 1) |
| 6 | quote abstraction | §3.2 (V2 Stage 3; normalization *V4* Stage 2) |
| 7 | RFQ adapter | deferred (§10): the interface of V2 §11 |
| 8 | streaming adapter | THORChain streaming / Chainflip DCA (V2 Stage 3) |
| 9–13 | THORChain, Chainflip, Mayan, NEAR, LI.FI | V1.1 / V2 (`adapters/*`) |
| 14 | UniswapX / Across | Across: V1.1 (`adapters/across.ts`, `acrossSwap.ts`); UniswapX: deferred |
| 15 | provider health / breaker | §3.10 (V2 Stage 3, V3 Stage 3) |
| 16 | privacy engine | §3.11 (*V4* Stage 1) |
| 17 | privacy lint | V2 Stage 5, V3 Stage 1 |
| 18 | destination guard | §3.12 (V3 Stage 6; approval and staleness *V4* Stage 1, 4) |
| 19 | settlement / recovery | §3.8, §8 (V3 Stage 4; the confirmed state, the reorg and outage rules *V4* Stage 3) |
| 20 | mobile UX | the web screens (V3 Stage 5; the *V4* Stage 4 items of plan §55, §69, §94, §98, §100, §127–§128); native shells deferred |
| 21–23 | $1M / $5M / $10M simulation | `frontend/test/campaign-flow.test.tsx`, the campaign lab, the local-stack run (V3); the §119 matrix *V4* Stage 5 |
| 24 | chaos testing | the lab's 13 faults (V3); random fault sequences *V4* Stage 5 |
| 25 | privacy benchmark | `docs/privacy-lab.md` (V2, V3); the §120 rows *V4* Stage 5 |
| 26 | security audit | out of scope (`docs/audit-package.md`) |

**The benchmark** (plan §121–§123). `benchmarks/whale/run-policy.mjs` runs the campaign lab over the sizes
$1M / $5M / $10M / $25M / $50M, the cap variants *one trade* / 5 % / 2.5 % / 1 % and the §119 conditions, and writes
`docs/HighValuePolicyBenchmark.md` with the plan's §122 columns (order size, risk tier, exposure %, number of
external executions, completion time, expected loss, worst-case loss, privacy score, cost at the live gas
price). The production default (`PROTECTION_DEFAULTS.balanced.capBps`) is set from that table and the figure
is recorded in this section when the benchmark runs (*V4* Stage 5).

---

## 10. Out of scope here (plan §40, §59–§61, §132 phase 26)

- **UniswapX RFQ** (R1 controlled RFQ): the escrow would have to sign EIP-712 orders (EIP-1271 = new bytecode);
  the interface of V2 §11 and the R1 tier's bands stay specified; `rfq/` tests pin the tier and the hard-quote
  rules against the interface. **OTC** (R6): interface only.
- **Multi-device threshold approval**: the separate-device second factor is the in-scope control.
- **Push notifications, background execution, React Native**: the web wallet runs campaigns while unlocked and
  resumes at unlock; the notification text is generic by default (plan §60).
- Third-party explorer queries for finality; execution with real funds; the security audit.
