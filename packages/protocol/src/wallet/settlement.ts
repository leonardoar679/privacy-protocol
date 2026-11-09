// Where a swap's money is (Privacy Wallet Web spec v2.0 §12.4; doc §41), derived from its legs — the funding receipt
// and the escrow's balance, the executor's job, the provider's track, the destination, the refund job and the refund
// window. Pure and browser-safe, one implementation for both sides: the wallet derives it from its own reads
// (packages/sdk/src/orderTracker.ts legsOf), the API from its reconcile reads through the swap engine's entry
// (packages/swap-engine/src/settlement.ts re-exports it: the engine's tests depend on the SDK, so the SDK cannot depend on
// the engine); the recovery path follows it — wait (PROVIDER_PENDING, DESTINATION_PENDING), return
// the funds (REFUND_AVAILABLE: a refund-only relayer job), watch the refund (REFUNDING), done (COMPLETED, delivered or
// returned). A read that fails keeps the last known settlement (nextSettlement); a reorg is a read that says the leg is
// pending again, and nothing is re-sent.
import type { OperationState, SettlementState } from "@privacy-wallet/protocol-types";

export interface SettlementLegs {
  /** the funding transaction is mined: the escrow holds (or held) the order */
  funded: boolean;
  /** the executor's provider call is mined */
  executed: boolean;
  /** what the provider's tracking says after the execution. `refunded-at-destination` (the sixth review round, 2026-11-03): the
   *  provider paid its refund at the destination address (Mayan Fast-MCTP: USDC to the fresh address), never to the escrow — final.
   *  `failed`: the provider's last word is a failure (or a refund to the escrow that never arrived) and the executor's watch ended
   *  with nothing above dust in the escrow — nothing more comes back on its own */
  provider?: "pending" | "destination-submitted" | "delivered" | "partial" | "failed" | "refunded-to-escrow" | "refunded-at-destination";
  /** the refund of the escrow into the pool: none yet, under way, done (the refund note is in the pool), failed */
  refund?: "none" | "pending" | "done" | "failed";
  /** the escrow holds the funds and nothing will execute them (the execution failed, or its window closed without one): a
   *  refund-only job can be started now (it lands once the refund window opens) */
  refundable: boolean;
}

/** The settlement of a swap's legs; null while nothing has left the protected balance (the order is not funded). */
export function settlementOf(l: SettlementLegs): SettlementState | null {
  if (!l.funded) return null;
  if (l.refund === "done" || l.provider === "delivered" || l.provider === "refunded-at-destination") return "COMPLETED";
  if (l.refund === "pending") return "REFUNDING";
  if (l.refundable) return "REFUND_AVAILABLE";
  if (!l.executed) return "SOURCE_CONFIRMED";
  if (l.provider === "destination-submitted" || l.provider === "partial") return "DESTINATION_PENDING";
  return "PROVIDER_PENDING";
}

/** The settlement after a read: a failed read (null legs) keeps the last known one — a settlement is never downgraded by an outage. */
export const nextSettlement = (prev: SettlementState | null | undefined, legs: SettlementLegs | null): SettlementState | null =>
  legs ? settlementOf(legs) : (prev ?? null);

/**
 * Whether the escrow of an executed order the executor no longer watches holds a refund worth returning (audit round 2,
 * r36): at least the 1 % of the order an unpaid re-shield of its own asset moves (the relayer's floor,
 * apps/relayer/src/swapExecutor.ts `OWN_FLOOR_BPS`); dust below it stays where it is.
 */
export const lateRefundHeld = (balance: bigint, amount: bigint): boolean => balance > 0n && balance * 100n >= amount;
/**
 * How long past an executed order's refund time its executor still watches the escrow for a late refund, and re-shields one itself (the relayer's
 * own LATE_REFUND_WATCH_SECONDS, apps/relayer swapExecutor.ts): a refund held there inside it is the executor's to return, never yet the user's
 * (the twelfth review round, XD's critique: read as a late refund, a step had failed and paused its campaign for a refund re-shielded in seconds).
 */
export const EXECUTOR_LATE_REFUND_WATCH_SECONDS = 24 * 3600;

/**
 * The relayer's swap job states (apps/relayer/src/swapExecutor.ts; the wallet's packages/sdk/src/relayer.ts). `lapsed` (a
 * V6 follow-up of 2026-10-16): never executed, and the escrow held nothing a day past its window — never funded, or its
 * funds already back, which the refund note then shows.
 */
