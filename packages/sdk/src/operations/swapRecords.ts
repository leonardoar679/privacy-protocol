// The operation record of a swap order (spec §12; V6 Stage 11: moved from apps/web so the order runner keeps it too): one record per order, keyed `swap:<orderId>`, its state read from
// the journaled order and the tracker's last derivation through the adapters, the refs and the reason with it. The
// engines keep their own states; the record follows them. V6 (spec v2.0 §12): a delay is `delayed` on the phase's state,
// the settlement comes from the tracker (kept when a read could not tell), and a terminal record keeps its state (I-O1).
import type { Tracked } from "../orderTracker";
import { CLOSING_READINGS, refundNotesBack, SWAP_CLOSED_STATES } from "../orderStates";
import { lateRefundHeld } from "@privacy-wallet/protocol/wallet/settlement";
import type { SwapJob } from "../relayer";
import { fundedOf, type StoredSwap } from "../wallet/journal";
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
  given: Tracked | null,
  job: SwapJob | null,
  now = Date.now(),
  s: WalletSession = defaultSession,
): OperationRecord {
  // a closed order's live reading that does not close it is not this record's (the twelfth review round, C12-3's critique): the reading that closed it
  // stands — a Refresh with the provider down had moved a provider failure's record to Executing. A late refund reopens it (the order is open again)
  const tracked = given && SWAP_CLOSED_STATES.includes(stored.state) && !CLOSING_READINGS.includes(given.state) && given.state !== "LATE_REFUND" ? null : given;
  const req = (stored.request ?? {}) as {
    from?: { symbol?: string; decimals?: number; chain?: string };
    to?: { symbol?: string; decimals?: number; chain?: string };
    destination?: string;
  };
  const params = stored.params as { amount?: string };
  // a closed order re-synced with no live reading (a closed-order tick, A10-6) is the journal's last reading where that reading is the one that
  // closed it (the twelfth review round, C12-8): a provider failure, a refund paid at the destination — from the bare journal state "completed"
  // either had been recorded "Swap complete", terminal. Never a stale open reading over a closed order
  const lastClosing: Pick<Tracked, "state"> | null =
    !tracked && stored.state === "completed" && (stored.track?.state === "PROVIDER_FAILED" || stored.track?.state === "REFUNDED_AT_DESTINATION")
      ? { state: stored.track.state }
      : null;
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
    tracked ?? lastClosing,
  );
  // a partial fill whose rest is accounted for — the executor's watch ended, or its refund came back — is finished (the ninth review round,
  // 2026-11-04, C-03): it had stayed "needs attention" for good, its only action changing nothing; while the rest may still come back it waits
  // with no job given (a closed order's re-sync), the journal's own closed state is the job's last word (the second critique): "refunded" from a job
  // — the rest came back — and "completed" — the watch ended — settle a partial fill as its runner's reading had
  const restBack = job?.state === "refunded" || refundNotesBack(stored) || (!job && stored.state === "refunded" && !!stored.jobId);
  // the journal's last reading where no live one is given (the eleventh review round, 2026-11-04, B11-1): a refund the scan journals before the
  // runner reads the refunded job re-syncs the closed order with none, and a partly delivered swap had been recorded REFUNDED for good
  const partial: Pick<Tracked, "state" | "deliveredUnits" | "deliveredAsset" | "otherToken"> | null =
    tracked?.state === "PARTIAL"
      ? tracked
      : !tracked && stored.track?.state === "PARTIAL"
        ? {
            state: "PARTIAL",
            deliveredUnits: stored.track.deliveredAmount,
            ...(stored.track.otherToken ? { otherToken: true } : {}),
            ...(stored.track.deliveredAsset ? { deliveredAsset: stored.track.deliveredAsset } : {}),
          }
        : null;
  const settledPartial = !!partial && (job?.state === "completed" || restBack || (!job && stored.state === "completed"));
  // a provider failure whose funds came back later (the verifier's VB-N1): the refund note found makes it a refund — the bare journal state
  // "completed" had recorded it "Swap complete", terminal
  // ... what came back being the order's own and more than dust (the twelfth review round, C12-1's critique: a 1-wei note anyone holding the
  // payload can make had recorded a provider failure REFUNDED, terminal, and a late refund then had no Return funds)
  const refundVault = String((stored.params as { refundVault?: string }).refundVault ?? "").toLowerCase();
  const ownBack = (stored.refunds ?? []).filter((x) => !refundVault || x.vault.toLowerCase() === refundVault).reduce((a, x) => a + BigInt(x.amount), 0n);
  // ... or, on a route that refunds in another token, a note in one of its refund tokens' vaults at that token's floor at least (XB's critique: the
  // provider's refund of a swap-first route, re-shielded in its token, had left the record "check the provider's record" for good)
  const tokenBack = (stored.refunds ?? []).some((x) => {
    const floor = stored.refundVaults?.[x.vault.toLowerCase()];
    return floor !== undefined && BigInt(x.amount) >= BigInt(floor);
  });
  const failedBack =
    !tracked && stored.track?.state === "PROVIDER_FAILED" && (job?.state === "refunded" || lateRefundHeld(ownBack, BigInt(params.amount ?? "0")) || tokenBack);
  const m = settledPartial
    ? { state: "COMPLETED" as const, phase: "settlement" as const }
    : failedBack
      ? { state: "REFUNDED" as const, phase: "settlement" as const }
      : mapped;
  // what such an order came to, beside its state (C-03, C-07: a refund the provider paid at the destination had read "Swap complete") — and
  // only what the record knows (the tenth review round, A10-2): "the rest came back" with a refund note found or a refunded job; a completed job
  // re-shielded nothing, so the rest did not come back; a delivery in another token (LI.FI's) is its own outcome, the round-7 rule for steps
  const otherToken = !!partial?.otherToken || !!partial?.deliveredAsset;
  const outcome: OperationOutcome | undefined = settledPartial
    ? otherToken
      ? "other-token"
      : restBack
        ? "partial"
        : "partial-unreturned"
    : (tracked ?? lastClosing)?.state === "REFUNDED_AT_DESTINATION"
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
      ...(partial?.deliveredUnits
        ? { delivered: partial.deliveredUnits }
        : tracked?.deliveredUnits
          ? { delivered: tracked.deliveredUnits }
          : prev?.amounts.delivered
            ? { delivered: prev.amounts.delivered }
            : {}),
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
        ? // a rest that came back after the record settled refines what it says (the eleventh review round, B11-8; I-O1 holds the state)
          {
            outcome: prev!.outcome === "partial-unreturned" && refundNotesBack(stored) ? "partial" : prev!.outcome,
            ...(prev!.outcomeAsset ? { outcomeAsset: prev!.outcomeAsset } : {}),
          }
        : {}
      : outcome && state === "COMPLETED"
        ? { outcome, ...(outcome === "other-token" && partial?.deliveredAsset ? { outcomeAsset: partial.deliveredAsset } : {}) }
        : {}),
    history: prev && prev.state === state ? prev.history : [...(prev?.history ?? []), { state, at: now, ...(tracked ? { note: tracked.label } : {}) }],
  };
  // the recovery follows where the money is (spec v2.0 §12.4); a delay is watched. An order stopped for the user's choice before any funding
  // has nothing in an escrow: its funds were not moved, and no refund is offered or watched (the fifth critique of slice 4: a delayed order
  // whose fresh minimum moved had read "A refund can be started" for funds that never left)
  const unfunded = !fundedOf(stored) && !stored.fundingAttempt;
  if (!terminal && state === "RECOVERY_REQUIRED" && reason && unfunded) {
    const { recovery: _none, ...rest } = rec;
    rec = { ...rest, reason: { ...reason, fundsClass: "not-moved" } };
  } else if (!terminal && state === "RECOVERY_REQUIRED" && reason) rec = { ...rec, recovery: recoveryFor(rec, reason.code, now) };
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
