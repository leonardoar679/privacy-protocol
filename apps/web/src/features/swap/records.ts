// The operation record of a swap order (spec §12): one record per order, keyed `swap:<orderId>`, its state read from
// the journaled order and the tracker's last derivation through the adapters, the refs and the reason with it. The
// engines keep their own states; the record follows them. V6 (spec v2.0 §12): a delay is `delayed` on the phase's state,
// the settlement comes from the tracker (kept when a read could not tell), and a terminal record keeps its state (I-O1).
import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import type { SwapJob } from "@privacy-wallet/sdk/relayer";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { isTerminal, type OperationRecord, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { fromStoredSwap } from "@privacy-wallet/sdk/operations/adapters";
import { reasonOf, recoveryFor } from "@privacy-wallet/sdk/operations/reducer";
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
  const terminal = !!prev && isTerminal(prev.state);
  const state: OperationState = terminal ? prev!.state : m.state; // I-O1: a terminal record stays
  const reason = terminal ? prev!.reason : m.code && !m.delayed ? reasonOf(m.code, "unknown", tracked?.detail) : undefined;
  const delayed = !terminal && m.delayed && m.code ? { since: prev?.delayed?.code === m.code ? prev.delayed.since : now, code: m.code } : undefined;
  const settlement = tracked?.settlement ?? prev?.settlement;
  let rec: OperationRecord = {
    v: 2, id, kind: crossChain ? "cross-chain" : "swap", state, phase: m.phase, createdAt: prev?.createdAt ?? stored.createdAt, updatedAt: Math.max(now, prev?.updatedAt ?? 0),
    amounts: { asset: req.from?.symbol ?? "", decimals: req.from?.decimals ?? 18, input: params.amount ?? "0", ...(stored.approvedMin ? { minimumOutput: stored.approvedMin } : {}), outputAsset: req.to?.symbol, outputDecimals: req.to?.decimals, ...(tracked?.deliveredAmount ? { delivered: tracked.deliveredAmount } : {}) },
    fees: prev?.fees ?? [],
    destination: { kind: stored.campaign ? "fresh" : (stored.request as { destinationKind?: string }).destinationKind === "entered" ? "entered" : "fresh", display: req.destination ?? "", chain: req.to?.chain ?? "ethereum" },
    refs: { ...(prev?.refs ?? { txHashes: [] }), txHashes, orderId: stored.orderId, ...(stored.jobId ? { jobId: stored.jobId } : {}), ...(stored.executionTx ? { executionTx: stored.executionTx } : {}), ...(stored.executionRef ? { executionRef: stored.executionRef } : {}), provider: stored.provider, ...(stored.campaign ? { campaignId: stored.campaign.id } : {}) },
    tier: asTier(stored.tier),
    ...(prev?.protectedExecution ? { protectedExecution: prev.protectedExecution } : {}),
    ...(prev?.costs ? { costs: prev.costs } : {}),
    ...(settlement ? { settlement } : {}),
    ...(reason ? { reason } : {}),
    ...(delayed ? { delayed } : {}),
    ...(prev?.recovery ? { recovery: prev.recovery } : {}),
    history: prev && prev.state === state ? prev.history : [...(prev?.history ?? []), { state, at: now, ...(tracked ? { note: tracked.label } : {}) }],
  };
  // the recovery follows where the money is (spec v2.0 §12.4); a delay is watched
  if (!terminal && state === "RECOVERY_REQUIRED" && reason) rec = { ...rec, recovery: recoveryFor(rec, reason.code, now) };
  else if (!terminal && delayed) rec = { ...rec, recovery: { ...(rec.recovery ?? {}), state: rec.recovery?.state ?? "monitoring", since: rec.recovery?.since ?? now, lastCheckedAt: now } };
  putOperation(rec);
  return rec;
}
