// Client for the local PrivateSwap service (services/private-swap/src/server.ts). The service quotes
// providers and prepares orders; keys stay in this wallet: it only ever sees the one-time order
// SIGNER address and the refund note's commitment/secret, and receives the signature we produce.
// V2 (whale spec §1–§3, §13, §19): the request may carry the wallet's tier (a hint that can only raise
// the service's tier) and its preference instead of a policy; quotes carry their execution plan, the
// provider's impact figure and the competition record; /prepare keeps the approved minimum; /track
// reads the destination side of an executed order.
import type { Address, Hex } from "viem";
import { fmtUnits } from "./format";

export const SWAP_SERVICE = (import.meta as any).env?.VITE_SWAP_SERVICE ?? "http://127.0.0.1:8787";

export type Policy = "best-privacy" | "best-price" | "fastest" | "balanced" | "privacy-execution";
export type Preference = "balanced" | "best-privacy" | "best-price" | "fastest" | "native";
export type Tier = "standard" | "enhanced" | "high-value" | "high-value-secondary" | "institutional";
export interface AssetRef { chain: string; asset: string; decimals: number; symbol: string }
export interface SwapRequest {
  from: AssetRef; to: AssetRef; amount: string; destination: string; slippageBps: number;
  /** an explicit policy (V1.1), or the preference the service derives it from with the tier */
  policy?: Policy; preference?: Preference; tier?: Tier; destinationKind?: "fresh" | "entered"; preferNative?: boolean;
}

export interface ExecutionPlan { mode: "single" | "streaming" | "dca" | "auction" | "intent"; parts: number; intervalBlocks: number; expectedSeconds: number }
export interface RouteScore { provider: string; total: number; filtered?: string; components: { price: number; security: number; privacy: number; latency: number; liquidity: number; reliability: number } }
export interface ServiceFee { kind: string; /** base units of `asset` in the unit `decimals` gives */ amount: string; asset: string; decimals?: number; usd?: number }
export interface ServiceQuote { provider: string; category: string; toAmount: string; toAmountMin: string; fees?: ServiceFee[]; etaSeconds: number; expiresAt: number; nativeAssets: boolean; minOutEncoded: boolean; minOutVerified?: boolean; refundTarget?: string; hops: string[]; plan?: ExecutionPlan; impactBps?: number; sizeSignals?: string[] }
export interface CompetitionEntry { provider: string; outcome: "quoted" | "refused" | "timeout" | "halted" | "filtered" | "skipped"; reason?: string; ms: number; plan?: ExecutionPlan }
export type ServiceValuation = { usd: number; at: number; source: string } | { unavailable: true; reason: string };
export interface QuoteSet {
  quotes: ServiceQuote[]; scores: RouteScore[]; errors: Record<string, string>; chosen?: RouteScore;
  /** per provider: is the escrow -> destination link public, and where (spec §10) */
  links?: Record<string, { public: boolean; evidence: string }>;
  /** whale spec §1–§2: the service's valuation and tier, the policy it scored under, and what every provider answered */
  value?: ServiceValuation; tier?: Tier; policy?: Policy; competition?: CompetitionEntry[];
}
/** The on-chain OrderParams (SwapOrderTypes.OrderParams) as the service serialises them (bigints as strings). */
export interface ServiceOrderParams { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface ServiceOrder { orderId: Hex; endpoint: Address; state: string; quote: ServiceQuote; params: ServiceOrderParams; privacy: { delaySeconds: [number, number]; score: number }; tier?: Tier; value?: ServiceValuation; plan?: ExecutionPlan; policy?: Policy }
export interface Prepared { digest: Hex; provider: Address; value: string; calldata: Hex; deadline: number; plan?: ExecutionPlan }
export interface ServiceExecution { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
export interface ServiceHealth { deployment: { chainId: string | number; factory: Address; nativeVault: Address }; providers: Record<string, { reachable: boolean; halted: boolean; note?: string }> }
/** Everything the service needs to rebuild an order it forgot (the wallet keeps it in its encrypted journal). */
export interface ResumeRequest { request: Omit<SwapRequest, "policy" | "preference" | "tier">; policy: Policy; provider: string; params: ServiceOrderParams; tier?: Tier; preference?: Preference }
export interface TrackResult { track: { state: string; destinationTxHash?: string; deliveredAmount?: string; deliveredAsset?: string; refundedAmount?: string; progress?: { parts: number; done: number } }; status: string }

/** The hard quote guarantees less than the user approved at commit (whale spec §3, §14): the user is asked again. */
export class ServiceMinimumMoved extends Error {
  constructor(readonly approvedMin: bigint, readonly newMin: bigint) { super(`the route now guarantees at least ${newMin}, below the ${approvedMin} you approved`); }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(SWAP_SERVICE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) {
    if (r.status === 409 && j?.code === "minimum_moved") throw new ServiceMinimumMoved(BigInt(j.approvedMin), BigInt(j.newMin));
    throw new Error(j.error ?? `service error ${r.status}`);
  }
  return j as T;
}

export const swapService = {
  health: () => call<ServiceHealth>("/health"),
  quote: (req: SwapRequest) => call<QuoteSet>("/quote", req),
  order: (req: SwapRequest & { provider?: string; orderSigner: string; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: string }) =>
    call<{ order: ServiceOrder; scores: RouteScore[]; status: string; tier?: Tier; value?: ServiceValuation; policy?: Policy; competition?: CompetitionEntry[] }>("/order", req),
  resume: (req: ResumeRequest) => call<{ order: ServiceOrder; status: string; tier?: Tier }>("/order/resume", { ...req.request, policy: req.policy, provider: req.provider, params: req.params, ...(req.tier ? { tier: req.tier } : {}), ...(req.preference ? { preference: req.preference } : {}) }),
  /** `approvedMin`: the minimum the user approved at commit (destination base units); a hard quote below it answers 409 → ServiceMinimumMoved */
  prepare: (orderId: string, approvedMin?: bigint) => call<Prepared>("/prepare", { orderId, ...(approvedMin !== undefined ? { approvedMin: approvedMin.toString() } : {}) }),
  finalize: (orderId: string, signature: string) => call<{ execution: ServiceExecution; order: ServiceOrder }>("/finalize", { orderId, signature }),
  /** the destination side of an executed order, by the execution transaction (NEAR Intents: the deposit address as ref) */
  track: (provider: string, ref: { tx?: string; ref?: string }) => call<TrackResult>(`/track/${encodeURIComponent(provider)}?${new URLSearchParams({ ...(ref.tx ? { tx: ref.tx } : {}), ...(ref.ref ? { ref: ref.ref } : {}) })}`),
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
