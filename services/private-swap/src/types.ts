// PrivateSwap engine types — docs/private-swap-spec-v1.1.md §2–§4, §9–§10; V2: docs/whale-execution-spec-v1.0.md §1–§2, §5.
import type { Tier, Valuation } from "../../../reference/typescript/src/wallet/valuation";
export type { Tier, Valuation };

export type Chain = "ethereum" | "bitcoin" | "solana" | "base" | "arbitrum" | "bsc" | "avalanche" | "optimism" | "polygon" | "tron" | "litecoin" | "doge";
export type ProviderId = "thorchain" | "chainflip" | "mayan" | "near-intents" | "lifi" | "uniswap-across";
/** V1.1's three policies and the V2 pair (whale spec §4): `balanced` is the default; `privacy-execution` applies from the high-value tier. */
export type Policy = "best-privacy" | "best-price" | "fastest" | "balanced" | "privacy-execution";
export const POLICIES: readonly Policy[] = ["best-privacy", "best-price", "fastest", "balanced", "privacy-execution"];
export const isPolicy = (x: unknown): x is Policy => typeof x === "string" && (POLICIES as readonly string[]).includes(x);
/** The user's saved preference the policy is derived from (whale spec §4); never on chain. */
export type Preference = "balanced" | "best-privacy" | "best-price" | "fastest" | "native";
export const isPreference = (x: unknown): x is Preference => x === "balanced" || x === "best-privacy" || x === "best-price" || x === "fastest" || x === "native";
export type RouteCategory = "A" | "B" | "C" | "D" | "E"; // spec §4 / plan §32
export type IngressKind = "plain-address" | "contract-call";

/** How a provider executes an order (whale spec §2, §12): one swap, THORChain's stream, Chainflip's DCA, a solver auction or intent. */
export type PlanMode = "single" | "streaming" | "dca" | "auction" | "intent";
export interface ExecutionPlan { mode: PlanMode; parts: number; intervalBlocks: number; expectedSeconds: number }
export const SINGLE_PLAN = (expectedSeconds: number, mode: PlanMode = "single"): ExecutionPlan => ({ mode, parts: 1, intervalBlocks: 0, expectedSeconds });

export interface AssetRef {
  chain: Chain;
  /** EVM token address, "native" for the chain's native asset, or a provider-native symbol (BTC, SOL) */
  asset: string;
  decimals: number;
  symbol: string;
}

export interface QuoteRequest {
  from: AssetRef;
  to: AssetRef;
  amount: bigint; // in `from` base units
  /** the fresh destination address (spec §6); at phase 1 the engine substitutes a placeholder (whale spec §5) */
  destination: string;
  /** the one-time source endpoint when known (escrow address); providers that pull need it */
  source?: string;
  slippageBps: number;
  /** whale spec §12: ask the provider's streamed plan as well ("stream") or a single swap only ("single", the guest path) */
  plan?: "single" | "stream";
  /** whale spec §13: the order's value tier, for the adapters that quote by size */
  tier?: Tier;
  /** whale spec §4: filter wrapped / bridged routes when a native one quoted */
  preferNative?: boolean;
  /** whale spec §21: a fresh wallet-derived address (the default) or one the user entered */
  destinationKind?: "fresh" | "entered";
}

export interface Fee {
  kind: "network" | "liquidity" | "protocol" | "affiliate" | "gas";
  /** in base units of `asset`, the unit given by `decimals` */
  amount: bigint;
  /** the asset's symbol, for display */
  asset: string;
  /** the unit of `amount` (whale spec §2); absent only when the adapter cannot state it, and then a wallet shows no number rather than base units */
  decimals?: number;
  usd?: number;
}

