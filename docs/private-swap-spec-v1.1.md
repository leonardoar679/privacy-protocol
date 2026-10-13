# PrivateSwap Protocol Specification V1.1

Normative. How a private note leaves the pool into a cross-chain swap and comes back if the swap
fails — **without THORChain, Chainflip, Mayan, NEAR Intents, LI.FI or Uniswap/Across becoming part of
the money core's trust model** (plan V1.1 §13–§34, §85 Rules 2–4, 10). `PrivacyCore` and the vaults
are unchanged by this document; everything here is periphery (replaceable) or wallet (replaceable).

Status words MUST / MUST NOT / SHOULD are RFC-2119. Code: `contracts/src/periphery/swap/`,
`packages/swap-engine/`. Extended by `docs/whale-execution-spec-v1.0.md` (V2: value tiers, execution
plans, the RFQ lifecycle, the lint, the wallet screens), which restates nothing here it does not change.
Errata of 2026-10-07 (the text conformed to the code): §2 Order fields, §4 adapter signature and
`Capabilities`, §5 the signed deadline, §8 the delay windows per policy, §9 reliability, §11 test count.

---

## 1. Layering and the damage bound

```
PrivacyCore ──transact(WITHDRAW)──▶ one-time source endpoint ──ingress──▶ provider ──▶ fresh destination
   (immutable, unchanged)            (SwapOrderEscrow, periphery)       (replaceable)   (wallet-owned)
                                             │ failure / expiry
                                             └──refund──▶ vault.deposit(fresh note)  (back in the pool)
```
Invariant D1 (plan §74): the funds a provider — or a compromised adapter, router or solver — can ever
reach are **exactly the balance of the one escrow the order funded**. The core holds nothing; every
vault's accounting is untouched by anything the escrow or the provider does. This is enforced by
construction (the escrow is just a withdrawal recipient) and tested (`contracts/test/periphery`).
V3 (`docs/high-value-protection-spec-v1.0.md` §5) executes a large order as a sequence of such escrows
(tranches): D1 holds per tranche, and the campaign's in-flight cap bounds what is simultaneously
reachable across them.

## 2. Order object (wallet-side, canonical)
```
Order {
  orderId        bytes32   uniformly random, unique per order (also the CREATE2 salt)
  request        QuoteRequest (§4): from { chain, asset, decimals, symbol }, to { … }, amount (gross, in `from` units),
                 destination (fresh, §6), source? (the escrow once known), slippageBps
  policy         "best-privacy" | "best-price" | "fastest"   (V2 adds "balanced" and "privacy-execution")
  quote          Quote (§4) chosen by the engine; re-quoted at prepare (§5)
  ingress        Ingress (§4): the escrow's one call, once prepared
  params         OrderParams (§6): the committed escrow parameters, incl. the FRESH refund note (§7)
  endpoint       address: the predicted escrow
  execution?     Execution (§6): signed once the final ingress is known
  privacy        { delaySeconds: [min, max] (§8), amountNormalized: bool (§8), score (§10), destinationLinkPublic (§10) }
  state          OrderState (§3);  history [{ state, at, note? }]
}
```
The minimum output the user approved at commit (`approvedMin`, in destination units) is journaled
by the wallet (`packages/sdk/src/wallet/journal.ts`); a provider call guaranteeing less is signed only
after consent (below). It MUST be ≤ the quote's `toAmountMin` and is carried in the provider ingress
where the provider supports a limit (§5). V2 §1 carries it in the order server-side too.
`orderId` MUST NOT be derived from user identity. The wallet persists the order in its journal
before any on-chain action (recovery, §3).

The wallet MUST NOT take the service's word for anything it funds or signs
(`packages/sdk/src/swapGuard.ts`): it recomputes the escrow address (§6) from its OWN factory
address and the returned params, and checks that the params carry its one-time signer and refund
note, the amount and asset it asked for, that asset's canonical vault for refunds, a tip within the
1 % cap and a refund horizon of at most a week — before the order is journaled and again before the
withdrawal funds the escrow. Before the order key signs, the wallet recomputes the execution digest
from the provider, value, calldata and deadline it is shown, and checks the deadline against the
order's and the value against what the escrow may forward. It then reads the provider call itself
(`packages/sdk/src/providerCall.ts`, gate `swapSign.ts`), against its own journal: the target MUST be a
pinned provider contract, the receiver the wallet's fresh destination, provider refunds the escrow (or,
where the provider can only refund at the destination, that address, §7), the amount exactly what the
escrow forwards, and the minimum the call guarantees MUST be at least the minimum the user approved
at commit (journaled). A lower minimum is signed only after the user consents to that exact value; a
call the wallet cannot read is not signed; a minimum it cannot read is accepted only under `fastest`
(§9). THORChain's inbound vault is confirmed by the wallet's own quorum of public THORNode gateways.

