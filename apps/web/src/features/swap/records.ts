// The operation record of a swap order (spec §12): one record per order, keyed `swap:<orderId>`, its state read from
// the journaled order and the tracker's last derivation through the adapters, the refs and the failure code with it.
// The engines keep their own states; the record follows them.
import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import type { SwapJob } from "@privacy-wallet/sdk/relayer";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { OperationRecord, OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { CATALOG } from "@privacy-wallet/sdk/operations/errors/catalog";
import { fromStoredSwap } from "@privacy-wallet/sdk/operations/adapters";
import { getOperation, putOperation } from "@privacy-wallet/sdk/operations/store";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";

export const swapRecordId = (orderId: string): string => `swap:${orderId.toLowerCase()}`;

const asTier = (x: unknown): Tier => (["standard", "large", "large-protected", "enhanced", "high-value", "high-value-secondary", "institutional"].includes(String(x)) ? (x as Tier) : "standard");

/** Bring the order's record in line with what the journal and the tracker say; returns the record. */
export function syncSwapRecord(stored: StoredSwap, tracked: Tracked | null, job: SwapJob | null, now = Date.now()): OperationRecord {
  const req = stored.request as { from?: { symbol?: string; decimals?: number; chain?: string }; to?: { symbol?: string; decimals?: number; chain?: string }; destination?: string };
  const params = stored.params as { amount?: string };
  const m = fromStoredSwap({ state: job?.state ?? stored.state, fundedTx: stored.fundedTx, jobId: stored.jobId, executionTx: stored.executionTx, campaign: stored.campaign }, tracked);
  const id = swapRecordId(stored.orderId);
  const prev = getOperation(id);
  const crossChain = (req.to?.chain ?? "ethereum") !== (req.from?.chain ?? "ethereum");
  const txHashes = [...new Set([...(prev?.refs.txHashes ?? []), ...(stored.fundedTx ? [stored.fundedTx] : []), ...(job?.txHash ? [job.txHash] : []), ...(tracked?.destinationTxHash ? [tracked.destinationTxHash] : [])])];
  const state: OperationState = prev && ["COMPLETED", "REFUNDED", "CANCELLED"].includes(prev.state) ? prev.state : m.state; // I-O1: a terminal record stays
  const failure = m.code ? { code: m.code, class: CATALOG[m.code]?.fundsClass ?? "unknown", ...(tracked?.detail ? { detail: tracked.detail } : {}) } : undefined;
  const rec: OperationRecord = {
    id, kind: crossChain ? "cross-chain" : "swap", state, phase: m.phase, createdAt: prev?.createdAt ?? stored.createdAt, updatedAt: Math.max(now, prev?.updatedAt ?? 0),
    amounts: { asset: req.from?.symbol ?? "", decimals: req.from?.decimals ?? 18, input: params.amount ?? "0", ...(stored.approvedMin ? { minimumOutput: stored.approvedMin } : {}), outputAsset: req.to?.symbol, outputDecimals: req.to?.decimals, ...(tracked?.deliveredAmount ? { delivered: tracked.deliveredAmount } : {}) },
    fees: prev?.fees ?? [],
    destination: { kind: stored.campaign ? "fresh" : (stored.request as { destinationKind?: string }).destinationKind === "entered" ? "entered" : "fresh", display: req.destination ?? "", chain: req.to?.chain ?? "ethereum" },
    refs: { ...(prev?.refs ?? { txHashes: [] }), txHashes, orderId: stored.orderId, ...(stored.jobId ? { jobId: stored.jobId } : {}), ...(stored.executionTx ? { executionTx: stored.executionTx } : {}), ...(stored.executionRef ? { executionRef: stored.executionRef } : {}), provider: stored.provider, ...(stored.campaign ? { campaignId: stored.campaign.id } : {}) },
    tier: asTier(stored.tier),
    ...(failure ? { failure } : {}),
    ...(prev?.recovery ? { recovery: prev.recovery } : state === "RECOVERY_REQUIRED" || state === "PROVIDER_FAILED" ? { recovery: { state: "refund-offered" as const, since: now, lastCheckedAt: now } } : state === "NETWORK_DELAYED" ? { recovery: { state: "monitoring" as const, since: now, lastCheckedAt: now } } : {}),
    history: prev && prev.state === state ? prev.history : [...(prev?.history ?? []), { state, at: now, ...(tracked ? { note: tracked.label } : {}) }],
  };
  putOperation(rec);
  return rec;
}
