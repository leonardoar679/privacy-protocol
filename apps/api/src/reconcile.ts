// Reconcile (spec v2.0 §12.5, §15): the API's own view of a swap — the relayer's public job, the escrow's balance on the
// chain, the provider's track of the execution — read into the operation's state and settlement with the derivation the
// wallet uses (packages/protocol/src/wallet/settlement.ts legsFrom / nextSettlement / SWAP_JOB_MAP). Idempotent; a read
// that fails keeps the last settlement and never downgrades the state; a terminal state is final (I-O1). The wallet's own
// reads win when they disagree. A relayer cost above 1.5 × the committed tip of an ETH order is logged once as
// `fee.deviation`, without amounts.
import {
  EXECUTOR_LATE_REFUND_WATCH_SECONDS,
  SWAP_JOB_MAP,
  lateRefundHeld,
  legsFrom,
  nextSettlement,
  type SwapJobState,
} from "@privacy-wallet/protocol/wallet/settlement";
import { TERMINAL_STATES, type OperationState, type SettlementState } from "@privacy-wallet/protocol-types";
import type { OperationRow, Store } from "./store";

export interface RelayerJobView {
  state: SwapJobState;
  /** the job's execution was mined (the relayer's own flag; the eighth review round, A-L1) */
  executed?: boolean;
  executionTx?: string;
  /** V6 (spec v2.0 §3): the last mined transaction's gasUsed × effectiveGasPrice */
  actualNetworkWei?: string;
}