export interface Quote {
  provider: ProviderId;
  category: RouteCategory;
  toAmount: bigint; // expected, in `to` base units
  toAmountMin: bigint; // the limit the ingress will carry (spec §5)
  fees: Fee[];
  etaSeconds: number;
  expiresAt: number; // unix seconds; the escrow's executeDeadline
  nativeAssets: boolean; // no wrapped legs (plan §15)
  minOutEncoded: boolean; // the provider ingress carries toAmountMin
  /** false when the adapter could NOT confirm the minimum output inside the calldata it will sign (the provider's claim only); filtered under strict policies (spec §5, §9) */
  minOutVerified?: boolean;
  /** where a provider-level refund lands: the escrow (re-shieldable) or the fresh destination address (spec §7) */
  refundTarget?: "escrow" | "destination";
  hops: string[];
  raw: unknown;
  obtainedAt: number;
  /** whale spec §2, §12: the plan this quote is for */
  plan?: ExecutionPlan;
  /** whale spec §2: the provider's own statement of the price impact / slippage of this size, in bps; absent when it states none */
  impactBps?: number;
  /** whale spec §2: provider-stated size limits in `from` base units, when it states any */
  limits?: { min?: bigint; max?: bigint; maxInstant?: bigint };
  /** whale spec §2: the provider's size warnings in words */
  sizeSignals?: string[];
}

export interface Ingress {
  kind: IngressKind;
  to: string; // router / deposit contract, or the plain deposit address
  calldata: `0x${string}`; // "0x" for plain-address ingress
  value: bigint; // native value to forward
  memo?: string;
  expiresAt: number;
  minOutEncoded: boolean;
  /** facts the adapter verified locally about provider-supplied calldata (spec §5); absent when the calldata was built locally */
  verified?: string[];
  /** tokens other than the order's asset this route may pay back to the escrow (a source swap's output): re-shielded through refundToken */
  refundTokens?: string[];
}

export type OrderState =
  | "QUOTED" | "COMMITTED" | "SOURCE_SUBMITTED" | "SOURCE_FINAL" | "PROVIDER_EXECUTING"
  | "DESTINATION_SUBMITTED" | "DESTINATION_FINAL" | "COMPLETED"
  | "EXPIRED" | "CANCELLED" | "SOURCE_FAILED" | "PROVIDER_TIMEOUT" | "PARTIAL" | "DESTINATION_FAILED"
  | "REFUND_PENDING" | "REFUNDED" | "FAILED";

export type UserStatus = "Pending" | "Executing" | "Completed" | "Partial" | "Refunding" | "Refunded" | "Failed";

export interface TrackStatus {
  state: "pending" | "executing" | "destination-submitted" | "destination-final" | "completed" | "partial" | "refunded" | "failed" | "unknown";
  destinationTxHash?: string;
  deliveredAmount?: bigint;
  deliveredAsset?: string;
  /** whale spec §12, §19: what a stream or a fill-or-kill paid back to the escrow (source units) */
  refundedAmount?: bigint;
  /** whale spec §12: a stream's progress */
  progress?: { parts: number; done: number };
  raw?: unknown;
}

export interface Health {
  provider: ProviderId;
  reachable: boolean;
  apiLatencyMs: number;
  halted: boolean; // provider-wide or for the queried chains
  haltedChains: string[];
  checkedAt: number;
  note?: string;
  /** whale spec §16: this service's recent quote failures and timeouts with the provider */
  failures?: { consecutive: number; lastAt?: number; windowCount: number };
}

export interface Capabilities {
  routes: RouteCategory[];
  ingress: IngressKind[];
  nativeAssets: boolean;
  atomic: false; // never claim atomicity (plan §33)
  chains: Chain[];
  /** false when the provider has not confirmed that an ingress sent BY A CONTRACT (our escrow) is credited; such routes are quoted but never chosen */
  contractSender?: boolean;
  /**
   * Whether the escrow → destination link is public: the ingress (memo, event, calldata) or the
   * provider's own outbound names the destination. Harmless by design — it reaches only the one-time
   * escrow, which a private withdrawal funded — but it means the provider's cover traffic hides
   * nothing on this leg (spec §10). True unless a provider is verified to keep the link private.
   */
  destinationLinkPublic: boolean;
  /** where the link is published (shown under "View route") */
  linkEvidence: string;
}

