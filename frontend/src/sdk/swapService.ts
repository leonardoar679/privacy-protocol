// Client for the local PrivateSwap service (services/private-swap/src/server.ts). The service quotes
// providers and prepares orders; keys stay in this wallet: it only ever sees the one-time order
// SIGNER address and the refund note's commitment/secret, and receives the signature we produce.
import type { Address, Hex } from "viem";

export const SWAP_SERVICE = (import.meta as any).env?.VITE_SWAP_SERVICE ?? "http://127.0.0.1:8787";

export type Policy = "best-privacy" | "best-price" | "fastest";
export interface AssetRef { chain: string; asset: string; decimals: number; symbol: string }
export interface SwapRequest { from: AssetRef; to: AssetRef; amount: string; destination: string; slippageBps: number; policy: Policy }

export interface RouteScore { provider: string; total: number; filtered?: string; components: { price: number; security: number; privacy: number; latency: number; liquidity: number; reliability: number } }
export interface ServiceQuote { provider: string; category: string; toAmount: string; toAmountMin: string; etaSeconds: number; expiresAt: number; nativeAssets: boolean; minOutEncoded: boolean; minOutVerified?: boolean; refundTarget?: string; hops: string[] }
export interface QuoteSet { quotes: ServiceQuote[]; scores: RouteScore[]; errors: Record<string, string>; chosen?: RouteScore }
/** The on-chain OrderParams (SwapOrderTypes.OrderParams) as the service serialises them (bigints as strings). */
export interface ServiceOrderParams { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface ServiceOrder { orderId: Hex; endpoint: Address; state: string; quote: ServiceQuote; params: ServiceOrderParams; privacy: { delaySeconds: [number, number]; score: number } }
export interface Prepared { digest: Hex; provider: Address; value: string; calldata: Hex; deadline: number }
export interface ServiceExecution { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
export interface ServiceHealth { deployment: { chainId: string | number; factory: Address; nativeVault: Address }; providers: Record<string, { reachable: boolean; halted: boolean; note?: string }> }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(SWAP_SERVICE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `service error ${r.status}`);
  return j as T;
}

export const swapService = {
  health: () => call<ServiceHealth>("/health"),
  quote: (req: SwapRequest) => call<QuoteSet>("/quote", req),
  order: (req: SwapRequest & { provider?: string; orderSigner: string; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: string }) =>
    call<{ order: ServiceOrder; scores: RouteScore[]; status: string }>("/order", req),
  prepare: (orderId: string) => call<Prepared>("/prepare", { orderId }),
  finalize: (orderId: string, signature: string) => call<{ execution: ServiceExecution; order: ServiceOrder }>("/finalize", { orderId, signature }),
};