## 3. Route state machine (plan §34) — non-atomic by construction
```
QUOTED ─▶ COMMITTED ─▶ SOURCE_SUBMITTED ─▶ SOURCE_FINAL ─▶ PROVIDER_EXECUTING ─▶ DESTINATION_SUBMITTED ─▶ DESTINATION_FINAL ─▶ COMPLETED
   │           │              │                 │                  │                       │
   │           │              ▼                 ▼                  ▼                       ▼
   │           │        SOURCE_FAILED      PROVIDER_TIMEOUT     PARTIAL             DESTINATION_FAILED
   │           │                                 │                  │                       │
   ▼           ▼                                 └──────────────────┴───────┬───────────────┘
EXPIRED    CANCELLED                                                         ▼
                                                                      REFUND_PENDING ─▶ REFUNDED
                                                                             │
                                                                             ▼
                                                                          FAILED (manual: funds in escrow, refund not yet possible)
```
| State | Meaning | On-chain fact |
|---|---|---|
| QUOTED | quote obtained, nothing committed | — |
| COMMITTED | escrow parameters fixed, address predicted, order journaled | — |
| SOURCE_SUBMITTED | `transact(WITHDRAW → escrow)` broadcast | pending tx |
| SOURCE_FINAL | withdrawal finalized; escrow funded | escrow balance == amount |
| PROVIDER_EXECUTING | `execute()` done; provider has the funds | `Executed` event |
| DESTINATION_SUBMITTED / FINAL | provider's outbound seen / finalized on the destination chain | adapter `track()` |
| COMPLETED | destination amount ≥ minOut received at the fresh address | — |
| PARTIAL | provider delivered a different asset/amount than quoted (LI.FI documents this) | adapter status |
| PROVIDER_TIMEOUT | no outbound within the provider's window | — |
| REFUND_PENDING | `refundAfter` reached, funds (or remainder) still in escrow | — |
| REFUNDED | `refund()` re-shielded the balance as the committed fresh note | `Refunded` + vault `Deposited` |
| EXPIRED | quote expired before SOURCE_SUBMITTED; nothing left the pool | — |
User-visible labels: Pending (QUOTED…SOURCE_FINAL), Executing, Completed, Partial, Refunding
(REFUND_PENDING), Refunded, Failed. The UI MUST NOT say "atomic" (plan §33).

Recovery: on restart the wallet re-derives the state from the journal + chain (escrow balance,
events, adapter status) — the same pattern as the reorg-aware indexer (`packages/protocol/src/indexer.ts`).

