// Reconcile (spec v2.0 §12.5, §15): the API's own view of a swap — the relayer's public job, the escrow's balance on the
// chain, the provider's track of the execution — read into the operation's state and settlement with the derivation the
// wallet uses (packages/protocol/src/wallet/settlement.ts legsFrom / nextSettlement / SWAP_JOB_MAP). Idempotent; a read
// that fails keeps the last settlement and never downgrades the state; a terminal state is final (I-O1). The wallet's own
// reads win when they disagree. A relayer cost above 1.5 × the committed tip of an ETH order is logged once as
// `fee.deviation`, without amounts.
import { SWAP_JOB_MAP, lateRefundHeld, legsFrom, nextSettlement, type SwapJobState } from "@privacy-wallet/protocol/wallet/settlement";
import { TERMINAL_STATES, type OperationState, type SettlementState } from "@privacy-wallet/protocol-types";
import type { OperationRow, Store } from "./store";

export interface RelayerJobView {
  state: SwapJobState;
  executionTx?: string;
  /** V6 (spec v2.0 §3): the last mined transaction's gasUsed × effectiveGasPrice */
  actualNetworkWei?: string;
}

/** The reads a reconcile makes; each answers null when it could not be made (the relayer's "none" is no job at all). */
export interface ReconcileReads {
  job(orderId: string): Promise<RelayerJobView | "none" | null>;
  escrowBalance(escrow: string, asset: string): Promise<bigint | null>;
  track(provider: string, ref: { tx?: string; ref?: string }): Promise<{ state: string; destinationTxHash?: string } | null>;
}

export type Source = "ok" | "none" | "unreachable";
export interface Reconciled {
  state: OperationState;
  settlement: SettlementState | null;
  /** a delay of the state's phase (I-O5: never a failure) */
  delayed?: { code: string };
  /** the catalog code of a state that needs recovery */
  reason?: { code: string };
  refs: { executionTx?: string; destinationTx?: string };
  checkedAt: number;
  sources: { relayer: Source; chain: Source; provider: Source };
}

const PRE_FUNDING: readonly OperationState[] = ["DRAFT", "QUOTING", "READY_TO_REVIEW", "AWAITING_AUTHORIZATION", "PREPARING_PROOF", "SUBMITTING"];

/**
 * The operation's state from what was read — the wallet's tracker (packages/sdk/src/orderTracker.ts deriveState) read
 * through its adapters, on the facts the API has (it never stores the funding transaction: the escrow's balance decides).
 */
export function stateFrom(
  row: Pick<OperationRow, "state" | "executeDeadline" | "refundAfter" | "amount">,
  job: RelayerJobView | null,
  track: { state: string } | null,
  funded: boolean | null,
  nowS: number,
  /** the escrow holds a refund that came back after the executor's watch (lateRefundHeld) */
  lateRefund = false,
): { state: OperationState; code?: string; delayed?: true } {
  const j = job?.state;
  if (j === "refunded") return { state: "REFUNDED" };
  // completed only on the provider's word (audit round 2, r36): the executor's watch ending with the escrow empty is none, and
  // a refund held past it waits for the wallet's return
  if (j === "completed") {
    if (lateRefund) return { state: "RECOVERY_REQUIRED", code: "late_refund" };
    if (track?.state === "partial") return { state: "RECOVERY_REQUIRED", code: "partial_delivery" };
    return track?.state === "completed" || track?.state === "destination-final" ? { state: "COMPLETED" } : { state: "DESTINATION_CONFIRMING" };
  }
  if (j === "refunding" || j === "refund-only" || j === "expired") return { state: "REFUNDING" };
  if (j === "execute-failed" || j === "refund-failed") return { state: SWAP_JOB_MAP[j].state, ...(SWAP_JOB_MAP[j].code ? { code: SWAP_JOB_MAP[j].code } : {}) };
  if (j === "executing" || j === "executed") {
    if (!job?.executionTx && j === "executing") return { state: "PROVIDER_EXECUTING" };
    switch (track?.state) {
      case "completed":
      case "destination-final":
      case "destination-submitted":
        return { state: "DESTINATION_CONFIRMING" };
      case "partial":
        return { state: "RECOVERY_REQUIRED", code: "partial_delivery" };
      case "refunded":
        return { state: "REFUNDING" };
      case "failed":
        return nowS >= row.refundAfter ? { state: "REFUNDING" } : { state: "RECOVERY_REQUIRED", code: "destination_failed" };
      default:
        return { state: "PROVIDER_EXECUTING" };
    }
  }
  // no job yet, or a job waiting for the funding: the escrow's balance decides
  if (funded === null) return { state: row.state };
  if (funded) {
    if (nowS > row.executeDeadline)
      return nowS >= row.refundAfter ? { state: "REFUNDING" } : { state: "PROVIDER_EXECUTING", code: "provider_timeout", delayed: true };
    return { state: "PROVIDER_EXECUTING" };
  }
  // V7: expired before its funding — nothing moved; closed only once its refund time has passed (a funding in the mempool at
  // the deadline still lands and is re-derived meanwhile: the review round of 2026-11-02), waiting as RECOVERY_REQUIRED until then
  // a RECOVERY_REQUIRED row with no job and no funding is that expired order waiting (nothing else leaves a row there)
  const beforeFunding = PRE_FUNDING.includes(row.state) || row.state === "RECOVERY_REQUIRED";
  if (nowS > row.executeDeadline && beforeFunding)
    return nowS >= row.refundAfter ? { state: "CANCELLED", code: "order_expired" } : { state: "RECOVERY_REQUIRED", code: "order_expired" };
  // the executor's watch ended with the escrow empty, or holding dust, never executed (`lapsed`; the review round of 2026-11-03,
  // F3): the funds came back — another relayer's refund-only job, anyone's deployAndRefund — or never arrived. Past the funding
  // the row says REFUNDING (the refund note found makes it REFUNDED), never "the funding is pending again"
  if (j === "lapsed" && !beforeFunding) return { state: "REFUNDING" };
  // not funded: before the funding the recorded state stands; after it, an empty escrow is a reorg — the funding is pending again
  return { state: beforeFunding ? row.state : "SOURCE_CONFIRMING" };
}

