# Whale Execution & PrivateSwap Protocol Specification V1.0

Normative. How a private swap or transfer behaves as its value rises from $100 to $10M+: what the
engine must compare, what the wallet must show and check, how a large order is executed through
competing providers (streamed where that is better), what a stream's minimum really guarantees, and
what the user sees while a non-atomic settlement is in flight (plan V2 §1–§137). It extends
`docs/private-swap-spec-v1.1.md`, which stays normative where this document does not restate it.
**`PrivacyCore`, the vaults, the circuits and the `SwapOrderEscrow` / `SwapOrderFactory` bytecode are
unchanged by this document**: every rule here is engine (replaceable), relayer (replaceable), wallet
(replaceable) or research. UniswapX is specified as an interface only (§11) and deferred.

Status words MUST / MUST NOT / SHOULD are RFC-2119. Code: `services/private-swap/`,
`services/relayer/`, `frontend/src/`, `reference/typescript/src/wallet/`, `benchmarks/whale/`.

Status (2026-10-07): a section marked *Implemented* describes `main` at `9bb3e0f`; a section marked
*Stage N* is built by the V2 pass in that stage, in order (the roadmap tracks completion). Constants
marked *lab-calibrated* take their final value from Stage 1 (`benchmarks/whale/`).

---

## 1. Order object (plan V2 §8, §112, §137.1)

The V1.1 `Order` (`services/private-swap/src/types.ts`) gains the value, the tier, the plan and the
destination's provenance. Everything that was there stays.

```
Order {
  orderId        bytes32     uniformly random; also the CREATE2 salt (V1.1 §2)
  request        QuoteRequest (§5): from, to, amount (gross), destination, source?, slippageBps, plan?, tier?, preferNative?
  policy         Policy       derived from (preference, tier), §4 — never chosen by a provider
  preference     Preference   the user's saved preference the policy was derived from (§4)
  quote          Quote (§2)   the chosen quote; re-quoted at prepare (§3)
  plan           ExecutionPlan (§12)   copied from quote.plan at commit; the wallet signs only a call that encodes this plan
  approvedMin    uint256      destination base units: the minimum the user approved at commit; a call guaranteeing less is signed only after consent to the exact new value (§14)
  value          Valuation    { usd, at, source: "chainlink", feeds: [{ pair, round, updatedAt }] } or { unavailable: true, reason } (§13)
  tier           Tier         "standard" | "enhanced" | "high-value" | "high-value-secondary" | "institutional" (§13)
  destination    { chain, asset, address, kind: "fresh" | "entered" }   (§21)
  ingress        Ingress      the escrow's one call (V1.1 §4, §6)
  params         OrderParams  the on-chain escrow parameters (V1.1 §6) — unchanged
  endpoint       address      the predicted escrow
  execution?     Execution    signed once the final ingress is known
  privacy        { delaySeconds: [min, max], amountNormalized, score, destinationLinkPublic }   (V1.1 §8, §10)
  state          OrderState (§19);  history [{ state, at, note? }]
}
```
- `orderId` MUST NOT be derived from user identity. The wallet journals the order before any
  on-chain action (§25) and re-derives everything it needs from the journal and the chain.
- `value` and `tier` are computed by the wallet (§13) and recomputed by the service; when they
  disagree the higher tier applies to both. A missing valuation is not "standard": §13 says which
  tier applies.
- `approvedMin` is the bound of §3 phase 2. It is journaled by the wallet (`StoredSwap.approvedMin`)
  and carried in the order server-side so that `/prepare` can refuse a worse hard quote itself.
- `plan` is the engine's choice (§12). The wallet never asks the user how many sub-swaps to run.

*Implemented:* `Order` without `value` / `tier` / `preference` / `plan` / `approvedMin` /
`destination.kind` (`types.ts:149`); `approvedMin` on the wallet side only
(`frontend/src/wallet/journal.ts`). *Stage 2* adds `value` / `tier` / `preference`; *Stage 3* adds
`plan` and the server-side `approvedMin`; *Stage 5* adds `destination.kind`.

## 2. Quote object (plan V2 §6, §32, §137.2)

```
Quote {
  provider, category, toAmount, toAmountMin, fees[], etaSeconds, expiresAt, nativeAssets,
  minOutEncoded, minOutVerified?, refundTarget?, hops[], raw, obtainedAt           (V1.1 §4, unchanged)
  plan           ExecutionPlan   { mode: "single" | "streaming" | "dca" | "auction" | "intent", parts, intervalBlocks, expectedSeconds }
  impactBps?     number          the provider's own statement of the price impact / slippage of THIS size (§4: liquidity)
  limits?        { min?, max?, maxInstant? }   provider-stated size limits in `from` units, when it states any
  sizeSignals?   string[]        the provider's size warnings in words ("low liquidity", "recommended slippage 2.5 %", "above instant limit")
}
QuoteSet {
  quotes[], errors{}, health{}, scores[], chosen?, links{}                           (V1.1, unchanged)
  competition    CompetitionEntry[]   one per capable provider: { provider, outcome: "quoted" | "refused" | "timeout" | "halted" | "filtered" | "skipped", reason?, ms, plan? }
}
```
- A provider that refuses a size (Chainflip: HTTP 400 "insufficient liquidity for the requested
  amount"; Across: `isAmountTooLow`, `limits.maxDeposit`) is a `refused` entry with the reason. It is
  not a health incident (§16); it is this order's size.
- Per-provider `plan.mode`: THORChain `single` or `streaming`; Chainflip `single` or `dca`; Mayan
  SWIFT `auction` (solver auction with a fixed minimum), Mayan Fast-MCTP `single`; NEAR Intents
  `intent`; LI.FI and Across `single`.
- `impactBps` is taken from the provider's quote where it states one (THORChain
  `fees.slippage_bps`; Mayan `priceImpact`; Chainflip `recommendedSlippageTolerancePercent × 100`
  when `lowLiquidityWarning`, else 0; Across 0 for an exact fill; LI.FI from `estimate` when
  present) and left absent otherwise. The engine MUST NOT invent an impact it cannot source.
- The competition record is kept with the order (§25) and shown under "Route details" (§23) and
  on the desktop route table.

*Implemented:* `Quote` and `QuoteSet` without `plan` / `impactBps` / `limits` / `sizeSignals` /
`competition` (`types.ts:35`, `engine.ts:38`); the size fields are already fetched by the adapters
and ignored. *Stage 3.*

## 3. RFQ lifecycle (plan V2 §7–§8, §137.3)

Four phases, after UniswapX V2's separation of an indicative quote from a post-commitment hard
quote, applied to the one-time escrow flow of V1.1. Phase 2 is the only one that binds the user.

| Phase | Call | What happens | Binding? |
|---|---|---|---|
| 1 Indicative | `POST /quote` | every capable adapter quoted in parallel (a per-adapter time budget, §16); placeholder destination (§5); the competition record, scores, the chosen route; TTLs are minutes (LI.FI 60 s, THORChain its `expiry`, Mayan ≤ 600 s, Chainflip 600 s, NEAR deadline − 120 s, Across ≤ 50 min) | no |
| 2 Commit | `POST /order` + the journal | the wallet fixes **asset in, chain in, amount, asset out, chain out, destination, `approvedMin`, `executeDeadline` (expiry), the tip (max fee)** and the refund note; checks the service's params against its own factory (`swapGuard.ts`); journals the order; schedules the funding (V1.1 §8) | yes: the escrow parameters and `approvedMin` |
| 3 Hard quote | `POST /prepare` | the chosen adapter re-quotes with the escrow as sender and the committed plan; the price guard (§14) against live alternatives; the ingress is built and verified locally; the wallet decodes the provider call itself (`providerCall.ts`) and compares the guaranteed minimum with `approvedMin` | the user consents again only if the minimum moved |
| 4 Execute | `POST /finalize`, relayer `POST /swap/execute` | the one-time order key signs `(provider, value, keccak(calldata), deadline)`; the relayer calls `deployAndExecute`; the escrow makes exactly one call | yes: the signature |