export type SwapJobState =
  | "waiting-funding"
  | "expired"
  | "refund-only"
  | "executing"
  | "executed"
  | "execute-failed"
  | "refunding"
  | "refunded"
  | "refund-failed"
  | "completed"
  | "lapsed";

/** A vocabulary read into the operation's: the state, the phase, the catalog code of a failure or a delay. */
export interface Mapped {
  state: OperationState;
  phase?: "funding" | "execution" | "settlement";
  code?: string;
  /** the code names a delay of `state`, not a failure */ delayed?: true;
}

/** The executor's job state → the operation state (spec v2.0 §12): one table for the wallet's adapters and the API's reconcile. */
export const SWAP_JOB_MAP: Record<SwapJobState, Mapped> = {
  "waiting-funding": { state: "SOURCE_CONFIRMING", phase: "funding" },
  executing: { state: "PROVIDER_EXECUTING", phase: "execution" },
  executed: { state: "PROVIDER_EXECUTING", phase: "execution" },
  completed: { state: "COMPLETED", phase: "settlement" },
  expired: { state: "REFUNDING", phase: "settlement" },
  "refund-only": { state: "REFUNDING", phase: "settlement" },
  // nothing in the escrow, never executed: its funds came back (the refund note found makes it REFUNDED) or never arrived
  // (the wallet's own reads stop such an order unfunded)
  lapsed: { state: "REFUNDING", phase: "settlement" },
  refunding: { state: "REFUNDING", phase: "settlement" },
  refunded: { state: "REFUNDED", phase: "settlement" },
  "execute-failed": { state: "RECOVERY_REQUIRED", phase: "execution", code: "execute_failed" },
  "refund-failed": { state: "RECOVERY_REQUIRED", phase: "settlement", code: "refund_failed" },
};

/** What a reader observed about an order's legs (the wallet from its journal and reads, the API from its reconcile reads). */
export interface LegFacts {
  /** the funding transaction was sent (the wallet knows it; the API never stores it: null — the escrow's balance decides) */
  fundingSent: boolean | null;
  /** the order was abandoned before its funding */
  abandoned?: boolean;
  /** the refund note is in the pool (the wallet's discovery) */
  refundFound?: boolean;
  /** the escrow holds a late refund in one of the route's refund tokens, or an ETH order's in wrapped ETH (the twelfth review round, VC12-N1) */
  refundTokensHeld?: boolean;
  /** ... or the route's refund tokens were not read this time (the wallet's failed read; the API reads none) — the twelfth review round, XV's critique */
  refundTokensUnread?: boolean;
  /** the executor's job, or null when there is none */
  job: { state: SwapJobState; executionTx?: string } | null;
  /** a job is expected (its id is known) but its read failed */
  jobUnread: boolean;
  /** the execution transaction as journaled */
  executionTx?: string;
  /** the provider's tracking of the execution (null: no read, or the read failed) */
  track: { state: string } | null;
  /** the escrow's balance in the order's asset; null when it could not be read */
  escrowBalance: bigint | null;
  amount: bigint;
  executeDeadline: number;
  /** the escrow's refund time, unix seconds (the executor's late-refund watch ends EXECUTOR_LATE_REFUND_WATCH_SECONDS after it) */
  refundAfter?: number;
  /** unix seconds */
  now: number;
  /** where the provider refunds an unfilled order (the quote's `refundTarget`, or the track's `refundedTo`; the sixth review round):
   *  at the destination address, a refund is final and never reaches the escrow */
  refundTarget?: "escrow" | "destination";
}

/**
 * The legs of an order from what was observed; null when the answer rests on a read that failed (the job of a
 * handed-over order, the provider's track of an executed one, the escrow's balance before any job) — the caller keeps
 * the last settlement, never a downgrade. A reorg read correctly sends a leg back.
 */