export async function reconcileOperation(store: Store, row: OperationRow, reads: ReconcileReads, now = store.now()): Promise<Reconciled> {
  const nowS = Math.floor(now / 1000);
  const exec = store.execution(row.id);
  const jobRead = await reads.job(row.orderId).catch(() => null);
  const job = jobRead && jobRead !== "none" ? jobRead : null;
  const executionTx = job?.executionTx ?? exec?.executionTx ?? undefined;
  const balance = await reads.escrowBalance(row.escrow, row.asset).catch(() => null);
  const trackRead =
    executionTx || exec?.providerRef
      ? await reads
          .track(row.provider, { ...(executionTx ? { tx: executionTx } : {}), ...(exec?.providerRef ? { ref: exec.providerRef } : {}) })
          .catch(() => null)
      : null;
  const sources = {
    relayer: (jobRead === null ? "unreachable" : jobRead === "none" ? "none" : "ok") as Source,
    chain: (balance === null ? "unreachable" : "ok") as Source,
    provider: (executionTx ? (trackRead ? "ok" : "unreachable") : "none") as Source,
  };
  if (job)
    store.putJob(row.id, {
      state: job.state,
      ...(job.executionTx ? { executionTx: job.executionTx } : {}),
      ...(job.actualNetworkWei ? { actualWei: job.actualNetworkWei } : {}),
    });

  const legs = legsFrom({
    fundingSent: null,
    refundFound: false,
    job: job ? { state: job.state, ...(job.executionTx ? { executionTx: job.executionTx } : {}) } : null,
    jobUnread: jobRead === null,
    ...(executionTx ? { executionTx } : {}),
    track: trackRead,
    escrowBalance: balance,
    amount: BigInt(row.amount),
    executeDeadline: row.executeDeadline,
    now: nowS,
  });
  const settlement = nextSettlement(row.settlement, legs);
  const funded = balance === null ? null : balance >= BigInt(row.amount);
  const derived: { state: OperationState; code?: string; delayed?: true } =
    TERMINAL_STATES.includes(row.state) || jobRead === null
      ? { state: row.state }
      : stateFrom(row, job, trackRead, funded, nowS, balance !== null && lateRefundHeld(balance, BigInt(row.amount)));
  store.updateState(row.id, { state: derived.state, settlement });
  if (derived.state !== row.state)
    store.event({ event: "operation.reconciled", operationId: row.id, provider: row.provider, state: derived.state, network: row.network });

  // doc §43: the executor's real cost against the tip it was committed (comparable for an ETH order only)
  const actual = job?.actualNetworkWei ? BigInt(job.actualNetworkWei) : null;
  if (actual !== null && row.asset === "native" && actual * 2n > BigInt(row.executorTip) * 3n && !store.hasEvent("fee.deviation", row.id))
    store.event({
      event: "fee.deviation",
      level: "warn",
      operationId: row.id,
      provider: row.provider,
      network: row.network,
      errorClass: "execution_above_tip",
    });

  return {
    state: derived.state,
    settlement,
    ...(derived.delayed && derived.code ? { delayed: { code: derived.code } } : {}),
    ...(derived.code && !derived.delayed ? { reason: { code: derived.code } } : {}),
    refs: { ...(executionTx ? { executionTx } : {}), ...(trackRead?.destinationTxHash ? { destinationTx: trackRead.destinationTxHash } : {}) },
    checkedAt: now,
    sources,
  };
}
