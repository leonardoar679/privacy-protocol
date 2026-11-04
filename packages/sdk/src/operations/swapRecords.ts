// The operation record of a swap order (spec §12; V6 Stage 11: moved from apps/web so the order runner keeps it too): one record per order, keyed `swap:<orderId>`, its state read from
// the journaled order and the tracker's last derivation through the adapters, the refs and the reason with it. The
// engines keep their own states; the record follows them. V6 (spec v2.0 §12): a delay is `delayed` on the phase's state,
// the settlement comes from the tracker (kept when a read could not tell), and a terminal record keeps its state (I-O1).
import type { Tracked } from "../orderTracker";
import type { SwapJob } from "../relayer";
import type { StoredSwap } from "../wallet/journal";
import {
  isTerminal,
  PRE_SUBMISSION_STATES,
  SETTLEMENT_STATES,
  wasSubmitted,
  type OperationOutcome,
  type OperationRecord,
  type OperationState,
} from "../wallet/operationRecord";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { fromStoredSwap } from "./adapters";
import { reasonOf, recoveryFor } from "./reducer";
import { getOperation, putOperation } from "./store";
import { swapService } from "../swapService";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";

export const swapRecordId = (orderId: string): string => `swap:${orderId.toLowerCase()}`;

const asTier = (x: unknown): Tier =>
  ["standard", "large", "large-protected", "enhanced", "high-value", "high-value-secondary", "institutional"].includes(String(x)) ? (x as Tier) : "standard";

/**
 * Bring the order's record in line with what the journal and the tracker say; returns the record. `s`: the session of the caller — the
 * runners' pinned one (the ninth review round, 2026-11-04, C-08: the default session had been written to after a lock or a REPLACE).
 */
