// The swap calls of the wallet over the API (V6 Stage 9: apps/api, spec v2.0 §15; was the local PrivateSwap service). The
// API quotes providers and prepares orders; keys stay in this wallet: it only ever sees the one-time order SIGNER address
// and the refund note's commitment/secret, and receives the signature we produce. An order is an operation with an opaque
// `op_` id from its commit on (journaled as StoredSwap.operationId); the order id never appears in a URL.
// V2 (whale spec §1–§3, §13, §19): the request may carry the wallet's tier (a hint that can only raise the API's tier)
// and its preference instead of a policy; quotes carry their execution plan, the provider's impact figure and the
// competition record; prepare keeps the approved minimum; track reads the destination side of an executed order.
import type { Address, Hex } from "viem";
import { fmtUnits } from "./format";
import { api, apiUrl, ApiError, ApiMinimumMoved, type ApiQuote, type ReconcileView } from "./api/client";

/** The API's base URL (the configuration's `swapService`, V6 Stage 3). */
export const swapServiceUrl = (): string => apiUrl();

export type Policy = "best-privacy" | "best-price" | "fastest" | "balanced" | "privacy-execution" | "best-execution" | "high-privacy";
export type Preference = "balanced" | "best-privacy" | "best-price" | "fastest" | "native";
export type Tier = "standard" | "large" | "large-protected" | "enhanced" | "high-value" | "high-value-secondary" | "institutional"; // V5 (spec §11): the two consumer bands below enhanced
export interface AssetRef { chain: string; asset: string; decimals: number; symbol: string }
export interface SwapRequest {
  from: AssetRef; to: AssetRef; amount: string; destination: string; slippageBps: number;
  /** an explicit policy (V1.1), or the preference the service derives it from with the tier */
  policy?: Policy; preference?: Preference; tier?: Tier; destinationKind?: "fresh" | "entered"; preferNative?: boolean;
  /** V3 (High-Value Protection spec §3, §14): the protection mode the recommendation is computed under, and a tranche's short execution window */
  mode?: "balanced" | "max-privacy" | "max-safety" | "best-execution"; executeWindowSeconds?: number;
  /** V6 Stage 12 (spec v2.0 §11.2, §12): a same-chain swap into the protected balance — `destination` is this wallet's shield receiver */
  destinationType?: "protected";
}