## 4. Provider adapter interface (plan §23)
```ts
interface ProviderAdapter {
  id: "thorchain" | "chainflip" | "mayan" | "near-intents" | "lifi" | "uniswap-across";
  implemented: boolean;                          // false = interface-conformant stub (one at a time, §66)
  capabilities(): Capabilities;
  quote(req: QuoteRequest): Promise<Quote>;        // live; MUST include toAmountMin, expiresAt, fees, eta
  prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress>;   // builds AND verifies the escrow's one call
  track(ref: { sourceTxHash?: string; providerRef?: string }): Promise<TrackStatus>;   // maps to §3 states
  health(): Promise<Health>;                       // §9
}
Capabilities = { routes: RouteCategory[]; ingress: IngressKind[]; nativeAssets: boolean; atomic: false; chains: Chain[];
                 contractSender?: boolean;        // false: a contract-sent ingress is unconfirmed → quoted, never chosen (§6)
                 destinationLinkPublic: boolean; linkEvidence: string }   // §10
QuoteRequest = { from: AssetRef, to: AssetRef, amount (net of the tip), destination, source?, slippageBps }
Ingress = { kind: "plain-address" | "contract-call", to: address, calldata: hex, value: bigint,
            memo?: string, expiresAt: number, minOutEncoded: boolean, verified?: string[], refundTokens?: string[] }
Quote  = { provider, category, toAmount, toAmountMin, fees[], etaSeconds, expiresAt, nativeAssets, minOutEncoded,
           minOutVerified?, refundTarget?: "escrow" | "destination", hops[], raw, obtainedAt }
TrackStatus = { state: "pending" | "executing" | "destination-submitted" | "destination-final" | "completed" | "partial" | "refunded" | "failed" | "unknown",
                destinationTxHash?, deliveredAmount?, deliveredAsset?, raw? }
Health = { provider, reachable, apiLatencyMs, halted, haltedChains: string[], checkedAt, note? }
RouteCategory = "A native↔native" | "B evm→solana" | "C evm→evm" | "D solana→evm" | "E bitcoin→evm"
```
The provider-level refund path of an order is `Quote.refundTarget` (§7), not a separate method;
the full type definitions, with the V2 additions, are in `docs/whale-execution-spec-v1.0.md` §5.
Category → preferred providers (plan §32): A THORChain/Chainflip/NEAR; B Mayan/NEAR/LI.FI;
C Uniswap-Across/LI.FI; D Mayan/NEAR/LI.FI; E THORChain/Chainflip/NEAR/LI.FI.

## 5. Quote expiration and minimum-output protection
- The signed `Execution.deadline` MUST be `min(quote.expiresAt, executeDeadline)`: never past the
  hard quote's expiry, never past the escrow's committed `executeDeadline`; `execute()` is refused
  after it.
- The signed provider calldata/memo MUST carry the limit where the provider supports one: THORChain
  memo `=:ASSET:dest/ESCROW:LIMIT`, LI.FI `toAmountMin` (inside its `transactionRequest`), Chainflip
  `cfParameters.min_price` + refund address of a vault swap (`Vault.xSwapNative`), Mayan `minAmountOut`.
  Calldata obtained from a provider API MUST be decoded and checked locally before signing (the
  Chainflip adapter pins the Vault address and verifies destination, refund address and min price;
  the LI.FI adapter pins the diamond and verifies chain id, value, the quote's from/to, the
  `BridgeData` receiver / destination chain / no-destination-call / spent asset, reads facets by
  selector only (AcrossFacetV4, MayanFacet; any other facet is refused under every policy), for
  AcrossFacetV4 the refund address, the assets and the output the facet hands Across — in the swap
  variant `minAmount × outputAmountMultiplier / 1e18`, because the facet recomputes it on chain — and
  for MayanFacet the sweep recipient (the escrow) and `mayanAmountIn`; the Across swap leg pins the
  SpokePoolPeriphery and the SpokePool it deposits into (the periphery accepts any and approves it for
  the swapped tokens), takes the guaranteed output from the deposit's `outputAmount` (proportional
  adjustment only raises it), requires the escrow as depositor, and reads the destination message: only
  `drainLeftoverTokens(output token, fresh address)` on the pinned MulticallHandler and `emitData` on the
  pinned AcrossEventEmitter, with something draining the output token to the fresh address (for native
  ETH: `makeCallWithBalance(WETH, withdraw(0), 0, [{WETH, 4}])`, the handler unwrapping its own WETH, then
  a drain of native ETH to the fresh address after it); the THORChain adapter takes the inbound vault and
  router only from a quorum of independent gateways; Mayan's Fast-MCTP and Swift V2 contracts are pinned,
  and a SWIFT order is built locally with the escrow as trader, ETH wrapped 1:1 by the pinned EthWrapper,
  no gas drop, no referrer, cancel + refund fees within 1% and a deadline 15 min .. 6 h ahead). The executor therefore cannot lower the limit:
  a different calldata has a different signature.
- A quote whose claimed minimum is inconsistent with the requested slippage (more than slippage +
  0.5–2 % below the expected output, per adapter) MUST be refused as a changed quote; at signing
  time the re-quote MUST pass the **price guard** (`scoring.ts::priceGuard`: not more than
  `maxGapBps` below the best live alternative). *Implemented* in the engine and its tests; wired into
  the service's `/prepare` by V2 §14 (Stage 3).