export function legsFrom(f: LegFacts): SettlementLegs | null {
  const job = f.job?.state;
  if (f.abandoned) return { funded: false, executed: false, refundable: false };
  // a refund — the note found, the relayer's "refunded" — counts once the escrow's balance is read and holds dust at most (the twelfth review
  // round, C12-1): unread, the last settlement stands; still holding the order, it is set aside and the legs read as the job and the balance say
  if (f.refundFound || job === "refunded") {
    if (f.escrowBalance === null) return null;
    // ... nor while a refund token sits in the escrow at its floor (XD's critique: a note of the order's own asset beside it had closed it refunded,
    // Return funds gone with the USDC still there)
    if (!lateRefundHeld(f.escrowBalance, f.amount) && !f.refundTokensHeld) return { funded: true, executed: false, refund: "done", refundable: false };
  }
  // ... and a job that says it refunded, after an execution, with a refund held since (XC's critique): a late refund to return, as a completed job's — once
  // its executor's watch is over (XD's critique); inside it the executor re-shields it itself
  if (
    job === "refunded" &&
    (f.job?.executionTx ?? f.executionTx) &&
    ((f.escrowBalance !== null && lateRefundHeld(f.escrowBalance, f.amount)) || f.refundTokensHeld)
  )
    // a refund time not given is read as inside the watch (the fifth critique, XE: the API's reconcile gave none, and a refund the executor re-shields at
    // its next pass had read as one to return, for good)
    return f.refundAfter !== undefined && f.now >= f.refundAfter + EXECUTOR_LATE_REFUND_WATCH_SECONDS
      ? { funded: true, executed: true, provider: "refunded-to-escrow", refundable: true }
      : // ... beside a refund paid at the destination, the order's own asset held and no refund token, inside the watch: closed at the destination, as the
        // tracker reads it (the twelfth review round, XU's critique: its closed record had kept "Refunding")
        !f.refundTokensHeld && !f.refundTokensUnread && f.track?.state === "refunded" && f.refundTarget === "destination"
        ? { funded: true, executed: true, provider: "refunded-at-destination", refundable: false }
        : { funded: true, executed: true, refund: "pending", refundable: false };
  if (f.fundingSent === false) return { funded: false, executed: false, refundable: false };
  if (f.jobUnread) return null; // the executor's job was not read
  const t = f.track?.state;
  // the executor's late-refund watch ended with the escrow empty (`completed`): delivered only on the provider's word (audit
  // round 2, r36) — a refund the provider held past the watch (a chain halt, an outbound queue) lands where no pass reads
  // again, and only a refund-only job, the wallet's "Return funds", re-shields it
  if (job === "completed") {
    if ((f.escrowBalance !== null && lateRefundHeld(f.escrowBalance, f.amount)) || f.refundTokensHeld)
      return { funded: true, executed: true, provider: "refunded-to-escrow", refundable: true };
    // the escrow's balance or the provider's side was not read: the last settlement stands, as the header promises (the sixth review
    // round, 2026-11-03: the delivered rule had come first, and a failed balance read settled a partial fill as delivered)
    if (f.escrowBalance === null || !f.track) return null;
    if (t === "refunded" && f.refundTarget === "destination") return { funded: true, executed: true, provider: "refunded-at-destination", refundable: false };
    if (t === "completed" || t === "destination-final" || t === "partial") return { funded: true, executed: true, provider: "delivered", refundable: false };
    // the provider's last word is a failure, or a refund to the escrow that the watch never saw arrive: nothing more comes back on
    // its own (the sixth review round: it had read "a refund on its way to the escrow" for good)
    if (t === "refunded" || t === "failed") return { funded: true, executed: true, provider: "failed", refundable: false };
    const provider = t === "destination-submitted" ? "destination-submitted" : "pending";
    return { funded: true, executed: true, provider, refundable: false };
  }
  const executed = job === "executed" || (job === "executing" && !!(f.job?.executionTx ?? f.executionTx));
  if (executed && t === "refunded" && f.refundTarget === "destination")
    return { funded: true, executed: true, provider: "refunded-at-destination", refundable: false };
  if (job === "refunding" || job === "refund-only" || job === "expired" || job === "lapsed" || (executed && (t === "refunded" || t === "failed")))
    return { funded: true, executed, refund: "pending", refundable: false };
  if (executed) {
    if (!f.track) return null; // the provider's side was not read
    const provider =
      t === "completed" || t === "destination-final"
        ? "delivered"
        : t === "partial"
          ? "partial"
          : t === "destination-submitted"
            ? "destination-submitted"
            : "pending";
    return { funded: true, executed: true, provider, refundable: false };
  }
  if (job === "execute-failed" || job === "refund-failed")
    return { funded: true, executed: false, refund: job === "refund-failed" ? "failed" : "none", refundable: true };
  if (job === "executing") return { funded: true, executed: false, refundable: false }; // the executor saw the funding and sends the call
  if (f.escrowBalance === null) return null; // the funding's finality rests on the escrow's balance, which was not read
  if (f.escrowBalance < f.amount) return { funded: false, executed: false, refundable: false };
  // ... a relayer's "refunded" set aside above (the escrow still holds the order, never executed) is a relayer that dropped it: past the execute
  // deadline, refundable as an order no executor took (the twelfth review round, XG's critique: Return funds had never been offered)
  return { funded: true, executed: false, refundable: (!job || job === "refunded") && f.now > f.executeDeadline };
}