- A provider MUST NOT be able to change, after phase 2: the destination, `approvedMin`, the
  expiry, the tip, the asset or the amount. The first four are in `OrderParams` or the journaled
  order and are checked against the provider call before it is signed; the last two are the escrow's.
- What the user signs in phase 4 commits to no provider-private assumption: the signature covers
  the provider address, the value, the calldata hash and the deadline (V1.1 §6), nothing else. A
  changed calldata is a different signature.
- A quote older than `expiresAt − 30 s` at phase 2 MUST be re-quoted (V1.1 §5). Phase 3 always
  re-quotes; it is never skipped because phase 1 was recent.
- For tier ≥ `enhanced`, phase 3 MUST run a fresh competition for the price guard (§14) rather
  than reuse the phase 1 set.

*Implemented:* the four calls and the wallet checks (`server.ts`, `engine.ts:prepareExecution`,
`frontend/src/sdk/{swapGuard,swapSign,providerCall}.ts`); the guard in phase 3 is not wired
(*Stage 3*), placeholder destinations in phase 1 are not used (*Stage 3*).

## 4. Route selection (plan V2 §3, §6, §31–§32, §64–§66, §108–§110, §137.4)

Six components in [0, 100] — `price`, `security`, `privacy`, `latency`, `liquidity`,
`reliability` — and a policy-weighted sum (V1.1 §9). Five policies:

```
policy              privacy  security  reliability  price  latency  liquidity
best-privacy          .45      .25        .15        .10     .05       0
best-price            .10      .20        .15        .45     .05      .05
fastest               .10      .15        .25        .10     .40       0
balanced   (default)  .25      .20        .15        .25     .10      .05
privacy-execution     .30      .25        .20        .15      0       .10
```
- `liquidity` = `100 − impactBps / 10` (floor 0) when the quote carries `impactBps` (§2), else the
  V1.1 liquidity-fee formula, else 80. `price`, `latency`, `security`, `reliability` as in V1.1 §9
  with §16's health.
- **Preference → policy.** The user's saved preference (`settings.preference`, §25) is `balanced`
  (default), `best-privacy`, `best-price`, `fastest` or `native`. `native` is `balanced` with
  `preferNative`: wrapped / bridged routes are filtered whenever at least one native route quoted.
  **Tier override:** at tier ≥ `high-value` a preference of `balanced`, `best-price` or `fastest`
  becomes `privacy-execution` (plan §110); `best-privacy` stays. The override is shown, not hidden.
- **Filters before scoring** (V1.1 §9 plus): a quote above the provider's stated `limits`; under a
  strict policy, `minOutVerified: false`; at tier ≥ `high-value`, a plan whose `impactBps` exceeds
  `IMPACT_CAP_BPS` = 50 (calibrated 2026-10-07: THORChain's native pairs stream at 19–20 bps at every
  size, while its shallow BASE.USDC pool reports 100 / 191 / 473 bps at $5M / $10M / $25M where Mayan
  quotes the same size at 20–45 bps) whenever another route quoted the size; an open circuit
  breaker (§16). A route above the cap that is the only one is kept and shown with its impact.
- **The best price MUST NOT win automatically** (V1.1 §9). At tier ≥ `high-value` the chosen route
  MUST have competed: at least two live quotes in the set, or the wallet shows "only one provider
  answered" and the user acknowledges it before commit (§24).
- The §64 penalties are not a second scoring: a recent incident lowers `security` (§16), low
  liquidity lowers `liquidity` through `impactBps`, an unstable chain lowers `reliability` through
  `haltedChains`, poor execution history lowers `reliability` through the failure history.

*Implemented:* three policies and the six components (`scoring.ts`). *Stage 3* adds the two policies,
`preferNative`, the impact term, the limit filter and the tier override.

## 5. Provider adapter interface (plan V2 §20, §106–§107, §137.5)

The V1.1 interface, with every type it referred to defined here exactly:

```ts
interface ProviderAdapter {
  readonly id: "thorchain" | "chainflip" | "mayan" | "near-intents" | "lifi" | "uniswap-across";   // "uniswapx" reserved (§11)
  readonly implemented: boolean;
  capabilities(): Capabilities;
  quote(req: QuoteRequest): Promise<Quote>;                       // live; indicative when req.source is unset
  prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress>;   // builds AND verifies the escrow's one call
  track(ref: { sourceTxHash?: string; providerRef?: string }): Promise<TrackStatus>;
  health(): Promise<Health>;
}
QuoteRequest  { from: AssetRef; to: AssetRef; amount: bigint /* net of the tip */; destination: string; source?: string /* the escrow, once known */;
                slippageBps: number; plan?: "single" | "stream"; tier?: Tier; preferNative?: boolean }
AssetRef      { chain: Chain; asset: "native" | <token address> | <symbol>; decimals: number; symbol: string }
Capabilities  { routes: RouteCategory[]; ingress: ("plain-address" | "contract-call")[]; nativeAssets: boolean; atomic: false; chains: Chain[];
                contractSender?: boolean; destinationLinkPublic: boolean; linkEvidence: string }
Ingress       { kind; to; calldata; value; memo?; expiresAt; minOutEncoded; verified?: string[]; refundTokens?: string[] }
TrackStatus   { state: "pending" | "executing" | "destination-submitted" | "destination-final" | "completed" | "partial" | "refunded" | "failed" | "unknown";
                destinationTxHash?; deliveredAmount?; deliveredAsset?; refundedAmount?; progress?: { parts: number; done: number }; raw? }
Health        { provider; reachable; apiLatencyMs; halted; haltedChains: string[]; checkedAt; note?;
                failures?: { consecutive: number; lastAt?: number; windowCount: number } }       // §16
```
- The conceptual interface of plan §106 maps onto these methods: `quote()` = `quote`;
  `prepare()` = `prepareIngress`; **`validate()`** = the local decode-and-check that every
  `prepareIngress` performs on provider-supplied calldata (§6–§10), repeated independently by the
  wallet (`frontend/src/sdk/providerCall.ts`); `execute()` = the relayer's `deployAndExecute`
  (§20); `track()` = `track`; **`recover()`** = the escrow's `refund` / `refundToken` plus the
  provider's own refund path (`Quote.refundTarget`, V1.1 §7).
- **Placeholder destination at phase 1.** When `req.source` is unset, the engine MUST pass each
  adapter a fixed, format-valid placeholder destination for the destination chain (EVM
  `0x1111…1111`; Bitcoin the bech32 reference address `bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq`;
  Solana the system program id `11111111111111111111111111111111`) — never the user's fresh address,
  which goes only to the chosen provider at phase 3. THORChain's quote takes no destination at all.
  A provider whose indicative quote depends on the destination (gas drop, destination calldata)
  is re-quoted at phase 3 anyway.
- No provider-specific logic reaches the UI (plan §106): the wallet names providers only under
  "Route details" (§23) and reads calls through its own decoders.

*Implemented:* the interface and all six adapters (`types.ts:114`, `adapters/*`). *Stage 3* adds
`plan` / `tier` / `preferNative`, `refundedAmount` / `progress`, `failures`, and the placeholders.

## 6. THORChain adapter (plan V2 §21–§23, §137.6)