- Where the minimum output cannot be confirmed inside the calldata that will be signed, the quote
  MUST carry `minOutVerified: false`; such routes are quoted for information and refused under
  `best-privacy` / `best-price` (LI.FI's Mayan facet; NEAR Intents, whose minimum is
  held and signed by the service). The ingress lists what was verified (`Ingress.verified`).
- Where a provider offers no limit, the engine MUST mark the route `minOutEncoded: false` and the
  wallet MUST either refuse it under `best-privacy`/`best-price` or show an explicit warning.
- A quote older than `quote.expiresAt − 30 s` at COMMIT time MUST be re-quoted.

## 6. One-time endpoints (plan §26–§28)
**EVM source endpoint = `SwapOrderEscrow`**, a minimal periphery contract at a counterfactual CREATE2
address: `address = CREATE2(factory, salt = orderId, initcode = escrow creation code ‖ abi.encode(params))`.
The private withdrawal's `withdrawalRecipient` is this address; the vault's `release()` is a plain
ETH call (or an ERC-20 transfer), which succeeds whether or not the escrow is deployed yet. Anyone —
normally a relayer — may then `deployAndExecute`. The user's permanent address never appears, no
reused key signs anything, and the user pays no gas on-chain (the committed `executorTip` pays the relayer).
```
OrderParams {
  bytes32 orderId;            uint8   assetType (0 ETH, 1 ERC-20);   address asset;
  uint256 amount;             // expected funding
  address orderSigner;        // ONE-TIME key derived per order by the wallet; authorizes the provider call
  uint64  executeDeadline;    // latest time an execution may be authorized (>= every quote expiry used)
  uint64  refundAfter;        // >= executeDeadline (+ the provider's refund window)
  address refundVault;        // our canonical vault for the asset
  uint256 refundOwnerCommitment;  uint256 refundNoteSecret;  bytes32 refundNoteDataHash;   // the fresh note
  uint256 executorTip;        // paid to whoever executes or refunds; MUST be ≤ 1% of amount
}
Execution {                    // what the relayer submits; authored only by orderSigner
  address provider; uint256 value; bytes providerCalldata; uint64 deadline;   // deadline <= executeDeadline
  bytes signature;             // secp256k1 over keccak256(abi.encode(EXECUTE_TAG, chainId, escrow, orderId,
}                              //            provider, value, keccak256(providerCalldata), deadline)); low-s only
```
The provider call is **not** part of the CREATE2 commitment. That is deliberate: aggregator calldata
embeds the sender (refund/receiver), which is the escrow itself, so the address must be known before
the quote; and a funded order can be re-signed for a fallback provider when the first halts (plan §57)
without any on-chain change. A relayer cannot alter provider, value, calldata (hence the limit and
destination inside it) or deadline: any change invalidates the signature. The order key is derived
from the wallet's master secret per order and never reused, so signatures do not link orders.

`SwapOrderFactory.predict(params)` and the TypeScript engine (`endpoints.ts`) MUST compute the same
address (tested against a forge-emitted vector). The factory has no owner and no setters.

**Destinations**: BTC / SOL / EVM destination addresses are fresh per order, derived by the wallet's
Chain Key Abstraction (plan §45) from the master secret; the permanent public address is never the
default destination.