/** The reads a reconcile makes; each answers null when it could not be made (the relayer's "none" is no job at all). */
export interface ReconcileReads {
  job(orderId: string): Promise<RelayerJobView | "none" | null>;
  escrowBalance(escrow: string, asset: string): Promise<bigint | null>;
  track(
    provider: string,
    ref: { tx?: string; ref?: string },
  ): Promise<{
    state: string;
    destinationTxHash?: string;
    refundedTo?: "escrow" | "destination";
    /** base units delivered, when the provider says (A9-6) */ deliveredAmount?: string | bigint;
  } | null>;
  /**
   * Whether the escrow is deployed (eth_getCode; the eighth review round, A-L1): an empty deployed escrow after its funding is neither a
   * reorg nor "nothing moved". Null when it could not be read; absent, never read. Anyone can deploy an escrow bare (the factory's
   * `deploy` is public: the ninth review round, A9-12), so its code alone never says it executed — `executed` does
   */
  deployed?(escrow: string): Promise<boolean | null>;
  /** The escrow's own `executed` flag (A9-12): false for an escrow not deployed; null when it could not be read; absent, never read. */
  executed?(escrow: string): Promise<boolean | null>;
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
/** The execution's steps in their order: a reconcile never moves a row back along them (A9-7). */
const FORWARD: readonly OperationState[] = ["SOURCE_CONFIRMING", "PROVIDER_EXECUTING", "DESTINATION_CONFIRMING"];

/**
 * The operation's state from what was read — the wallet's tracker (packages/sdk/src/orderTracker.ts deriveState) read
 * through its adapters, on the facts the API has (it never stores the funding transaction: the escrow's balance decides).
 */
export function stateFrom(
  row: Pick<OperationRow, "state" | "executeDeadline" | "refundAfter" | "amount">,
  job: RelayerJobView | null,
  track: { state: string; refundedTo?: "escrow" | "destination"; deliveredAmount?: string | bigint } | null,
  funded: boolean | null,
  nowS: number,
  /** the escrow holds more than dust (lateRefundHeld): after an execution a refund held there — the executor's inside its watch, the user's to return
   *  past it —, or, never executed, the order itself */
  lateRefund = false,
  /** the escrow's balance was read this time (the sixth review round, 2026-11-03): nothing settles on an unread one */
  escrowRead = true,
  /**
   * The eighth review round (2026-11-03, A-L1): the API finalized the order (an execution row), and whether its escrow is deployed —
   * the API's state had contradicted the wallet's and the chain's on three paths.
   */
  facts: { finalized?: boolean; deployed?: boolean | null; executed?: boolean | null } = {},
): { state: OperationState; code?: string; delayed?: true } {
  const j = job?.state;
  // the escrow unread: nothing settles on it, as in the completed branch (the twelfth review round, XF's critique: since C12-1 the legs give no
  // settlement on an unread balance, and the terminal REFUNDED written beside it froze the row — a late refund never reached)
  if (j === "refunded" && !escrowRead) return { state: "REFUNDING" };
  // ... and a job that never executed is a refund in full only with the escrow read at dust at most (C12-1, the wallet's rule: the relayer's
  // "refunded" is only its word); still holding the order, the job is set aside and the funding rules below read it
  if (j === "refunded" && (job?.executed || !lateRefund)) {
    // the wallet's rule (orderTracker deriveState; the ninth review round, 2026-11-04, A9-6, refined by the eleventh's K4 critique): mined only on
    // the relayer's own flag — it keeps a reverted execution's transaction —; an executed order whose rest came back delivered part when the
    // provider gave units or said it delivered, is read again while its delivery is on its way or the provider tells nothing (unknown, pending,
    // executing) or is not read, and is a refund in full only on the provider's word that nothing was delivered (its refund, its failure). The
    // API had read the track's state and contradicted the wallet on four of five shapes
    if (!job?.executed) return { state: "REFUNDED" };
    // a refund held in the escrow since, after an execution (the twelfth review round, XE's critique): the executor's to re-shield inside its late-refund
    // watch, a late refund to return past it — never a terminal REFUNDED beside it (the wallet's rule: orderTracker deriveOrderState)
    if (lateRefund)
      return nowS >= row.refundAfter + EXECUTOR_LATE_REFUND_WATCH_SECONDS ? { state: "RECOVERY_REQUIRED", code: "late_refund" } : { state: "REFUNDING" };
    if (track === null) return { state: "REFUNDING" }; // the provider unread: nothing final on it
    let units = 0n;
    try {
      units = BigInt(track.deliveredAmount ?? "0");
    } catch {
      units = 0n;
    }
    // the provider's word of a delivery without its amount is a partial delivery too (the eleventh review round's K4 critique; Mayan's and
    // Across's tracks never give one)
    const deliveredWord = track.state === "completed" || track.state === "destination-final" || track.state === "partial";
    if (units > 0n || deliveredWord) return { state: "RECOVERY_REQUIRED", code: "partial_delivery" };
    // ... a refund in full only on its word that nothing was delivered; one on its way, or an answer that tells nothing (four adapters answer
    // "unknown" for their own failures), is nothing final yet: read again until the provider's last word
    return track.state === "refunded" || track.state === "failed" ? { state: "REFUNDED" } : { state: "REFUNDING" };
  }
  // a refund the provider paid at the destination address (the sixth review round, 2026-11-03; Mayan Fast-MCTP): final, whatever
  // the executor's watch says — nothing reaches the escrow — save a late refund held after a completed job's watch, which the wallet offers back (the
  // twelfth review round, XU's critique: this terminal row could not follow its LATE_REFUND)
  if (
    track?.state === "refunded" &&
    track.refundedTo === "destination" &&
    (j === "completed" || j === "executed" || j === "executing") &&
    !(j === "completed" && lateRefund)
  )
    return { state: "COMPLETED" };
  // completed only on the provider's word (audit round 2, r36): the executor's watch ending with the escrow empty is none, and
  // a refund held past it waits for the wallet's return
  if (j === "completed") {
    if (lateRefund) return { state: "RECOVERY_REQUIRED", code: "late_refund" };
    if (!escrowRead) return { state: "DESTINATION_CONFIRMING" };
    if (track?.state === "partial") return { state: "RECOVERY_REQUIRED", code: "partial_delivery" };
    // the provider's last word is a failure, or a refund to the escrow the watch never saw arrive: nothing more comes back on its own
    if (track?.state === "failed" || track?.state === "refunded") return { state: "RECOVERY_REQUIRED", code: "provider_failed" };
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
  // a deployed escrow was executed or refunded (A-L1): executed through another relayer when this API finalized it — the provider
  // delivers — else refunded by anyone's deployAndRefund; never "the funding is pending again", never "nothing moved"
  // the escrow's own flag says it executed (A9-12) — unread, its code with this API's finalize, as before (A-L1); deployed, not executed, and
  // empty after its funding: someone's deployAndRefund. Before any funding a bare deploy moves nothing: anyone can deploy an escrow
  if (facts.executed === true || (facts.deployed === true && facts.executed == null && facts.finalized)) return { state: "PROVIDER_EXECUTING" };
  if (facts.deployed === true && !beforeFunding) return { state: "REFUNDING" };
  // an order this API finalized is never closed as one that moved nothing (A-L1): it waits, open, for the wallet's reads
  if (nowS > row.executeDeadline && beforeFunding)
    return nowS >= row.refundAfter && !facts.finalized ? { state: "CANCELLED", code: "order_expired" } : { state: "RECOVERY_REQUIRED", code: "order_expired" };
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
  const legs = legsFrom({
    fundingSent: null,
    refundFound: false,
    // the API reads no refund token: a refund paid at the destination beside a leftover inside the watch stays refunding, as stateFrom reads it (the
    // twelfth review round, XV's critique: its row had read REFUNDING beside a COMPLETED settlement)
    refundTokensUnread: true,
    job: job ? { state: job.state, ...(job.executionTx ? { executionTx: job.executionTx } : {}) } : null,
    jobUnread: jobRead === null,
    ...(executionTx ? { executionTx } : {}),
    track: trackRead,
    escrowBalance: balance,
    amount: BigInt(row.amount),
    executeDeadline: row.executeDeadline,
    refundAfter: row.refundAfter,
    now: nowS,
    ...(trackRead?.refundedTo ? { refundTarget: trackRead.refundedTo } : {}),
  });
  // the row as it is now, read again after the last await (the eleventh review round, 2026-11-04, B11-6): a reconcile that started later and whose
  // provider read failed had moved a row another reconcile finalized meanwhile back to an earlier step. node:sqlite answers synchronously, so this
  // read and the write below are one step
  const funded = balance === null ? null : balance >= BigInt(row.amount);
  // with no job to read, an empty escrow's code says whether it moved (A-L1); read only then
  const deployed = !job && funded === false && reads.deployed ? await reads.deployed(row.escrow).catch(() => null) : null;
  const executedFlag = !job && funded === false && deployed === true && reads.executed ? await reads.executed(row.escrow).catch(() => null) : null;
  const current = store.getOperation(row.id) ?? row;
  const settlement = nextSettlement(current.settlement, legs);
  // from the row as it is now too (the critique of B11-6): a failed relayer read had answered the start snapshot's state, written back over a row
  // another reconcile had moved on
  const read: { state: OperationState; code?: string; delayed?: true } =
    TERMINAL_STATES.includes(current.state) || jobRead === null
      ? { state: current.state }
      : stateFrom(current, job, trackRead, funded, nowS, balance !== null && lateRefundHeld(balance, BigInt(row.amount)), balance !== null, {
          finalized: !!exec,
          deployed,
          executed: executedFlag,
        });
  // an order this API finalized never goes from a later step of the execution back to an earlier one (the ninth review round, 2026-11-04,
  // A9-7): a job read "none" — another relayer, a changed RELAYER_URL — had moved DESTINATION_CONFIRMING back to PROVIDER_EXECUTING. One never
  // handed over still goes back when its escrow empties without a job (a reorg: the funding pending again)
  const back = !!exec && FORWARD.indexOf(read.state) >= 0 && FORWARD.indexOf(read.state) < FORWARD.indexOf(current.state);
  const derived = back ? { state: current.state } : read;
  // never over a row a later-started reconcile wrote (A9-7; the tenth review round, B10-12: by the row it read, two overlapping reconciles had
  // kept the older snapshot when it wrote first, and the newer terminal answer, refused, was answered all the same): a refused write answers
  // what the row holds now
  const wrote = store.updateState(row.id, { state: derived.state, settlement }, { startedAt: now });
  // the job's read is written under the state write's own rule, never over a later-started reconcile's (the twelfth review round, C12-5): an
  // earlier-started reconcile whose state write was refused had written the relayer's older read back — an execution transaction the relayer had
  // dropped and sent again — over the later one's, and the stall rule compared the wallet's transaction with a dead one. A terminal row refuses the
  // state but takes the job read of the latest reconcile, as before
  const laterStarted = !wrote && (store.getOperation(row.id)?.checkedAt ?? 0) > now;
  if (job && !laterStarted)
    store.putJob(row.id, {
      state: job.state,
      ...(job.executionTx ? { executionTx: job.executionTx } : {}),
      ...(job.actualNetworkWei ? { actualWei: job.actualNetworkWei } : {}),
    });
  // a refused write answers the row as it is — its state, settlement and time — and nothing of the refused read (B11-7): its superseded
  // settlement had been answered beside the newer state
  const held = wrote ? null : (store.getOperation(row.id) ?? current);
  const answered = wrote ? derived : { state: held!.state };
  // a transition against the row as it is (the second critique): another reconcile's own move had been logged twice
  if (wrote && derived.state !== current.state)
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

  // the row's state, settlement and time — another reconcile's —; its sources stay this read's own reachability, what this reconcile reached
  // (the critique: nothing else of the refused read is answered)
  if (!wrote) return { state: held!.state, settlement: held!.settlement ?? null, refs: {}, checkedAt: held!.checkedAt ?? now, sources };
  return {
    state: answered.state,
    settlement,
    ...(derived.delayed && derived.code ? { delayed: { code: derived.code } } : {}),
    ...(derived.code && !derived.delayed ? { reason: { code: derived.code } } : {}),
    refs: { ...(executionTx ? { executionTx } : {}), ...(trackRead?.destinationTxHash ? { destinationTx: trackRead.destinationTxHash } : {}) },
    checkedAt: now,
    sources,
  };
}