| | |
|---|---|
| Quote | `GET /thorchain/quote/swap?from_asset&to_asset&amount(1e8)&tolerance_bps` (+ `destination` only at phase 3; + `streaming_interval` and `streaming_quantity` for a streamed plan, §12), from the first answering gateway of `THORNODE_URLS` (three independent operators). |
| Verified locally | the inbound vault and router MUST agree across ≥ `THORNODE_QUORUM` (2) gateways (`inboundQuorum`); the Ethereum router is pinned (`THORCHAIN_ROUTER_ETHEREUM`); the memo is built locally, never taken from the API; the limit is `expected × (1 − slippage)` and, from this document, MUST also be ≥ `approvedMin` (§14). |
| Ingress | EVM source: `router.depositWithExpiry(vault, asset, amount, memo, expiry)`; UTXO source (guest mode): a plain deposit to the vault with the memo (≤ 80 bytes, short asset form as fallback, no refund field). |
| Memo | `=:ASSET:DEST/ESCROW:LIMIT` single; `=:ASSET:DEST/ESCROW:LIMIT/INTERVAL/QUANTITY` streaming (§12). The refund field is the escrow: without it THORChain refunds the transaction's originator, the relayer (PP-S02). |
| Refund target | escrow (router `send`, 2300 gas: the escrow's empty `receive()`). |
| Size | `recommended_min_amount_in` → `limits.min`; `fees.slippage_bps` → `impactBps`; `max_streaming_quantity`, `streaming_swap_seconds` → the plan (§12); `warning` → `sizeSignals`. |
| Halts | per-chain `halted` / `global_trading_paused` / `chain_trading_paused` from `inbound_addresses` → `haltedChains`; a 4xx with a reason is a refusal, not an outage. |
| Track | `GET /thorchain/tx/status/{inbound tx}`: `stages` for progress; `out_txs` classified by memo prefix — `OUT:` delivered, `REFUND:` returned — summed per class (§12, §19). |
| Plan | `single` and `streaming`. **Measured (Stage 1):** with `tolerance_bps` in the request THORNode simulates a single swap and refuses it from $100K up ("emit asset … less than price limit": a single 39 ETH → BTC swap would emit ≈ 4.7 % below the limit), while the streaming quote (interval 1, quantity 0) answers at ≈ 20 bps slippage at every size up to $25M. The adapter therefore MUST ask the streaming quote at every size, MUST NOT send `tolerance_bps` (the limit is computed locally, §14), and MAY ask the single quote as well for the comparison of §12. Midgard shows every THORChain swap ≥ $100K of 2026-10-05…07 streamed (`benchmarks/whale/whale-research.md`). |
| Link | public: the memo names the destination and the refund escrow; the outbound carries `OUT:<inbound tx>`. |

*Implemented:* everything but the streaming parameters, the `approvedMin` floor and the outbound
classification (`adapters/thorchain.ts`). *Stage 3.*

## 7. Chainflip adapter (plan V2 §24, §137.7)

| | |
|---|---|
| Quote | `GET /v2/quote?srcChain&srcAsset&destChain&destAsset&amount&isVaultSwap&dcaEnabled=true`; no destination in the request. The answer lists a `REGULAR` and, when offered, a `DCA` quote; both are kept and the plan (§12) picks one. |
| Minimum | `minPriceX128 = price × (1 − slippage) × 2^128 × 10^(dest − src)` computed locally from `estimatedPrice`; `toAmountMin = amount × minPriceX128 / 2^128`; MUST be ≥ `approvedMin` at phase 3. |
| Ingress | `POST /api/encodeVaultSwapData { srcAsset, destAsset, srcAddress = escrow, destAddress, amount, fillOrKillParams { retryDurationBlocks, refundAddress = escrow, minPriceX128 }, dcaParams? { numberOfChunks, chunkIntervalBlocks } }` → `Vault.xSwapNative` / `xSwapToken` on the pinned Vault `0xf5e1…2bcc`. |
| Verified locally | the calldata is decoded (`decodeVaultSwapCalldata`, `decodeCfParameters`): destination chain, token and address bytes, refund address = escrow, `minPriceX128`, retry duration, broker fee 0, boost 0, no CCM refund, no affiliates, and `dca` — `null` for a single plan, equal to the quoted `{ numberOfChunks, chunkIntervalBlocks }` for a DCA plan; value / token / amount. |
| Refund target | escrow (fill-or-kill: a chunk that cannot meet the min price inside `retryDuration` is refunded; the Vault forwards 8,000 gas). |
| Size | HTTP 400 "insufficient liquidity for the requested amount" → `refused` with the reason (no `limits.max` is stated); `lowLiquidityWarning`, `recommendedSlippageTolerancePercent` → `sizeSignals` and `impactBps` (§2). |
| Halts | `cf_safe_mode_statuses` (swaps, deposits, withdrawals, per-chain witnessing). |
| Track | `GET /v2/swaps/{tx hash}`: `swapEgress` / `refundEgress`; both present → `partial` with `refundedAmount` (§19). |
| Plan | `single` (REGULAR) and `dca`. The quote TTL is 600 s; the min price protects the fill itself. **Measured (Stage 1):** at $100K both quotes come back with the same output (11 chunks); at $1M the backend returns the DCA quote only (≈ 100 chunks at a 1-block interval); from $5M it answers 400 "insufficient liquidity for the requested amount". A DCA-only answer is a valid quote whose plan is `dca`; a 400 is a `refused` competition entry (§2). |
| Link | public: the vault-swap calldata encodes the destination. |

*Implemented:* everything but `dcaEnabled`, keeping both quotes, `dcaParams`, the DCA equality check
and the partial mapping (`adapters/chainflip.ts`: today `:163` picks `REGULAR` and `:201` refuses
`dca`). *Stage 3.*

## 8. Mayan adapter (plan V2 §25, §137.8)

| | |
|---|---|
| Quote | `GET price-api/quote?swift&fastMctp&amountIn64&fromToken&fromChain&toToken&toChain&slippageBps&guaranteedOutput=true&destinationAddress&forwarderAddress&sdkVersion` (the placeholder destination at phase 1). Two order types; the higher guaranteed minimum wins, SWIFT on a tie. |
| SWIFT (`auction`) | the order is built locally with the escrow as trader; ETH wrapped 1:1 by the pinned EthWrapper, tokens via `forwardERC20` with a zero permit (the escrow approves); Swift V2 pinned; cancel + refund fees ≤ 100 bps; deadline 15 min … 6 h; no gas drop; unfilled → cancelled after the deadline and refunded to the escrow (`refundTarget: "escrow"`). |
| Fast-MCTP (`single`) | CCTP fast transfer; the order payload (destination, min-out, deadline) is built locally; the Fast-MCTP contract is pinned; for an ETH source the ETH → USDC router call comes from `get-swap/evm` and is bounded on-chain by the forwarder's `minMiddleAmount`; unfilled → USDC paid to the destination (`refundTarget: "destination"`: the wallet MUST say so). |
| Minimum | `minAmountOut` within slippage + 200 bps of the expected output (a lower one is a changed quote); MUST be ≥ `approvedMin` at phase 3. |
| Size | `priceImpact` → `impactBps`; no stated limits. **Measured (Stage 1):** the CCTP path quotes ETH → SOL and ETH → USDC (Base) from $2M to $10M (9–116 bps) and refuses $25M ("CCTPv2 does not have enough capacity, max per swap 10,000,000"); at $100K and $1M only a SWIFT quote came back and the adapter refused it ("an ETH order is taken only as wrap & lock"), so Mayan is absent below $2M on ETH sources until Stage 3 reads what Mayan's SWIFT quote offers at those sizes. |
| Track | explorer `GET /swap/trx/{hash}`: `clientStatus` (REFUND…, COMPLETED / SETTLED / FULFILLED, INPROGRESS / PENDING). |
| Link | public: the payload carries `destAddr`. |

*Implemented* (`adapters/mayan.ts`). *Stage 3* adds the plan field, `impactBps`, the placeholder and the SWIFT small-size reading.

## 9. NEAR Intents adapter (plan V2 §26–§27, §137.9)

| | |
|---|---|
| Quote | 1Click `POST /v0/quote { dry: true, swapType: EXACT_INPUT, slippageTolerance, originAsset, depositType: ORIGIN_CHAIN, destinationAsset, amount, refundTo (escrow, else the fixed placeholder `0x1111…`), refundType: ORIGIN_CHAIN, recipient, recipientType: DESTINATION_CHAIN, deadline (+30 min) }`; no API key, so 1Click's app fee (0.2–0.25 %) is inside `amountOut`. |
| Binding quote | at phase 3 with `dry: false`: the service allocates a one-time deposit address bound to exactly these parameters; `minAmountOut` MUST be ≥ the dry quote's; recipient and `refundTo` MUST match. |
| Minimum | held and signed by the service, not readable in calldata → `minOutVerified: false`: ranked for information, filtered under every policy but `fastest` (V1.1 §5). |
| Ingress | plain-address. A contract-sent (internal-transaction) deposit is not confirmed credited by the provider → `contractSender: false`: never chosen until `ONECLICK_CONTRACT_DEPOSITS_CONFIRMED=1`. |
| Plan | `intent` (solver competition; a 30-second target settlement). |
| Track | `GET /v0/status?depositAddress=` — needs the deposit address (`providerRef`), not a tx hash (§19). |
| Size | **Measured (Stage 1):** quotes ETH → BTC and USDC → BTC up to $1M (16–25 bps) and answers "No liquidity available" from $2M; the lab could not quote a BTC source (the adapter has no Bitcoin `refundTo` placeholder) and 1Click rejects the Solana system-program id as a recipient — both placeholders are fixed in Stage 3 (a Bitcoin address of the right format; a real-shaped Solana wallet address). |
| Confidential Intents | research note only (plan §27): a TEE-based private shard would change the link evidence; not relied on. |
| Link | unverified → treated as public. |

*Implemented* (`adapters/nearIntents.ts`). *Stage 3* adds the plan field and the placeholders.

## 10. LI.FI adapter (plan V2 §28, §137.10)

| | |
|---|---|
| Quote | `GET /quote?fromChain&toChain&fromToken&toToken&fromAmount&fromAddress (escrow, else 0x…dEaD)&toAddress&slippage&allowBridges=across,mayan` (+ `x-lifi-api-key` when configured; anonymous use is rate-limited: HTTP 429 for two hours after heavy probing — the breaker of §16 covers it). |
| Verified locally | the diamond is pinned; facets are recognised by selector only (AcrossFacetV4 `0xa1f1ce43` / swap `0x1794958f`; MayanFacet `0xb4875292` / swap `0x80c65808`), anything else refused under every policy; chain id, value, the quote's from / to, `BridgeData` receiver / chain / no destination call / spent asset; AcrossFacetV4: refund address = escrow, the output floor `minAmount × outputAmountMultiplier / 1e18` (PP-S01); MayanFacet: sweep recipient = escrow, `mayanAmountIn` (PP-S03); a source swap only into a token the escrow re-shields (PP-S08). |
| Minimum | `toAmountMin` within slippage + 50 bps of `toAmount`; `minOutVerified` only for AcrossFacetV4; MUST be ≥ `approvedMin` at phase 3. |
| Refund target | escrow for Across routes; the Mayan facet's unfilled order pays the destination (the quote carries no `refundTarget`; the wallet shows the warning). |
| Size | none stated; `estimate` values → `impactBps` when present. **Measured (Stage 1):** ETH → SOL answered 422 "none of the available routes could generate a tx" at $1M and 404 "no available quotes" at $5M; ETH → USDC (Base) at $1M routed through a USDC swap on Ethereum first, which the PP-S08 rule refuses unless the pool has a USDC vault (the lab ran without one). |
| Track | `GET /status?txHash=`: `DONE` + substatus `PARTIAL` → `partial`, `REFUNDED` → `refunded`. |
| Smart deposit addresses | the plain-address ingress of V1.1 §6 covers them; not used for an escrow source (no refund-to-pool path). |
| Link | public: `bridgeData.receiver`. |

*Implemented* (`adapters/lifi.ts`). *Stage 3* adds the plan field and the placeholder.

## 11. UniswapX adapter (plan V2 §29, §137.11) — interface only, deferred

Category C (EVM → EVM) keeps Across (+ its Uniswap swap leg) and LI.FI. A UniswapX adapter would
quote through Uniswap's trade API (an API key), sign an exclusive Dutch order (indicative quote →
post-commitment hard RFQ → exclusive filler, UniswapX V2) and let the filler pay the gas. It is not
built in V2 because the **swapper of a UniswapX order signs through Permit2**, so the escrow would
have to (1) answer EIP-1271 `isValidSignature` by delegating to the order key, (2) approve Permit2
for the asset and (3) wrap ETH, UniswapX taking ERC-20 input only. That is an escrow bytecode change
(a new creation hash, the regeneration recipe, the testnet docs). When built it MUST: verify the
minimum locally from the signed order's `outputs[].endAmount` (the decayed floor); require the fresh
destination as the order's recipient; treat an unfilled order as expired with nothing leaving the
escrow (no refund path needed); report the link as public (the order names the recipient).