**Plain-address ingress** (Chainflip deposit channels, LI.FI smart deposit addresses, 1Click deposit
addresses, THORChain for non-EVM source chains) MAY be used directly as the withdrawal recipient only
when no refund-to-pool path is required; the default is the escrow so that §7 always holds. An escrow
pays a plain address by an *internal* transaction — for an ETH order a bare value transfer of
`amount − executorTip`; for an ERC-20 order a call to the **token contract itself**,
`transfer(depositAddress, amount − executorTip)`, which is the provider call the order key signs (the
engine's `escrowCall`; executed on the escrow by `test_ERC20Order_PlainDepositAddress_PaidWithTokenTransfer`); a provider MUST have confirmed that its deposit
watcher credits contract-sent deposits before such a route is executable (`Capabilities.contractSender`),
otherwise the route is quoted for information and filtered from selection.

## 7. Failure and refund handling (plan §33–§34, §57–§58)
- `execute()` reverts if the provider call fails; the order stays funded and refundable.
- After `refundAfter`, anyone may call `refund(noteData)` with the payload whose keccak equals
  `refundNoteDataHash`; the escrow pays the tip and **re-shields the whole remaining balance** by
  calling `vault.deposit` (ETH: `deposit{value}(oc, secret, noteData)`; ERC-20: `approve` + `deposit`).
  The funds return to private state as the pre-committed note with no user action; the wallet already
  holds the note's secret and can spend it. The payload is the order's random one, not a §12 envelope,
  so discovery cannot open it: the wallet finds each insert carrying a journaled payload and accepts it
  as a note only if its commitment recomputes from the vault's `Deposited` amount, the wallet's owner
  commitment and the refund secret (PP-S09). `refund()` re-shields whatever arrives, so an order may
  have more than one refund note. The payload derives from the seed and the note counter (a version
  byte, then a keyed stream), so a wallet restored from its phrase alone, without the journal,
  regenerates the payloads of its counters and finds its refunds too.
- Provider-level refunds (THORChain refund memo, Chainflip refund address) MUST point at the escrow
  address, so a provider refund lands where `refund()` can re-shield it. A THORChain memo without a
  refund address refunds to the transaction's originator, which for an escrow deposit is the relayer
  that sent `execute()`; the memo is therefore `=:ASSET:DEST/ESCROW:LIMIT`. A provider may refund a
  native deposit in its wrapped form: Across pays an unfilled deposit back to its depositor in the input
  token, which for ETH is WETH. An ETH order's escrow therefore unwraps any balance of the chain's
  wrapped native token (`SwapOrderFactory.WRAPPED_NATIVE`, read by each escrow at construction) at the
  start of `refund()`, so that value re-shields as ETH too; a wrapped token that misbehaves is skipped,
  never allowed to block the ETH. Provider refunds arrive with a gas stipend (THORChain's router: `send`,
  2300; Chainflip's Vault: 8,000; WETH9's `withdraw`: 2300), so the escrow's `receive()` MUST stay empty.
  A route MUST NOT be able to pay back to the escrow, on the source chain, anything `refund()` cannot
  re-shield: the order's asset, and for an ETH order the wrapped native token. A route that swaps first
  and bridges the result pays an unfilled deposit back in the swapped token (Across refunds the deposit's
  input token to its depositor), and LI.FI's Mayan facet sweeps its swap surplus in it; such a route is
  refused unless that token re-shields: the order's asset or, for ETH, WETH (through `refund()`); for
  an order in a token, WETH or ETH, which `refundToken` re-shields as ETH into the pool's native vault
  (it unwraps the WETH; `refundToken(address(0))` moves ETH that lands at such an escrow, which
  `refund()` never touches); or a token the pool has a vault for, which `refundToken(token, noteData)`
  re-shields into that token's canonical vault in the same pool as the committed refund vault (the
  escrow reaches the pool's permissionless vault factory through that vault, so no factory parameter
  can redirect it). Each lands as a note with the pre-committed owner and secret (PP-S08: LI.FI routed
  ETH → USDC on Base through USDT). The check runs at quote time, so the engine never ranks such a
  route, and the accepted route's foreign asset is handed to the executor (`refundTokens`; `address(0)`
  stands for the escrow's ETH). Token calls accept a token that returns nothing
  (USDT; PP-S10: typed calls expecting a bool made such an order unable to execute or refund).