/** Provider adapter interface — spec §4; whale spec §5. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly implemented: boolean;
  capabilities(): Capabilities;
  quote(req: QuoteRequest): Promise<Quote>;
  prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress>;
  track(ref: { sourceTxHash?: string; providerRef?: string }): Promise<TrackStatus>;
  health(): Promise<Health>;
}

/** One line of the quote competition (whale spec §2): every capable provider, whatever it answered. */
export interface CompetitionEntry {
  provider: ProviderId;
  outcome: "quoted" | "refused" | "timeout" | "halted" | "filtered" | "skipped";
  reason?: string;
  ms: number;
  plan?: ExecutionPlan;
}

/** On-chain OrderParams (SwapOrderTypes.OrderParams), spec §6. */
export interface OrderParams {
  orderId: `0x${string}`;
  assetType: 0 | 1;
  asset: string;
  amount: bigint;
  orderSigner: string; // one-time key; authorizes the provider call off-chain
  executeDeadline: number;
  refundAfter: number;
  refundVault: string;
  refundOwnerCommitment: bigint;
  refundNoteSecret: bigint;
  refundNoteDataHash: `0x${string}`;
  executorTip: bigint;
}

/** What the relayer submits (SwapOrderTypes.Execution), authored only by the order key. */
export interface Execution {
  provider: string;
  value: bigint;
  providerCalldata: `0x${string}`;
  deadline: number;
  signature: `0x${string}`;
}

export interface Order {
  orderId: `0x${string}`;
  request: QuoteRequest;
  policy: Policy;
  /** whale spec §1: the preference the policy was derived from */
  preference?: Preference;
  quote: Quote;
  ingress: Ingress;
  params: OrderParams;
  endpoint: string; // predicted escrow address
  execution?: Execution; // signed once the wallet has the final ingress
  privacy: { delaySeconds: [number, number]; amountNormalized: boolean; score: number; destinationLinkPublic: boolean };
  /** whale spec §1, §13: the source amount's USD value at commit (or why there is none) and the value tier — recomputed by the service; the higher of the wallet's and the service's applies */
  value?: Valuation;
  tier?: Tier;
  /** whale spec §1, §21: the destination with its provenance */
  destination?: { chain: Chain; asset: string; address: string; kind: "fresh" | "entered" };
  /** whale spec §1, §12: the chosen quote's execution plan (refreshed at prepare) */
  plan?: ExecutionPlan;
  state: OrderState;
  history: { state: OrderState; at: number; note?: string }[];
}

export const CATEGORY_PREFERENCE: Record<RouteCategory, ProviderId[]> = {
  A: ["thorchain", "chainflip", "near-intents"],
  B: ["mayan", "near-intents", "lifi"],
  C: ["uniswap-across", "lifi"],
  D: ["mayan", "near-intents", "lifi"],
  E: ["thorchain", "chainflip", "near-intents", "lifi"],
};

const EVM: Chain[] = ["ethereum", "base", "arbitrum", "bsc", "avalanche", "optimism", "polygon"];
export const isEvm = (c: Chain) => EVM.includes(c);

/** Route category of a request (plan §32). */
export function categoryOf(from: AssetRef, to: AssetRef): RouteCategory {
  const nativeL1 = (a: AssetRef) => ["bitcoin", "litecoin", "doge"].includes(a.chain);
  if (from.chain === "bitcoin" && isEvm(to.chain)) return "E";
  if (isEvm(from.chain) && to.chain === "solana") return "B";
  if (from.chain === "solana" && isEvm(to.chain)) return "D";
  if (isEvm(from.chain) && isEvm(to.chain)) return "C";
  if (nativeL1(from) || nativeL1(to) || from.chain === "solana" || to.chain === "solana") return "A";
  return "A";
}
