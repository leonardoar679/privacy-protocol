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
  /** what the provider's tracking says after the execution */
  provider?: "pending" | "destination-submitted" | "delivered" | "partial" | "failed" | "refunded-to-escrow";
  /** the refund of the escrow into the pool: none yet, under way, done (the refund note is in the pool), failed */
  refund?: "none" | "pending" | "done" | "failed";
  /** the escrow holds the funds and nothing will execute them (the execution failed, or its window closed without one): a
   *  refund-only job can be started now (it lands once the refund window opens) */
  refundable: boolean;
}

/** The settlement of a swap's legs; null while nothing has left the protected balance (the order is not funded). */
export function settlementOf(l: SettlementLegs): SettlementState | null {
  if (!l.funded) return null;
  if (l.refund === "done" || l.provider === "delivered") return "COMPLETED";
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
  /** unix seconds */
  now: number;
}

/**
 * The legs of an order from what was observed; null when the answer rests on a read that failed (the job of a
 * handed-over order, the provider's track of an executed one, the escrow's balance before any job) — the caller keeps
 * the last settlement, never a downgrade. A reorg read correctly sends a leg back.
 */
export function legsFrom(f: LegFacts): SettlementLegs | null {
  const job = f.job?.state;
  if (f.abandoned) return { funded: false, executed: false, refundable: false };
  if (f.refundFound || job === "refunded") return { funded: true, executed: false, refund: "done", refundable: false };
  if (f.fundingSent === false) return { funded: false, executed: false, refundable: false };
  if (f.jobUnread) return null; // the executor's job was not read
  const t = f.track?.state;
  // the executor's late-refund watch ended with the escrow empty (`completed`): delivered only on the provider's word (audit
  // round 2, r36) — a refund the provider held past the watch (a chain halt, an outbound queue) lands where no pass reads
  // again, and only a refund-only job, the wallet's "Return funds", re-shields it
  if (job === "completed") {
    if (f.escrowBalance !== null && lateRefundHeld(f.escrowBalance, f.amount))
      return { funded: true, executed: true, provider: "refunded-to-escrow", refundable: true };
    if (t === "completed" || t === "destination-final" || t === "partial") return { funded: true, executed: true, provider: "delivered", refundable: false };
    if (f.escrowBalance === null || !f.track) return null; // the escrow's balance or the provider's side was not read
    const provider = t === "destination-submitted" ? "destination-submitted" : t === "refunded" || t === "failed" ? "refunded-to-escrow" : "pending";
    return { funded: true, executed: true, provider, refundable: false };
  }
  const executed = job === "executed" || (job === "executing" && !!(f.job?.executionTx ?? f.executionTx));
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
  return { funded: true, executed: false, refundable: !job && f.now > f.executeDeadline };
}