- A provider can pay back after `refundAfter`: Across sets the fill deadline 2 h after the quote and
  refunds an unfilled deposit with the next settlement bundle. The executor therefore watches an
  executed order for `LATE_REFUND_WATCH_SECONDS` (24 h) past the window and re-shields whatever arrives;
  only an escrow still empty when the watch ends is reported completed (PP-S11). After execution no tip
  pays for a re-shield, and anyone can send value to an escrow, so the executor bounds them (PP-S12): at
  most `MAX_UNPAID_REFUNDS` (3) per order, each moving at least its floor (ETH and WETH: twice its gas;
  the order's own token: 1% of the order; a listed token: the floor the wallet states, `refundFloors`,
  1% of the least the route bridges in it, 0.1% for LI.FI's Mayan surplus sweep), and a token only into
  a vault its pool already has. What it leaves stays re-shieldable by anyone.
  Where a provider can only
  refund at the destination (Mayan Fast-MCTP: unfulfilled orders pay USDC to `destAddr`; a Mayan SWIFT
  order instead refunds its trader, the escrow, after cancellation: ETH for an ETH order), the quote
  MUST say so (`refundTarget: "destination"`); the destination is the user's fresh address, so nothing
  is lost, but the wallet MUST show that a failure ends in USDC on the destination chain, not in the pool.
- Partial delivery (§3 PARTIAL) is reported, never silently accepted; the remainder in escrow is
  refundable after `refundAfter`.
- A funded order the wallet will not execute — it refused the provider call (§2), the user did not
  accept a lower minimum, or simply changed their mind — MUST still come back: the wallet hands an
  executor a refund-only job (`POST /swap/refund`: factory, params, refund payload; no execution, nothing
  signed), which calls `deployAndRefund` once `refundAfter` is reached. `refund()` is permissionless,
  but only the wallet knows the params and the payload, so without such a job nobody would call it.
  A signed execution handed over later still replaces a refund-only job while it is open.

## 8. Privacy budget (plan §29–§31)
- **Delay**: the wallet schedules SOURCE_SUBMITTED uniformly at random within the policy's
  `[min, max]` after COMMIT (the study found uniform-like delays beat immediate/exponential ones):
  `best-privacy` `[6 h, 72 h]`, `best-price` `[1 h, 24 h]`, `fastest` `[0, 0]` (`engine.ts::DELAY_BUDGET`;
  V2 §4 adds `balanced` and `privacy-execution` at `[1 h, 24 h]`). `executeDeadline` MUST be re-quoted
  if the scheduled time passes the quote's expiry.
- **Amount normalization**: the withdrawn amount SHOULD be a bucket (`packages/protocol/src/wallet/amounts.ts`)
  with the odd remainder kept private; the swap amount is then the bucket minus tip. This MUST stay
  within the user's minimum-output requirement (re-quote the bucketed amount).
- The wallet MUST show the computed cross-chain privacy score (§10), never a flat "Private".
- The scheduled delay and bucketing protect the pool side (shield ↔ withdrawal), and that is where
  a swap's privacy comes from: the escrow ties withdrawal and ingress, and every adapter today also
  publishes the ingress → destination link (memo, event or calldata names the destination), which
  reaches only the privately funded one-time escrow (`docs/privacy-lab.md`, cross-chain section).

## 9. Route selection (plan §24–§25, §50)
```
score(route, policy) = Σ_k w_k(policy) · s_k,   s_k ∈ [0,100] for k ∈ {price, security, privacy, latency, liquidity, reliability}
best-privacy: w = {privacy .45, security .25, reliability .15, price .10, latency .05, liquidity 0}
best-price:   w = {price .45, security .20, reliability .15, privacy .10, latency .05, liquidity .05}
fastest:      w = {latency .40, reliability .25, security .15, price .10, privacy .10, liquidity 0}
```
`price` = toAmountMin relative to the best quote; `security` = static provider score adjusted by the
**incident feed** (plan §25: THORChain 2026-05-15 GG20/TSS exploit lowers its security score for a
decaying window); `latency` from eta; `liquidity` from the quote's liquidity fee (V2 §4: from the
provider's own impact figure where it states one); `reliability` from health (reachable, halted, API
latency; V2 §16 adds the failure history, the order's chains and a circuit breaker). Routes with
`health.halted`, an unreachable provider, expired quotes, an unconfirmed contract-sent ingress, or
`minOutEncoded: false` / `minOutVerified: false` under a strict policy are filtered before scoring.
**The best price MUST NOT win automatically** (§24).

## 10. Cross-chain privacy score (plan §51)
Eight factors, each a penalty in [0, 1]; `score = round(100 · Π_k (1 − p_k · w_k))` with weights
```
sourceIdentity .20   destinationIdentity .20   amountCorrelation .15   timingCorrelation .15
providerVisibility .10   bridgeVisibility .08   addressReuse .07   mempoolVisibility .05
```
- sourceIdentity: 0 if the source is the pool (escrow) and 1 if a public wallet address;
- destinationIdentity: 0 for a fresh wallet-derived address, 1 for a reused/public one;
- amountCorrelation: 0 if the amount is a bucket, else proportional to its uniqueness (the lab's
  amount-collapse model); timingCorrelation: 0 for a uniform delay ≥ 6 h, 1 for immediate;
- providerVisibility: what the provider learns (deposit-address flows 0.3, signed intents 0.6);
- bridgeVisibility: 0 for native-asset routes, 1 for wrapped/bridged legs;
- addressReuse: 0 for one-time endpoints; mempoolVisibility: 0 for private submission.
- **cross-chain term** (lab-calibrated, `privacyScore.ts::crossChainEffectiveSet`): only for a
  provider that keeps the escrow → destination link private (`Capabilities.destinationLinkPublic =
  false`; no adapter today), the amount and timing penalties are MULTIPLIED by
  `1 − log2(eff) / 4`, where `eff = 1 + k · candidates`, `candidates = throughput/h · ETA · e^{5σ} /
  3600`, `k = 0.02` for bucketed and `0.0006` for arbitrary amounts (fit of
  `benchmarks/privacy/crosschain.json`); a 16-strong effective set hides the arrival completely. Both
  links must hold for an observer, so the leg can only add privacy; with a public link (every adapter
  today) it adds none and takes none. Orders carry `privacy.destinationLinkPublic`; quote sets carry
  the per-provider link and where it is published.
The same function runs in the engine and the wallet; the privacy lab's constants calibrate it.

## 11. Solidity-side interface
**`PrivacyCore`: unchanged.** The exit is `transact(mode = WITHDRAW, withdrawalRecipient = escrow)`.
No core code, ABI or invariant changes; `contracts/abi/SHA256SUMS` stays valid.

`contracts/src/periphery/swap/SwapOrderEscrow.sol` (immutable params; `executionDigest`,
`execute(Execution, tipRecipient)`, `refund(noteData, tipRecipient)`; events
`Executed(provider, value, calldataHash, executor)`, `Refunded(vault, amount, executor)`) and
`SwapOrderFactory.sol` (`initCodeHash`, `predict`, `deploy`, `deployAndExecute`, `deployAndRefund`;
event `OrderEscrowDeployed(orderId, escrow)`). Errors: `TipTooLarge`, `BadDeadlines`, `ZeroSigner`,
`NotFunded`, `DeadlinePassed`, `DeadlineTooLate`, `TooEarlyToRefund`, `BadSignature`, `ValueTooLarge`,
`NoteDataMismatch`, `AlreadyExecuted`, `ProviderCallFailed`, `NothingToRefund`, `TipTransferFailed`.
Executed test matrix (`contracts/test/periphery/SwapOrderEscrow.t.sol`, 32 tests, the first 18 listed): funding before
deployment, predict == deploy, happy execution, **re-route to a fallback provider**, expiry →
refund-to-pool → re-spend, provider revert, provider refund → re-shield, forged signature, tampered
calldata / provider / value, deadline above the committed cap, replay on another escrow, tampered
refund payload, double execute, unfunded escrow, bad params, ERC-20 order, **provider compromise**
(a malicious provider can take only the escrow balance; core balance 0; all vault accounting
unchanged; no re-entry), off-chain digest == on-chain digest; plus the no-privilege bytecode scan.

**Real-proof end to end** (`contracts/test/e2e/RealProofE2E.t.sol`, the production circuit and
verifier, fixtures from the wallet reference): `test_E2E_PrivateNoteExitsToSwapOrder_RealProof` — a
shielded note is withdrawn to the predicted escrow with a Groth16 proof, the relayer deploys + executes
the order-key-signed provider call, the core's balance stays 0 and the vault's accounting is untouched;
`test_E2E_SwapOrderRefund_ReShieldsAndIsSpendableWithRealProof` — the same order's refund branch
re-shields exactly the pre-committed note (the on-chain root equals the wallet's) and a second real proof
spends it. The wallet side predicts the escrow with the CREATE2 formula over `abi.encode(OrderParams)`
(`packages/protocol/src/genE2EInputs.ts`), i.e. the integration point with `PrivacyCore` is nothing
but a withdrawal recipient.

## 12. Out of scope here
Provider execution with real funds; mobile shells. The wallet screens, the value tiers, the execution
plans and the zkAPI-authorized quote gateway (plan §52, §65: a service that sits in front of the same
adapters) are specified by `docs/whale-execution-spec-v1.0.md`.