*Status:* deferred (owner's decision, 2026-10-07). The provider id `"uniswapx"` is reserved.

## 12. Streaming execution model (plan V2 §22–§23, §65–§66, §137.12)

```
ExecutionPlan { mode: "single" | "streaming" | "dca" | "auction" | "intent"; parts: number; intervalBlocks: number; expectedSeconds: number }
```
- **The plan is the engine's choice from live quotes** (plan §22). The user sees "Best execution"
  and, under Route details, "Streaming · N parts · ~T min". Streaming is an execution optimisation
  — it is NOT privacy (plan §23): the privacy score (§17) does not change with the plan. Measured
  (`docs/privacy-lab.md`, streamed-settlement rows): even for a hypothetical provider that kept the
  escrow → destination link private, a 100-minute stream moves the joint effective set from 5.7 to
  6.1 at 100 swaps/h bucketed; with the public link of every adapter today — and a streaming memo
  publishes its quantity and interval — the set is 1 whatever the plan.
- **When a streamed plan is asked for.** The THORChain and Chainflip adapters always ask for the
  streamed plan as well (THORChain with `streaming_interval=1` and `streaming_quantity=0`, the node
  picking the quantity ≤ `max_streaming_quantity`; Chainflip with `dcaEnabled=true`, the backend
  picking `numberOfChunks` / `chunkIntervalBlocks`) and the single plan where the provider still
  answers it. **Calibrated 2026-10-07** (`benchmarks/whale/execution.md`): THORNode refuses the single
  plan from $100K up and Chainflip answers DCA only from $1M, so `STREAM_GAIN_BPS` = 0 — the streamed
  quote is used whenever its net output is at least the single quote's, and always when the single
  plan is refused. `STREAM_MAX_SECONDS` = 14,400 (4 h) bounds automatic selection: THORChain streams
  ETH → BTC in 205 / 411 / 1,031 / 2,063 / 5,160 parts taking ≈ 23 min / 44 min / 106 min / 3.5 h /
  8.6 h at $1M / $2M / $5M / $10M / $25M, and USDC → BTC up to 10,216 parts (17 h), with its own cap
  of 14,400 parts (24 h). A plan longer than the bound is still offered when it is the only route,
  with its duration stated and acknowledged (§24), never silently; a Chainflip DCA quote that does
  not fit is not used. A whale on THORChain chose a 6-hour stream for a $1M BTC swap on 2026-10-07
  (`whale-research.md`), so long streams are a real preference, not a failure mode.
- **Encoding.** THORChain: the memo's limit field becomes `LIMIT/INTERVAL/QUANTITY`
  (`=:ASSET:DEST/ESCROW:LIMIT/INTERVAL/QUANTITY`). Chainflip: `dcaParams` in the
  `encodeVaultSwapData` request, decoded back from `cf_parameters.dca` and compared (§7).
- **What the minimum means for a stream.** THORChain applies the limit per sub-swap, pro rata
  (`LIMIT / QUANTITY`): a sub-swap that would fall below its share does not execute, and the
  unexecuted remainder is refunded to the refund address — the escrow — when the stream ends.
  Chainflip applies the min price per chunk: a chunk that cannot meet it inside the retry duration
  is refunded to the escrow. **So a stream's guarantee is: every part that executes delivers at least
  its share of the minimum, and every part that does not execute comes back to the private balance.**
  The wallet MUST say exactly that ("at least X for what executes; the rest returns to your private
  balance") and MUST NOT present the minimum as a single all-or-nothing floor.
- **Partial fills** are a normal outcome of a stream, reported as `PARTIAL` with `deliveredAmount`
  and `refundedAmount` (§19), never silently accepted and never shown as a failure. The returned
  remainder is re-shielded by the executor's late-refund watch (§20); a remainder below the unpaid
  re-shield floor (PP-S12) stays in the escrow, re-shieldable by anyone, and the wallet says so.
- **Wallet bounds.** The wallet's decoders accept a streaming memo with `INTERVAL ≥ 1` and
  `QUANTITY ≤ STREAM_MAX_QUANTITY` (2,000) and a DCA plan with `chunks × interval + retryDuration ≤
  CF_MAX_RETRY_BLOCKS`; a plan the wallet cannot justify is not signed. Guest mode (UTXO sources) stays
  single-swap.
- **The escrow is unchanged**: one call, one `executed` flag. The streaming happens inside the provider.

*Stage 3* (engine, adapters, service tests) and *Stage 5* (wallet decoders). The constants are
calibrated by `benchmarks/whale/execution-lab.mjs` (Stage 1); the 2026-10-07 probes gave THORChain
2,000 ETH → BTC at 19 bps slippage over ≤ 1,062 sub-swaps and Chainflip 400 ETH → BTC as a
103-chunk DCA, while Chainflip refused 2,000 ETH outright.

## 13. $1M / $5M / $10M risk tiers (plan V2 §4–§5, §13, §66, §100, §137.13)

**Valuation.** The USD value of an order is `amount × price`, the price read from Chainlink's
mainnet feeds through the wallet's own RPC quorum (`VITE_RPC_URLS`: every endpoint answers
`latestRoundData()`, the round ids agree and the answers lie within 0.5 % of each other) and, on
the service, through its RPC. No price API, no new endpoint, nothing user-specific sent anywhere.

| Pair | Feed (mainnet) | Heartbeat |
|---|---|---|
| ETH / USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 1 h |
| USDC / USD | `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` | 24 h |
| USDT / USD | `0x3E7d1eAB13ad0104d2750B8863b489D65364e32D` | 24 h |
| BTC / USD, SOL / USD | resolved once from the Feed Registry (`0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf`, `getFeed`) and pinned in Stage 2 after a `description()` check | 1 h |

Every pinned proxy is verified by `description()` in a test. A price older than **2 × heartbeat** is
*unavailable*. The wallet reads prices only after its first sync and only while it holds unspent
notes (never at first launch; `frontend/test/first-launch.test.tsx` pins it) and journals the last
good price with its time (§25).

**Tiers** (`settings.tiers`, USD; the defaults of plan §13, configurable):

| Tier | Value | Confirmation (§24) | Policy (§4) | Engine (§4, §12, §14) |
|---|---|---|---|---|
| standard | < 100,000 | one tap | the preference | — |
| enhanced | ≥ 100,000 | Review + lint | the preference | both plans quoted; fresh competition at phase 3; `maxGapBps` 100 |
| high-value | ≥ 1,000,000 | Review + simulation + lint + hold-to-confirm | `privacy-execution` unless `best-privacy` | ≥ 2 live quotes or acknowledged; single-shot impact > cap refused when a stream exists; `maxGapBps` 50 |
| high-value-secondary | ≥ 5,000,000 | + the second factor | as above | as above |
| institutional | ≥ 10,000,000 | + the review hold and the export | as above | as above |

- **Fail safe.** When the valuation is unavailable the tier is the higher of `high-value` and the
  tier implied by the last journaled price if it is less than 24 h old; the wallet says "Price
  unavailable — large-transfer checks applied". A small user loses nothing but a few checks; a
  large one is never under-protected.
- **What the rails carry today** (measured 2026-10-07, read-only, `benchmarks/whale/execution.md`;
  informative — the live competition decides, §4):

| pair | $1M | $5M | $10M | $25M |
|---|---|---|---|---|
| ETH → BTC | THORChain stream 9 bps · Chainflip DCA −6 bps · NEAR 25 bps | THORChain 9 bps (106 min) only | THORChain 9 bps (3.5 h) only | THORChain 9 bps (8.6 h) only |
| BTC → ETH | THORChain 58 bps · Chainflip DCA 36 bps | THORChain only | THORChain only | THORChain only |
| USDC → BTC | Chainflip DCA 5 bps · THORChain 34 bps · NEAR 21 bps | Chainflip 4 bps (58 min) · THORChain 35 bps | Chainflip 4 bps (108 min) · THORChain 36 bps | THORChain 36 bps (17 h) only |
| ETH → SOL | Chainflip DCA (−39 bps vs a stale SOL feed) | Mayan 26 bps | Mayan 116 bps | none (Mayan's CCTP cap: $10M per swap) |
| ETH → USDC (Base) | THORChain 49 bps (24 h) | Mayan 20 bps · THORChain 169 bps | Mayan 45 bps · THORChain 345 bps | none |
| ETH → ETH (Base) | Across 1 bps | none (Across max deposit ≈ 1,054 WETH) | none | none |

  Costs are against the Chainlink rate at quote time (fees included; the SOL feed was 11 h old, so
  the SOL rows' oracle comparison is unreliable). At $5M and above most pairs have one venue, so the
  "two live quotes or acknowledged" rule of §4 fires routinely: the Review then says "only one
  provider can take this size" rather than hiding it.
- The service recomputes the tier from its own read; a disagreement raises the tier (§1).
- Tiers apply to swaps, withdrawals and private transfers alike (the value of what leaves the
  wallet's control); shields are valued for display only.

*Stage 2.*

## 14. Price protection (plan V2 §8, §14, §137.14)

- **At commit** `approvedMin` = the shown quote's `toAmountMin`; the quote MUST be younger than
  `expiresAt − 30 s`; `executeDeadline` = the quote's expiry plus the policy's maximum delay
  (V1.1 §8), re-quoted at funding if the scheduled time passes it.
- **At prepare** the hard quote's guaranteed minimum MUST be ≥ `approvedMin`; otherwise the
  service answers `MinimumMoved { approvedMin, newMin }` and the wallet asks for consent to the
  exact new value, which it journals as the new `approvedMin`. The service MUST also run the
  **price guard**: the hard quote's minimum MUST NOT be more than `maxGapBps` (100; 50 at tier ≥
  `high-value`) below the best live alternative's minimum from a fresh competition
  (`scoring.ts::priceGuard`); a worse re-quote is refused, whatever the earlier quote said.
- **Changed-quote bounds per adapter** (a lowered minimum is a changed quote): NEAR +100 bps,
  Mayan +200, LI.FI +50, Across swap leg +50 over the requested slippage; THORChain and Chainflip
  compute their minimum locally.
- **The signed deadline** = `min(quote.expiresAt, executeDeadline)` (V1.1 §5 errata).
- **Slippage** is 50 bps by default; at tier ≥ `high-value` the wallet uses the lower of 50 bps and
  the provider's recommended tolerance only when the provider states one (Chainflip).
- For a stream the protected minimum is the pro-rata minimum of §12 and the wallet's wording follows it.

*Implemented:* the bounds, `priceGuard`, consent (`adapters/*`, `scoring.ts`, `frontend/src/sdk/swapSign.ts`);
the guard is not wired into `/prepare` and `approvedMin` is wallet-side only. *Stage 3.*

## 15. Minimum-output rules (plan V2 §15, §137.15)

| Provider | Where the minimum lives | Verified by | Notes |
|---|---|---|---|
| THORChain | memo `LIMIT` (1e8 units) | service + wallet (memo built locally, parsed by the wallet) | streaming: pro rata per sub-swap (§12) |
| Chainflip | `cfParameters.minPriceX128` | service + wallet (decoded) | DCA: per chunk (§12) |
| Mayan SWIFT / Fast-MCTP | the order's `minAmountOut` (built locally) | service + wallet (decoded) | Fast-MCTP unfilled → USDC at the destination |
| NEAR Intents | the service-signed quote | provider only → `minOutVerified: false` | filtered unless `fastest` |
| LI.FI AcrossFacetV4 | `minAmount × multiplier / 1e18` | service + wallet | the facet recomputes it on chain |
| LI.FI MayanFacet | inside Mayan's order | provider only → `minOutVerified: false` | filtered unless `fastest` |
| Across depositV3 | `outputAmount` (exact fill) | service + wallet | unfilled → refund in the input token |
| Across swap leg | `depositData.outputAmount` | service + wallet | proportional adjustment only raises it |

- The wallet signs only a call whose guaranteed minimum it read itself and found ≥ `approvedMin`;
  a call it cannot read is not signed; a minimum it cannot read is accepted only under `fastest`
  (V1.1 §2, §5).
- `minOutEncoded: false` routes are refused under every policy but `fastest`, with a warning.
- Dust: a minimum below the destination chain's dust threshold (THORChain `dust_threshold`) is refused.

*Implemented* (`frontend/src/sdk/providerCall.ts`, `swapSign.ts`; the adapters). *Stage 5* adds the
streaming and DCA readings.

## 16. Provider health scoring (plan V2 §62–§64, §137.16)

```
reliability(h) = 100 − 100·[!reachable] − 60·[halted] − 15·[latency > 2 s] (−5 if > 800 ms)
                 − 10·[chain of this order in haltedChains] − 10·min(3, failures.windowCount)
security(p)    = BASELINE_SECURITY[p] − Σ incidents penalty · max(0, 1 − age / halfLifeDays)
```
- `Health` gains `failures` (§5): consecutive quote failures / timeouts and the count in the last
  hour, kept in the service's memory per provider. A **circuit breaker** opens after 3 consecutive
  failures and skips the provider for 5 minutes (competition `skipped`); any success closes it.
- Health is cached for 30 s; `quoteAll` reads the cache, not the provider, when fresh.
- The **incident feed** is `INCIDENTS` (`health.ts`) plus an operator file `INCIDENTS_FILE` (same
  shape); classes key-compromise (−25), bridge (−20), other (−10), decaying linearly to zero at
  `halfLifeDays`. The THORChain 2026-05-15 GG20 incident is the first entry.
- **Isolation.** A halted, unreachable or broken provider is a `halted` / `refused` / `skipped`
  entry; every other provider is quoted and chosen normally (plan §62, §114). The adapters share
  no state.
- UI: "Route security: Good / Fair / Poor" at security ≥ 80 / ≥ 60 / below; the numbers under Advanced.

*Implemented:* `securityScore`, `reliabilityScore`, `INCIDENTS` (`health.ts`). *Stage 3* adds the
failure history, the breaker, the cache, the chain term and `INCIDENTS_FILE`.

## 17. Privacy scoring (plan V2 §67–§69, §137.17)

The eight factors, weights and the cross-chain term of V1.1 §10 are unchanged. Two corrections:
- `amountIsBucket` MUST be `isBucketOf(amount, decimals)` (the engine used the 18-decimal series
  for every asset);
- `destinationFresh` MUST come from `destination.kind` (§21), not be assumed.
The same function runs in the engine and the wallet (`services/private-swap/src/privacyScore.ts`,
`frontend/src/privacy/privacyScore.ts`); the execution plan does not change it (§12). Financial
privacy (who owns what, the private history) and execution privacy (order size, timing, intent) are
reported separately (plan §67): the first by this score and the scorecard, the second by the plan
and the public-settlement warning (§18).

*Stage 3.*

## 18. Privacy lint (plan V2 §10, §48, §76, §137.18)

A per-transaction checklist computed before commit and again before signing, from the order, the
journal and the scorecard facts, by one function shared by the wallet and the engine
(`reference/typescript/src/wallet/privacyLint.ts`):

| Item | ok when | otherwise | Category (plan §10) |
|---|---|---|---|
| `source-not-reused` | the source is the one-time escrow / the pool | block (never true for a private action) | Financial privacy |
| `destination-fresh` | `destination.kind == "fresh"` | warn: "the destination was entered by hand; whoever knows it knows this payment" | Destination linkage |
| `destination-not-public-wallet` | the destination is not the connected public wallet's address | block (acknowledge) | Destination linkage |
| `no-public-linkage` | the provider keeps the escrow → destination link private | warn with the plan §76 wording: the route settles publicly; the destination amount will be visible; the private source stays protected, but timing and amount may be correlated | Provider visibility |
| `private-wallet-used` | the action spends shielded notes | block | Financial privacy |
| `provider-identity-detached` | the quote requests carried placeholders and no identifier (§5) | warn | Provider visibility |
| `timing` | the scheduled delay ≥ 6 h | warn ("timing may correlate") at ≥ 1 h, warn stronger below | Timing risk |
| `amount-fingerprint` | the public amount is a bucket | warn | Amount fingerprint |
| `minimum-protected` | `minOutVerified` and `approvedMin` encoded | block at tier ≥ `high-value`, warn below | Financial privacy |
| `network` | relayer submission, ≥ 2 RPC endpoints, light-client reads on | warn | Network privacy |
| `large-piece` | the public piece is within the shipped bucket alphabet, or at least 16 holders could still pay it (counted from the pool's public deposit sizes) | warn: "a whale among whales — only N holders could pay this piece; pieces over time widen the set (housekeeping, Stage 8)" | Amount fingerprint |

- Levels: `ok`, `warn`, `block`. A `block` item at tier ≥ `high-value` MUST be acknowledged
  explicitly before the hold-to-confirm is enabled; below it, it is a warning with the same text.
- The list is shown as plan §48's ✓ / ⚠ lines; the six categories are the headings of the
  privacy simulation (plan §10) and map onto the score's factors (`sourceIdentity`,
  `destinationIdentity`, `amountCorrelation`, `timingCorrelation`, `providerVisibility` +
  `bridgeVisibility`, `mempoolVisibility`).
- The wallet MUST NOT say "anonymous" or "100 % private" anywhere; the Privacy Center states the
  limits of plan §69.

*Stage 5.*

## 19. Cross-chain failure states (plan V2 §60–§61, §96, §137.19)

The V1.1 §3 state machine is unchanged (`order.ts`); this section fixes what the wallet shows and
where it gets its facts.

| User label (plan §61) | States | Fact source |
|---|---|---|
| Preparing | QUOTED, COMMITTED (funding scheduled) | journal |
| Waiting for source | SOURCE_SUBMITTED | the funding transaction / relayer submission status |
| Executing | SOURCE_FINAL (job `executing`), PROVIDER_EXECUTING | escrow balance (RPC quorum); relayer job `executing` / `executed` + `executionTx` |
| Waiting for destination | DESTINATION_SUBMITTED, DESTINATION_FINAL | `GET /track/:provider?tx=<executionTx>&ref=` |
| Partial | PARTIAL | track: delivered and refunded amounts |
| Refunding | REFUND_PENDING, PROVIDER_TIMEOUT, DESTINATION_FAILED | relayer job `refunding` / `refund-only` / `expired`; time ≥ `refundAfter` |
| Refunded | REFUNDED | relayer `refunded` + the refund note found in the pool (PP-S09) |
| Completed | COMPLETED | track `completed` / delivered ≥ minimum, and the executor's late-refund watch ended empty |
| Not started | EXPIRED, CANCELLED, SOURCE_FAILED | nothing left the pool |
| Needs attention | FAILED | says where the money is (escrow balance, refund token) — never a bare "failed" |

- The four-step line of plan §60 — **Quote locked** (COMMITTED), **Source confirmed**
  (SOURCE_FINAL), **Destination sent** (DESTINATION_SUBMITTED), **Destination finalized**
  (DESTINATION_FINAL / COMPLETED) — is shown for every swap.
- `GET /track/:provider?tx&ref` is stateless (the service's order map does not survive a restart):
  the wallet passes the execution transaction hash and, for NEAR Intents, the deposit address. The
  relayer records `SwapJob.executionTx` once and never overwrites it (`txHash` is reused by refund
  transactions).
- PARTIAL for a stream: `deliveredAmount` at the destination and `refundedAmount` back at the
  escrow (§12); the label says both.
- Every transition is journaled with its time (§25); on restart the wallet re-derives the state
  from the journal, the relayer job, the escrow balance and the tracker (`recoverState`).
- "Atomic" MUST NOT appear anywhere (V1.1 §3).

*Implemented:* the machine, `recoverState`, `userStatus` (`order.ts`); the wallet shows the relayer's
job labels only. *Stage 3* (tracking endpoint, `executionTx`) and *Stage 7* (wallet tracker and labels).

## 20. Refund state machine (plan V2 §61, §105, §137.20)

V1.1 §7 holds in full. Restated with the executor's job states (`services/relayer/src/swapExecutor.ts`):

```
waiting-funding ─▶ executing ─▶ executed ──(late-refund watch, 24 h past refundAfter)──▶ completed
      │                │             │
      ▼                ▼             └─▶ refunding ─▶ refunded        (provider paid back: refund / refundToken)
   expired        execute-failed
      │                │
      └────────────────┴─▶ refund-only ─▶ refunding ─▶ refunded | refund-failed
```
- A funded order the wallet will not execute (refused call, no consent, changed mind) MUST still
  come back: the refund-only job (`POST /swap/refund`) calls `deployAndRefund` at `refundAfter`;
  a later signed execution replaces it while it is open (`REPLACEABLE` states).
- After execution no tip pays for a re-shield: at most `MAX_UNPAID_REFUNDS` (3) per order, each
  above its floor (ETH / WETH 2 × gas, the order's token 1 %, a listed token the wallet's floor);
  foreign tokens through `refundToken` into their canonical vault, WETH / ETH of a token order as
  ETH (PP-S08, S10, S11, S12).
- A stream's remainder (§12) arrives as a provider refund during or after execution and is
  re-shielded by the same watch; the wallet shows it as part of PARTIAL and then as a refund note.
- Refund notes reach the wallet through the journaled payload or, journal-free, the seed-derived
  payloads (PP-S09, PP-P03).
- The provider-level refund targets: THORChain / Chainflip / Mayan SWIFT / Across / LI.FI-Across →
  the escrow; Mayan Fast-MCTP → USDC at the destination; NEAR → the escrow (`refundTo`).

*Implemented* (relayer, escrow, wallet refunds). *Stage 3* adds `executionTx`.

## 21. Source / destination address model (plan V2 §16–§18, §58–§59, §137.21)

- **Source**: always the one-time escrow (V1.1 §6), funded by a private withdrawal; the user's
  permanent public address never appears in a quote, a call or an order (`privacy-flow.test.ts`).
- **Destination**: fresh by default — the Chain Key Abstraction's next unused address for the
  destination chain (BIP-44 EVM, BIP-84 `bc1q`, SLIP-0010 Solana; reserved only on confirm) —
  `kind: "fresh"`. An entered address is allowed, `kind: "entered"`, and the lint flags it (§18);
  the connected public wallet's own address is blocked until acknowledged.
- **Formats** (`reference/typescript/src/wallet/destinations.ts`): EVM — 20 bytes hex, EIP-55
  checked when mixed-case; Bitcoin — bech32 `bc1q` (v0, 20 or 32 bytes), bech32m `bc1p` (v1, 32
  bytes), base58check P2PKH (0x00) and P2SH (0x05), mainnet only; Solana — base58, 32 bytes. An
  address that parses on another chain is refused with that chain's name ("this looks like an
  Ethereum address; the destination is Bitcoin", plan §59). Tron and others: later.
- **The provider call's receiver** MUST equal the destination's chain-specific bytes (Chainflip
  `encodeDestination`, THORChain memo text, Mayan `addressHex32`, LI.FI / Across addresses); the
  wallet checks it before signing (`providerCall.ts`).
- **Human-readable card** (plan §58): Network, Asset, Address grouped in fours, Amount in the asset
  and in USD; shown wherever an address is confirmed (Swap, Withdraw, Guest, Receive) and, at tier
  ≥ `high-value`, together with the QR (plan §57: the QR alone is never the confirmation).

*Implemented:* the escrow source, fresh destinations, the receiver checks. *Stage 5* adds the parser,
the wrong-chain refusal and the card.

## 22. zkAPI quote-service integration (plan V2 §33–§37, §77–§81, §137.22)

- **Interface** (`services/private-swap/src/gateway.ts`): the same engine behind a zkAPI
  capability — `POST /quote` with `Authorization: zkapi <runtime key>` (runtime-key mode only,
  V1.1 zkAPI spec §2), a random 16-byte request id per request (never reused, never derived from
  the user), no account, no cookie, metered per request within zkAPI's charge cap. The payment side
  learns that a lease paid for N requests; the gateway sees the request (assets, amount, the
  placeholder destination) and the caller's IP — zkAPI does not hide network metadata (plan §37),
  so the wallet's transport policy (`frontend/src/zkapi/policy.ts`: no proxy, pinned configuration)
  applies and Tor / mixnet remain native-host work.
- **Status: blocked upstream.** The live zkAPI deployments lease OpenRouter keys only. The gateway
  becomes live when a zkAPI deployment registers an upstream of this service's kind; until then
  `gateway.ts` exposes the interface and `health()` answers "not available upstream". The wallet
  does not pretend otherwise.
- **"Check this trade"** (plan §77–§79): the Review screen can send a sanitized summary to Private
  AI — assets, amounts rounded to three significant digits, the competition record, the plan, the
  lint, the tier; **no address, no identity, no note data** — and shows the answer as best route /
  alternative / estimated savings / privacy / execution / risk. The assistant recommends, simulates,
  explains, compares and warns; it MUST NOT sign, withdraw, change a destination or override a
  check (plan §78): the AI module imports nothing that signs or submits, pinned by a test.
- The service layer MUST NOT become a user database (plan §81–§86): it keeps quote ids, provider
  health, route health, non-sensitive execution state and zkAPI operational state; never a
  permanent identity → wallet map, a portfolio or an address list.

*Implemented:* Private AI, runtime-key mode, pins (`docs/private-ai.md`). *Stage 9.*

## 23. Mobile order screen (plan V2 §39–§45, §90–§95, §137.23)

Normative content of the Swap screen (plan §44) and of the app around it:
- Four tabs — **Home, Swap, Send, Activity** — and nothing else in the main navigation (plan §39,
  §92). Home shows the private balance (USD, "Details" for the per-asset lines), Send and Swap, the
  🛡 privacy badge that opens the Privacy Center (plan §93: the six categories with word levels and
  plain explanations), Add funds, Receive, Private services and Settings.
- Swap MUST show: From (private asset, amount), Receive (asset, ≈ amount), "Best route:
  Automatic", Privacy (word level), Price (word level from the price component), Time (~ETA), and
  Review. It MUST NOT show by default: provider names, scores, the escrow, the order key, proof
  timings, RFQ / TWAP / solver / MEV vocabulary (plan §4, §45).
- "Route details" MAY show: the provider, the execution mode and parts, the fees, the expected
  output, the settlement (finality), the alternatives from the competition record with the reason
  each lost, the link evidence; Advanced adds the score components.
- Desktop (≥ 1024 px, plan §94–§95) adds Overview / Private Assets / Privacy Center / Advanced to
  the navigation and shows the route comparison table, gas, slippage, liquidity and provider status.
- Visual rules (plan §41–§42): neutral background, one primary accent, one security accent, one
  warning colour; rounded cards, large numerals, no provider logos, no jargon, light and dark.
- Trade preference (plan §97) lives in Settings, never on the Swap screen and never on chain.

*Stage 4* (shell, Home, Privacy Center, preference, style) and *Stage 6* (Review).

## 24. Large-transfer confirmation (plan V2 §4–§5, §11–§13, §46–§48, §100, §137.24)

For tier ≥ `high-value` the Review screen is mandatory at both irreversible moments — commit
(the withdrawal funds the escrow) and execute (the signed call) — and MUST show:
1. the amount in USD (large) and in the asset;
2. From (Private <asset>) and To (the destination card of §21);
3. Receive ≥ `approvedMin`, with the stream wording of §12 when the plan streams;
4. Execution in words ("Private streaming route", "Private route", "Private auction") and the
   estimated time;
5. Privacy: the level word, the score, the lint list of §18;
6. the five lines of plan §4 with their meaning: **Price protected** (`approvedMin` + the price
   guard), **Route checked** (the simulation passed; ≥ 2 quotes or acknowledged), **Destination
   verified** (format + fresh, or entered and acknowledged), **Slippage checked** (impact ≤ cap),
   **Privacy reviewed** (no unacknowledged `block`);
7. the issuer line for an issuer-controlled token (plan §71: "Issuer: centralized · Freeze risk:
   present · Vault: isolated") and "Native-to-native" / "Issuer-dependent" for the route (plan §72).
- **Pre-trade simulation** (plan §9, at execute): the wallet simulates
  `SwapOrderFactory.deployAndExecute(params, execution)` through every RPC endpoint with a
  non-zero `account` (the tip recipient), requires every endpoint to succeed, reports the gas,
  decodes a revert with the escrow's errors, recovers the provider's reason by a second call from
  the escrow for ETH orders, and keeps the signature in the wallet until the simulation passes. The
  relayer's own `estimateGas` gate stays. Before funding, an ETH order MAY be previewed with a
  balance override on the predicted escrow.
- **Hold-to-confirm**: a 1.5 s pointer hold with a visible progress ring (a keyboard equivalent
  exists); a tap is never enough (plan §12).
- **Second factor** (≥ `high-value-secondary`): a WebAuthn platform-authenticator assertion with
  `userVerification: "required"` (Face ID / Touch ID / Windows Hello), registered once in Settings;
  the wallet password is the fallback. It gates the action and holds no key material.
- **Review hold** (`institutional`): funding is scheduled no earlier than a visible cancel window
  (default 30 min) and the order — params, quotes, competition, simulation, lint — can be exported
  as JSON for an outside reviewer (plan §66). Multi-operator approval is outside this document.
- **Wording**: never "atomic", never "anonymous"; the plan §76 warning whenever the link is public;
  "only one provider answered" when the competition had one live quote.
- Below `high-value`: `enhanced` shows the Review with the lint and a tap; `standard` keeps the
  one-tap flow with the destination card.

*Stage 5* (simulation, lint, card) and *Stage 6* (Review, hold, second factor, review hold, issuer line).

## 25. Local encrypted order history (plan V2 §49–§50, §83–§86, §137.25)

Everything the wallet remembers lives in the encrypted journal (`frontend/src/wallet/journal.ts`:
XChaCha20-Poly1305 under `sha256("privacy-protocol/v1/journal-key" ‖ seed)`), never on a server.

```
StoredSwap {                                   (V1.1 fields unchanged)
  orderId, attemptId, refundCounter, refundNoteData?, provider, policy, request, params, endpoint, quote?, approvedMin?,
  createdAt, dueAt?, fundedTx?, jobId?, refundTokens?, refundFloors?, refunds?[], state
  value?        Valuation (§13)              tier?        Tier            preference?   Preference
  plan?         ExecutionPlan (§12)          competition? CompetitionEntry[]
  lint?         { items: LintItem[], at }    simulation?  { ok, gas?, error?, at }
  executionTx?  hash  (journaled the first time the relayer job reports executing)
  track?        { state, destinationTxHash?, deliveredAmount?, refundedAmount?, at }
  history?      [{ state: OrderState, at, note? }]
}
ActivityRecord { id, kind: "shield" | "transfer" | "withdraw" | "swap" | "refund" | "housekeeping", at, asset, amount, status, ref, note? }
JournalData += { activity?: ActivityRecord[], prices?: { pair: { usd, at } } }
```
- New fields are optional and are not written by `emptyJournal()`, so the pinned at-rest vectors
  (`reference/typescript/test/vectors/wallet.json`) and old journals stay valid; readers default
  them (`?? []`).
- The Activity screen (plan §49) is this list: date, asset, amount, status, the private reference
  (order id / tx hash / leaf index); finished records can be deleted by the user; the backup file
  carries them.
- Stored locally only: date, asset, amount, status, private reference, route status (plan §50).
  Never sent to analytics; never reconstructed server-side (plan §51, §83–§84).
- What the service and the relayer MAY hold: quote ids, provider and route health, job state and
  transaction hashes, non-sensitive execution state, zkAPI operational state (plan §86). They MUST
  NOT hold a user id, a portfolio, an address list or a permanent identity → order map; the
  service's order map is a session cache.

*Implemented:* `StoredSwap` without the new fields; no activity list. *Stage 2* (`prices`), *Stage 4*
(`activity`), *Stage 5* (`lint`, `simulation`), *Stage 7* (`track`, `history`, `executionTx`).

## 26. Out of scope here

The UniswapX implementation (§11); React Native / Tauri shells and native biometric unlock
(`docs/mobile.md`); institutional multi-operator approval (plan §88); NEAR Confidential Intents as
a relied-on privacy path (plan §27); hardware wallets and WalletConnect (plan §101); recurring
scheduled operations (plan §98); Tor / mixnet transport (plan §37); Tron key management (plan §102);
execution with real funds and the testnet broadcast; independent audits (plan §131).
