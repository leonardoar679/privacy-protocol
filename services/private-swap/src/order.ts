// Route state machine (spec §3) with a durable-journal interface for recovery.
import type { Order, OrderState, UserStatus } from "./types";

export type OrderEvent =
  | "commit" | "submit-source" | "source-final" | "source-failed" | "executed" | "destination-submitted"
  | "destination-final" | "completed" | "partial" | "provider-timeout" | "destination-failed"
  | "refund-window" | "refunded" | "quote-expired" | "cancel" | "give-up";

/** Every legal transition; anything else is a bug and throws. */
const TRANSITIONS: Record<OrderState, Partial<Record<OrderEvent, OrderState>>> = {
  QUOTED: { commit: "COMMITTED", "quote-expired": "EXPIRED", cancel: "CANCELLED" },
  COMMITTED: { "submit-source": "SOURCE_SUBMITTED", "quote-expired": "EXPIRED", cancel: "CANCELLED" },
  SOURCE_SUBMITTED: { "source-final": "SOURCE_FINAL", "source-failed": "SOURCE_FAILED" },
  SOURCE_FINAL: { executed: "PROVIDER_EXECUTING", "refund-window": "REFUND_PENDING", "provider-timeout": "PROVIDER_TIMEOUT" },
  PROVIDER_EXECUTING: { "destination-submitted": "DESTINATION_SUBMITTED", "provider-timeout": "PROVIDER_TIMEOUT", partial: "PARTIAL", "refund-window": "REFUND_PENDING" },
  DESTINATION_SUBMITTED: { "destination-final": "DESTINATION_FINAL", "destination-failed": "DESTINATION_FAILED", partial: "PARTIAL" },
  DESTINATION_FINAL: { completed: "COMPLETED", partial: "PARTIAL" },
  COMPLETED: {},
  EXPIRED: {},
  CANCELLED: {},
  SOURCE_FAILED: { "give-up": "FAILED", "submit-source": "SOURCE_SUBMITTED" },
  PROVIDER_TIMEOUT: { "refund-window": "REFUND_PENDING", "destination-submitted": "DESTINATION_SUBMITTED", "give-up": "FAILED" },
  PARTIAL: { "refund-window": "REFUND_PENDING", "give-up": "FAILED" },
  DESTINATION_FAILED: { "refund-window": "REFUND_PENDING", "give-up": "FAILED" },
  REFUND_PENDING: { refunded: "REFUNDED", "give-up": "FAILED" },
  REFUNDED: {},
  FAILED: { "refund-window": "REFUND_PENDING" },
};

export const TERMINAL: OrderState[] = ["COMPLETED", "EXPIRED", "CANCELLED", "REFUNDED"];

export function nextState(from: OrderState, ev: OrderEvent): OrderState {
  const to = TRANSITIONS[from][ev];
  if (!to) throw new Error(`illegal transition: ${from} --${ev}--> (none)`);
  return to;
}

/** What the user sees (plan §33): never "atomic", always one of these. */
export function userStatus(s: OrderState): UserStatus {
  switch (s) {
    case "QUOTED": case "COMMITTED": case "SOURCE_SUBMITTED": case "SOURCE_FINAL": return "Pending";
    case "PROVIDER_EXECUTING": case "DESTINATION_SUBMITTED": case "DESTINATION_FINAL": return "Executing";
    case "COMPLETED": return "Completed";
    case "PARTIAL": return "Partial";
    case "REFUND_PENDING": case "PROVIDER_TIMEOUT": case "DESTINATION_FAILED": return "Refunding";
    case "REFUNDED": return "Refunded";
    default: return "Failed"; // EXPIRED, CANCELLED, SOURCE_FAILED, FAILED
  }
}

/** Durable journal: the wallet persists every transition before acting on it (spec §3 recovery). */
export interface OrderJournal {
  save(order: Order): Promise<void>;
  load(orderId: string): Promise<Order | undefined>;
  list(): Promise<Order[]>;
}

export class MemoryJournal implements OrderJournal {
  private m = new Map<string, Order>();
  async save(o: Order) { this.m.set(o.orderId, structuredClone(o)); }
  async load(id: string) { return this.m.get(id); }
  async list() { return [...this.m.values()]; }
}

export async function transition(order: Order, ev: OrderEvent, journal: OrderJournal, note?: string, now = Date.now()): Promise<Order> {
  const to = nextState(order.state, ev);
  order.state = to;
  order.history.push({ state: to, at: now, note });
  await journal.save(order);
  return order;
}

/**
 * Recovery (spec §3): given what is observable — escrow balance, Executed/Refunded events, adapter
 * status, time — derive the state a restarted wallet should be in. Pure; the caller supplies facts.
 */
export function recoverState(o: Order, facts: {
  now: number; escrowBalance: bigint; executed: boolean; refunded: boolean;
  track?: { state: string; deliveredAmount?: bigint };
}): OrderState {
  if (facts.refunded) return "REFUNDED";
  if (facts.executed) {
    const t = facts.track?.state;
    if (t === "completed") return "COMPLETED";
    if (t === "partial") return "PARTIAL";
    if (t === "destination-final") return "DESTINATION_FINAL";
    if (t === "destination-submitted") return "DESTINATION_SUBMITTED";
    if (t === "failed") return facts.now >= o.params.refundAfter ? "REFUND_PENDING" : "DESTINATION_FAILED";
    return facts.now >= o.params.refundAfter && facts.escrowBalance > 0n ? "REFUND_PENDING" : "PROVIDER_EXECUTING";
  }
  if (facts.escrowBalance >= o.params.amount) {
    return facts.now > o.params.executeDeadline ? (facts.now >= o.params.refundAfter ? "REFUND_PENDING" : "PROVIDER_TIMEOUT") : "SOURCE_FINAL";
  }
  if (["SOURCE_SUBMITTED"].includes(o.state)) return "SOURCE_SUBMITTED";
  if (facts.now > o.quote.expiresAt && ["QUOTED", "COMMITTED"].includes(o.state)) return "EXPIRED";
  return o.state;
}
