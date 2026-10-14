// Where a swap's money is (Privacy Wallet Web spec v2.0 §12.4; doc §41), derived from its legs — the funding receipt
// and the escrow's balance, the executor's job, the provider's track, the destination, the refund job and the refund
// window. Pure and browser-safe, one implementation for both sides: the wallet derives it from its own reads
// (packages/sdk/src/orderTracker.ts legsOf), the API from its reconcile reads through the swap engine's entry
// (packages/swap-engine/src/settlement.ts re-exports it: the engine's tests depend on the SDK, so the SDK cannot depend on
// the engine); the recovery path follows it — wait (PROVIDER_PENDING, DESTINATION_PENDING), return
// the funds (REFUND_AVAILABLE: a refund-only relayer job), watch the refund (REFUNDING), done (COMPLETED, delivered or
// returned). A read that fails keeps the last known settlement (nextSettlement); a reorg is a read that says the leg is
// pending again, and nothing is re-sent.
import type { SettlementState } from "@privacy-wallet/protocol-types";

export interface SettlementLegs {
  /** the funding transaction is mined: the escrow holds (or held) the order */
  funded: boolean;
  /** the executor's provider call is mined */
  executed: boolean;
  /** what the provider's tracking says after the execution */
  provider?: "pending" | "destination-submitted" | "delivered" | "partial" | "failed" | "refunded-to-escrow";
  /** the refund of the escrow into the pool: none yet, under way, done (the refund note is in the pool), failed */
  refund?: "none" | "pending" | "done" | "failed";
  /** the escrow holds funds and its refund window is open (now ≥ refundAfter): a refund can start now */
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