export function syncSwapRecord(
  stored: StoredSwap,
  tracked: Tracked | null,
  job: SwapJob | null,
  now = Date.now(),
  s: WalletSession = defaultSession,
): OperationRecord {
  const req = (stored.request ?? {}) as {
    from?: { symbol?: string; decimals?: number; chain?: string };
    to?: { symbol?: string; decimals?: number; chain?: string };
    destination?: string;
  };
  const params = stored.params as { amount?: string };
  const mapped = fromStoredSwap(
    {
      state: job?.state ?? stored.state,
      fundedTx: stored.fundedTx,
      fundedAt: stored.fundedAt,
      jobId: stored.jobId,
      handedOverAt: stored.handedOverAt,
      executionTx: stored.executionTx,
      campaign: stored.campaign,
      paused: stored.paused,
    },
    tracked,
  );
  // a partial fill whose rest is accounted for — the executor's watch ended, or its refund came back — is finished (the ninth review round,
  // 2026-11-04, C-03): it had stayed "needs attention" for good, its only action changing nothing; while the rest may still come back it waits
  const restBack = job?.state === "refunded" || (stored.refunds?.length ?? 0) > 0;
  const settledPartial = tracked?.state === "PARTIAL" && (job?.state === "completed" || restBack);
  const m = settledPartial ? { state: "COMPLETED" as const, phase: "settlement" as const } : mapped;
  // what such an order came to, beside its state (C-03, C-07: a refund the provider paid at the destination had read "Swap complete") — and
  // only what the record knows (the tenth review round, A10-2): "the rest came back" with a refund note found or a refunded job; a completed job
  // re-shielded nothing, so the rest did not come back; a delivery in another token (LI.FI's) is its own outcome, the round-7 rule for steps
  const otherToken = tracked?.state === "PARTIAL" && !!tracked.deliveredAsset;
  const outcome: OperationOutcome | undefined = settledPartial
    ? otherToken
      ? "other-token"
      : restBack
        ? "partial"
        : "partial-unreturned"
    : tracked?.state === "REFUNDED_AT_DESTINATION"
      ? "refunded-at-destination"
      : undefined;
  const id = swapRecordId(stored.orderId);
  const prev = getOperation(id, s);
  const crossChain = (req.to?.chain ?? "ethereum") !== (req.from?.chain ?? "ethereum");
  const txHashes = [
    ...new Set([
      ...(prev?.refs.txHashes ?? []),
      ...(stored.fundedTx ? [stored.fundedTx] : []),
      ...(job?.txHash ? [job.txHash] : []),
      ...(tracked?.destinationTxHash ? [tracked.destinationTxHash] : []),
    ]),
  ];
  const terminal = !!prev && isTerminal(prev.state);
  // I-O7 (the ninth review round, 2026-11-04, C-01): a record whose order was submitted never goes back before its submission — this
  // write bypasses the reducer, and a handed-over order read once as never funded had moved PROVIDER_EXECUTING → AWAITING_AUTHORIZATION
  const back = !!prev && !terminal && PRE_SUBMISSION_STATES.includes(m.state) && wasSubmitted(prev);
  const state: OperationState = terminal || back ? prev!.state : m.state; // I-O1: a terminal record stays
  const reason = terminal || back ? prev!.reason : m.code && !m.delayed ? reasonOf(m.code, "unknown", tracked?.detail ?? stored.paused?.detail) : undefined;
  const delayed = !terminal && m.delayed && m.code ? { since: prev?.delayed?.code === m.code ? prev.delayed.since : now, code: m.code } : undefined;
  const settlement = tracked?.settlement ?? prev?.settlement;
  let rec: OperationRecord = {
    v: 3,
    id,
    kind: crossChain ? "cross-chain" : "swap",
    state,
    phase: m.phase,
    createdAt: prev?.createdAt ?? stored.createdAt,
    updatedAt: Math.max(now, prev?.updatedAt ?? 0),
    amounts: {
      asset: req.from?.symbol ?? "",
      decimals: req.from?.decimals ?? 18,
      input: params.amount ?? "0",
      ...(stored.approvedMin ? { minimumOutput: stored.approvedMin } : {}),
      outputAsset: req.to?.symbol,
      outputDecimals: req.to?.decimals,
      ...(tracked?.deliveredUnits ? { delivered: tracked.deliveredUnits } : prev?.amounts.delivered ? { delivered: prev.amounts.delivered } : {}),
    },
    fees: prev?.fees ?? [],
    destination: {
      // the kind the commit journaled (audit round 2, n60): it was dropped, and every swap — a typed-in address too, a campaign's
      // always — read as fresh, "Verified" in Activity; an order from before claims nothing verified. Into the protected balance
      // (V6 Stage 12): the one-time receiver is no address of the user's, the balance is theirs (n62: an empty label before)
      kind: stored.shield ? "privacy-address" : (stored.request as { destinationKind?: string }).destinationKind === "fresh" ? "fresh" : "entered",
      display: stored.shield ? "Your protected balance" : (req.destination ?? ""),
      chain: req.to?.chain ?? "ethereum",
    },
    refs: {
      ...(prev?.refs ?? { txHashes: [] }),
      txHashes,
      orderId: stored.orderId,
      ...(stored.jobId ? { jobId: stored.jobId } : {}),
      ...(stored.executionTx ? { executionTx: stored.executionTx } : {}),
      ...(stored.executionRef ? { executionRef: stored.executionRef } : {}),
      provider: stored.provider,
      ...(stored.campaign ? { campaignId: stored.campaign.id } : {}),
    },
    tier: asTier(stored.tier),
    ...(prev?.protectedExecution ? { protectedExecution: prev.protectedExecution } : {}),
    ...(prev?.costs ? { costs: prev.costs } : {}),
    ...(settlement ? { settlement } : {}),
    ...(reason ? { reason } : {}),
    ...(delayed ? { delayed } : {}),
    ...(prev?.recovery ? { recovery: prev.recovery } : {}),
    ...(terminal
      ? prev!.outcome
        ? { outcome: prev!.outcome, ...(prev!.outcomeAsset ? { outcomeAsset: prev!.outcomeAsset } : {}) }
        : {}
      : outcome && state === "COMPLETED"
        ? { outcome, ...(outcome === "other-token" && tracked?.deliveredAsset ? { outcomeAsset: tracked.deliveredAsset } : {}) }
        : {}),
    history: prev && prev.state === state ? prev.history : [...(prev?.history ?? []), { state, at: now, ...(tracked ? { note: tracked.label } : {}) }],
  };
  // the recovery follows where the money is (spec v2.0 §12.4); a delay is watched
  if (!terminal && state === "RECOVERY_REQUIRED" && reason) rec = { ...rec, recovery: recoveryFor(rec, reason.code, now) };
  else if (!terminal && delayed)
    rec = { ...rec, recovery: { ...(rec.recovery ?? {}), state: rec.recovery?.state ?? "monitoring", since: rec.recovery?.since ?? now, lastCheckedAt: now } };
  putOperation(rec, s);
  return rec;
}

const lastReconciled = new Map<string, number>();
/** Where the money of an order never handed over can be: in its escrow (funded, or refundable). */
const BEFORE_HAND_OVER: readonly string[] = ["SOURCE_CONFIRMED", "REFUND_AVAILABLE"];

/**
 * V6 (spec v2.0 §12.5; doc §73): the API's reconcile of the open swaps when Activity opens — one call per operation per
 * 5 s — as a second source: its settlement fills a record that has none; the wallet's own reads win otherwise.
 */
export async function reconcileOpenSwaps(swaps: StoredSwap[], now = Date.now()): Promise<number> {
  let answered = 0;
  for (const s of swaps) {
    if (!s.operationId || (lastReconciled.get(s.operationId) ?? 0) > now - 5_000) continue;
    lastReconciled.set(s.operationId, now);
    const r = await swapService.reconcile(s.operationId).catch(() => null);
    if (!r) continue;
    answered++;
    const rec = getOperation(swapRecordId(s.orderId));
    // a settlement of the wallet's own vocabulary only, and before a hand-over only one with the funds in the escrow
    // (2026-10-17, the audit's unverified m48): a faulty API's COMPLETED stuck for a paused order and hid its refund, and an
    // unknown value broke the recovery card
    const handedOver = !!s.jobId || !!s.executionTx;
    const settlement =
      r.settlement && SETTLEMENT_STATES.includes(r.settlement) && (handedOver || BEFORE_HAND_OVER.includes(r.settlement)) ? r.settlement : null;
    if (rec && !rec.settlement && settlement && !isTerminal(rec.state)) putOperation({ ...rec, settlement, updatedAt: Math.max(now, rec.updatedAt) });
  }
  return answered;
}