export interface ExecutionPlan { mode: "single" | "streaming" | "dca" | "auction" | "intent"; parts: number; intervalBlocks: number; expectedSeconds: number }
export interface RouteScore { provider: string; total: number; filtered?: string; components: { price: number; security: number; privacy: number; latency: number; liquidity: number; reliability: number } }
export interface ServiceFee { kind: string; /** base units of `asset` in the unit `decimals` gives */ amount: string; asset: string; decimals?: number; usd?: number }
export interface ServiceQuote { provider: string; category: string; toAmount: string; toAmountMin: string; /** V6 Stage 12: a protected destination's shield tip, in the output's base units */ shieldTip?: string; fees?: ServiceFee[]; etaSeconds: number; expiresAt: number; nativeAssets: boolean; minOutEncoded: boolean; minOutVerified?: boolean; refundTarget?: string; hops: string[]; plan?: ExecutionPlan; impactBps?: number; sizeSignals?: string[] }
/** V4 (contract §3.2): the quote in the common shape, on a quoted or filtered competition line. */
export interface NormalizedQuote { provider: string; netAmountOut: string; grossAmountOut: string; providerFee: string | null; networkFee: string | null; estimatedGas: string | null; estimatedDuration: number; routeRisk: { class: string; flags: string[]; exposureTier: "R0" | "R1" | "R2" | "R3" | "R4"; security: number; reliability: number }; privacyRisk: { score: number; linkPublic: boolean } }
export interface CompetitionEntry { provider: string; outcome: "quoted" | "refused" | "timeout" | "halted" | "filtered" | "skipped"; reason?: string; ms: number; plan?: ExecutionPlan; normalized?: NormalizedQuote }
export type ServiceValuation = { usd: number; at: number; source: string } | { unavailable: true; reason: string };
/** V3 (High-Value Protection spec §10): the service's recommendation for the chosen route — advice; the wallet keeps its own bounds and accounting (packages/swap-engine/src/risk/protection.ts). */
export interface Protection {
  provider: string; riskClass: string; flags: string[]; custody: string; bandBps: [number, number]; capBps: number; sizing: "bucket" | "varied";
  concurrency: "sequential" | "parallel"; maxParallel: number; gate: "source" | "destination-submitted" | "destination-final"; cadenceSeconds: [number, number];
  providerShareCapBps: number; executeWindowSeconds: number; estimatedTranches: number; estimatedSeconds: number;
  trancheUsd: [number, number] | null; capUsd: number | null; trancheImpactBps: number | null; thinMarket: boolean; maxPieceUnits: string | null;
  concentration: { providers: { id: string; shareBps: number }[]; singleVenue: boolean; capBps: number };
  elpf: { prior: number; pFailure: number; perTrancheUsd: number | null; perCampaignUsd: number | null };
  staged: boolean; reasons: string[];
  /** V4 (contract §2.2–§2.3, §3.4); optional for a service older than V4 */
  exposureTier?: "R0" | "R1" | "R2" | "R3" | "R4"; exposureReasons?: string[];
  impactRemedy?: "none" | "reduce-tranche" | "rfq" | "streaming" | "other-venue";
  ledgerPreview?: { totalOrderValue: string; maxExternalExposure: string; firstTranche: string };
}
export interface ServiceIncident { provider: string; date: string; title: string; lossUsd: number; class: string; halfLifeDays: number; source: string }
export interface ProviderRiskView { model: { class: string; flags: string[]; custody: string; gate: string; pFailPrior: number; bandBps: [number, number] }; security: { total: number; baseline: number; incidents: number; incidentList: ServiceIncident[] }; incidents: ServiceIncident[]; reliability: number | null }
/** GET /risk/:provider: the breakdown, the breaker's state and the record — stateless, nothing per user. */
export interface RiskView { provider: string; model: ProviderRiskView["model"]; security: ProviderRiskView["security"]; breaker: { open: string | null; failures: { consecutive: number; windowCount: number }; stalls: number; divergences: number; probe: boolean; lastIncidentAt: number | null }; record: Record<string, unknown> | null; routes: unknown[] }
export interface QuoteSet {
  quotes: ServiceQuote[]; scores: RouteScore[]; errors: Record<string, string>; chosen?: RouteScore;
  /** per provider: is the escrow -> destination link public, and where (spec §10) */
  links?: Record<string, { public: boolean; evidence: string }>;
  /** whale spec §1–§2: the service's valuation and tier, the policy it scored under, and what every provider answered */
  value?: ServiceValuation; tier?: Tier; policy?: Policy; competition?: CompetitionEntry[];
  /** V3: the recommendation and the risk view per provider, from the enhanced tier */
  protection?: Protection; risk?: Record<string, ProviderRiskView>;
  /** V6 (spec v2.0 §3): the executor tip every quote is net of — the execution's gas, in the input's base units */
  executorTip?: string;
  /** V6 Stage 12 (spec v2.0 §11.2): a protected destination's shield tip — the receiver's gas, in the OUTPUT's base units */
  shieldTip?: string;
  /** V6 (spec v2.0 §15): the API's quote id and the chosen route as the §46 quote (indicative: the wallet computes its own fees) */
  id?: string;
  quote?: ApiQuote;
}
/** The on-chain OrderParams (SwapOrderTypes.OrderParams) as the service serialises them (bigints as strings). */
export interface ServiceOrderParams { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface ServiceOrder { orderId: Hex; endpoint: Address; state: string; quote: ServiceQuote; params: ServiceOrderParams; privacy: { delaySeconds: [number, number]; score: number }; tier?: Tier; value?: ServiceValuation; plan?: ExecutionPlan; policy?: Policy }
export interface Prepared { digest: Hex; provider: Address; value: string; calldata: Hex; deadline: number; plan?: ExecutionPlan }
export interface ServiceExecution { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
export interface ServiceHealth { deployment: { chainId: string | number; factory: Address; nativeVault: Address; /** the address its vouches are signed with (a V6 follow-up of 2026-10-16); null: it vouches for nothing */ voucher?: Address | null }; providers: Record<string, { reachable: boolean; halted: boolean; note?: string }> }
/** Everything the service needs to rebuild an order it forgot (the wallet keeps it in its encrypted journal). */
export interface ResumeRequest { request: Omit<SwapRequest, "policy" | "preference" | "tier">; policy: Policy; provider: string; params: ServiceOrderParams; tier?: Tier; preference?: Preference }
export interface TrackResult { track: { state: string; destinationTxHash?: string; deliveredAmount?: string; deliveredAsset?: string; refundedAmount?: string; progress?: { parts: number; done: number } }; status: string }

/** The hard quote guarantees less than the user approved at commit (whale spec §3, §14): the user is asked again. */
export const ServiceMinimumMoved = ApiMinimumMoved;
export type ServiceMinimumMoved = ApiMinimumMoved;

/** A commit's answer: the operation's id with the order. */
/** `vouch.order`: the API's vouch for this order (a V6 follow-up of 2026-10-16, audit gap 47), journaled with it: the relayer refunds only a vouched order, and the API vouches for its call only on seeing it */
export interface Committed { operationId: string; order: ServiceOrder; scores: RouteScore[]; status: string; tier?: Tier; value?: ServiceValuation; policy?: Policy; competition?: CompetitionEntry[]; protection?: Protection; risk?: Record<string, ProviderRiskView>; vouch?: { order: string; shield?: string } }
/** A resume's answer: the order rebuilt from the journaled params into its operation. */
export interface Resumed { operationId: string; order: ServiceOrder; status: string; tier?: Tier }

/** What the API rebuilds an order from: the request, the policy, the provider and the on-chain params. */
const resumeBody = (req: ResumeRequest) => ({ ...req.request, policy: req.policy, provider: req.provider, params: req.params, ...(req.tier ? { tier: req.tier } : {}), ...(req.preference ? { preference: req.preference } : {}) });

/** `operation`: the order's operation, named when the wallet suspects a stalled settlement — the API times it itself */
const trackQuery = (ref: { tx?: string; ref?: string; operation?: string }) =>
  new URLSearchParams({ ...(ref.tx ? { tx: ref.tx } : {}), ...(ref.ref ? { ref: ref.ref } : {}), ...(ref.operation ? { operation: ref.operation } : {}) });

export const swapService = {
  health: () => api.status<ServiceHealth>(),
  /** `signal`: the Swap screen cancels a quote the user has typed past (V6 Stage 16) */
  quote: (req: SwapRequest, signal?: AbortSignal) => api.quotes<QuoteSet>(req, signal),
  /** commit: POST /v1/operations — the answer names the operation (`op_` id) the wallet journals with the order */
  order: (req: SwapRequest & { provider?: string; orderSigner: string; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: string; shield?: unknown }) =>
    api.createOperation<Committed>(req),
  /** rebuild an order from the journaled params: into its known operation, else (unknown, or none yet) found by its order or created */
  async resume(req: ResumeRequest, operationId?: string): Promise<Resumed> {
    const body = resumeBody(req);
    if (operationId) {
      try {
        return await api.resume<Resumed>(operationId, body);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    return api.createOperation<Resumed>(body);
  },
  /** `approvedMin`: the minimum the user approved at commit (destination base units); a hard quote below it answers 409 →
   *  ServiceMinimumMoved; `restore`: the journaled params, sent when the API holds no destination (a finalized order signed again) */
  prepare: (operationId: string, approvedMin?: bigint, restore?: ResumeRequest) =>
    api.prepare<Prepared>(operationId, { ...(approvedMin !== undefined ? { approvedMin: approvedMin.toString() } : {}), ...(restore ? { restore: resumeBody(restore) } : {}) }),
  /** `orderVouch`: the order's vouch from its commit; the answer's `vouch.execution` is the API's for the call, which the relayer asks for */
  finalize: (operationId: string, signature: string, orderVouch?: string) =>
    api.finalize<{ execution: ServiceExecution; order: ServiceOrder; vouch?: { execution: string } }>(operationId, signature, orderVouch),
  /** the API's own reads of an operation (relayer job, escrow, provider): a second source; the wallet's own reads win */
  reconcile: (operationId: string): Promise<ReconcileView> => api.reconcile(operationId),
  /** the destination side of an executed order, by the execution transaction (NEAR Intents: the deposit address as ref);
   *  `since` (unix s, the hand-over) and `expected` (the plan's seconds) let the API count a settlement stall (V3 §10) */
  track: (provider: string, ref: { tx?: string; ref?: string; operation?: string }) => api.track<TrackResult & { stalled?: boolean }>(provider, trackQuery(ref)),
  /** V3 (High-Value Protection spec §10): a provider's risk view — its record, the security breakdown, the breaker's state */
  risk: (provider: string) => api.risk<RiskView>(provider),
};

/**
 * Fee total of a quote for display (whale spec §2, §23): USD when every fee carries it; otherwise each non-zero fee in
 * its own asset, formatted by the unit the adapter stated; a fee whose unit is unknown is "n/a", never a base-unit figure.
 */
export function feeSummary(q: ServiceQuote): string {
  const fees = q.fees ?? [];
  if (!fees.length) return "included in the rate";
  if (fees.every((f) => typeof f.usd === "number")) return `$${fees.reduce((s, f) => s + (f.usd ?? 0), 0).toFixed(2)}`;
  const nonZero = fees.filter((f) => { try { return BigInt(f.amount) > 0n; } catch { return true; } });
  if (nonZero.some((f) => typeof f.decimals !== "number")) return "n/a";
  if (!nonZero.length) return "included in the rate";
  return nonZero.map((f) => `${fmtUnits(f.amount, f.decimals as number, 8)} ${f.asset}`).join(" + ");
}

/** The plan in the user's words (whale spec §23): never the provider's vocabulary. */
export function planLabel(p: ExecutionPlan | undefined): string {
  if (!p || p.mode === "single") return "one swap";
  const mins = Math.round(p.expectedSeconds / 60);
  if (p.mode === "streaming" || p.mode === "dca") return `${p.parts} parts over about ${mins >= 90 ? `${(mins / 60).toFixed(1)} hours` : `${mins} minutes`}`;
  if (p.mode === "auction") return "a solver auction";
  return "a solver intent";
}
