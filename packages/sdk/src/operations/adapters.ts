// The adapters (spec §12, the mapping table): every existing vocabulary — a journaled swap order and the tracker's
// OrderState, the executor's SwapJobState, a campaign and its tranches with the pause reasons — read into the one
// operation vocabulary with the catalog code a failure carries. Pure; the engines are untouched. V6 (spec v2.0 §12):
// the frozen states — a swap's source legs are EXECUTING, the destination's SETTLING — and a delay (a provider past its
// window, a congested chain, the velocity rule, a pause the user or the wallet asked for) is `delayed` on the phase's
// state, never a state of its own (I-O5).
import type { Campaign, CampaignState, PauseReason, TrancheState } from "@privacy-wallet/protocol/wallet/campaign";
import { SWAP_JOB_MAP, type Mapped } from "@privacy-wallet/protocol/wallet/settlement";
import type { OrderState, Tracked } from "../orderTracker";
import type { StoredSwap } from "../wallet/journal";

/** The executor's job state → the operation state: the table shared with the API (packages/protocol/src/wallet/settlement.ts). */
export { SWAP_JOB_MAP, type Mapped };

/** The tracker's OrderState (sdk/orderTracker.ts) → the operation state. */
export const ORDER_STATE_MAP: Record<OrderState, Mapped> = {
  COMMITTED: { state: "AWAITING_SIGNATURE", phase: "funding" },
  SOURCE_SUBMITTED: { state: "CONFIRMING", phase: "funding" },
  SOURCE_FINAL: { state: "EXECUTING", phase: "execution" },
  PROVIDER_EXECUTING: { state: "EXECUTING", phase: "execution" },
  DESTINATION_SUBMITTED: { state: "SETTLING", phase: "settlement" },
  DESTINATION_FINAL: { state: "SETTLING", phase: "settlement" },
  COMPLETED: { state: "COMPLETED", phase: "settlement" },
  PARTIAL: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" },
  REFUND_PENDING: { state: "REFUNDING", phase: "settlement" },
  PROVIDER_TIMEOUT: { state: "EXECUTING", phase: "execution", code: "provider_timeout", delayed: true },
  DESTINATION_FAILED: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "destination_failed" },
  REFUNDED: { state: "REFUNDED", phase: "settlement" },
  EXPIRED: { state: "QUOTE_EXPIRED", phase: "funding", code: "order_expired" },
  CANCELLED: { state: "CANCELLED", phase: "funding" },
  FAILED: { state: "RECOVERY_REQUIRED", phase: "execution", code: "needs_attention" },
};

/** A journaled order's own `state` (sdk/swapExecute.ts, swapFunding.ts) when the tracker has not read yet. */
export const STORED_SWAP_MAP: Record<string, Mapped> = {
  committed: { state: "AWAITING_SIGNATURE", phase: "funding" },
  funded: { state: "SUBMITTED", phase: "funding" },
  abandoned: { state: "CANCELLED", phase: "funding" },
  ...SWAP_JOB_MAP,
};

/** A tranche's state (reference campaign.ts) → the operation state; `failed` needs recovery either way (before the hand-over the send's outcome is unknown, I-O6). */
export function fromTranche(state: TrancheState, handedOver: boolean): Mapped {
  switch (state) {
    case "planned": case "ready": return { state: "REVIEW", phase: "funding" };
    case "committed": case "funded": return { state: "AWAITING_SIGNATURE", phase: "funding" };
    case "signed": return { state: "SIGNED", phase: "funding" };
    case "executing": return { state: "SUBMITTED", phase: "execution" };
    case "source-confirmed": return { state: "EXECUTING", phase: "execution" };
    case "destination-submitted": case "destination-confirmed": return { state: "SETTLING", phase: "settlement" };
    case "settled": return { state: "COMPLETED", phase: "settlement" };
    case "partial": return { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" };
    case "refunding": return { state: "REFUNDING", phase: "settlement" };
    case "refunded": return { state: "REFUNDED", phase: "settlement" };
    case "failed": return handedOver ? { state: "RECOVERY_REQUIRED", phase: "execution", code: "execute_failed" } : { state: "RECOVERY_REQUIRED", phase: "funding", code: "send_failed" };
    case "skipped": return { state: "CANCELLED", phase: "funding" };
  }
}

/** A campaign's pause reason → the operation state and its code. */
export const PAUSE_MAP: Record<PauseReason, Mapped> = {
  "price-deviation": { state: "QUOTE_EXPIRED", code: "price_deviation" },
  "provider-error": { state: "RECOVERY_REQUIRED", code: "provider_error" },
  "chain-congestion": { state: "EXECUTING", code: "chain_congestion", delayed: true },
  "route-degraded": { state: "RECOVERY_REQUIRED", code: "route_degraded" },
  "unexpected-destination": { state: "RECOVERY_REQUIRED", code: "unexpected_destination" },
  "security-incident": { state: "RECOVERY_REQUIRED", code: "security_incident" },
  anomaly: { state: "RECOVERY_REQUIRED", code: "anomaly" },
  reconcile: { state: "RECOVERY_REQUIRED", code: "reconcile" },
  bounds: { state: "QUOTE_EXPIRED", code: "bounds" },
  user: { state: "EXECUTING", code: "user_pause", delayed: true },
  "wallet-pause": { state: "EXECUTING", code: "wallet_pause", delayed: true },
  velocity: { state: "EXECUTING", code: "velocity", delayed: true },
};

const CAMPAIGN_MAP: Record<Exclude<CampaignState, "running" | "paused">, Mapped> = {
  "user-confirmed": { state: "AWAITING_SIGNATURE", phase: "funding" },
  "preparing-notes": { state: "AWAITING_SIGNATURE", phase: "funding" },
  reassessing: { state: "QUOTE_EXPIRED", phase: "execution", code: "price_deviation" },
  requoting: { state: "QUOTE_EXPIRED", phase: "execution", code: "quote_expired" },
  rerouting: { state: "QUOTE_EXPIRED", phase: "execution", code: "route_degraded" },
  "winding-down": { state: "REFUNDING", phase: "settlement" },
  completed: { state: "COMPLETED", phase: "settlement" },
  cancelled: { state: "CANCELLED", phase: "settlement" },
};

/** A campaign as one operation: running follows its furthest open step, a pause its reason. */
export function fromCampaign(c: Pick<Campaign, "state" | "tranches" | "pause">): Mapped {
  if (c.state === "paused") return c.pause ? { ...PAUSE_MAP[c.pause.reason], phase: "execution" } : { state: "RECOVERY_REQUIRED", phase: "execution", code: "reconcile" };
  if (c.state !== "running") return CAMPAIGN_MAP[c.state];
  const open = c.tranches.filter((t) => !["planned", "ready", "settled", "refunded", "skipped"].includes(t.state));
  if (!open.length) return { state: "SUBMITTED", phase: "execution" };
  const rank: TrancheState[] = ["committed", "funded", "signed", "executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial", "refunding", "failed"];
  const furthest = open.reduce((a, b) => (rank.indexOf(b.state) > rank.indexOf(a.state) ? b : a));
  const m = fromTranche(furthest.state, !!furthest.handedOverAt || !!furthest.jobId);
  return m.state === "REVIEW" || m.state === "AWAITING_SIGNATURE" || m.state === "SIGNED" ? { state: "SUBMITTED", phase: "execution" } : m; // I-O7: a running campaign was submitted
}

/** V6 Stage 11: an order the runner stopped before its hand-over → the operation state (spec v2.0 §12): a moved minimum waits as QUOTE_EXPIRED for the user's choice; the rest need a decision about the escrow. */
export const PAUSED_ORDER_MAP: Record<string, Mapped> = {
  minimum_moved: { state: "QUOTE_EXPIRED", phase: "execution", code: "minimum_moved" },
  execution_unavailable: { state: "RECOVERY_REQUIRED", phase: "execution", code: "execution_unavailable" },
  unsafe_contract_call: { state: "RECOVERY_REQUIRED", phase: "execution", code: "unsafe_contract_call" },
  reconcile: { state: "RECOVERY_REQUIRED", phase: "funding", code: "reconcile" },
  // "Delay for more privacy" (spec v2.0 §14.1): the older notes no longer covered the order — stopped, never funded
  older_notes_unavailable: { state: "CANCELLED", phase: "funding", code: "older_notes_unavailable" },
  // the relayer that would execute it does not run it (a V6 follow-up of 2026-10-16): stopped before anything was sent
  relayer_not_ready: { state: "CANCELLED", phase: "funding", code: "relayer_not_ready" },
  // a funding sent and never confirmed before the order's window closed: stopped, never sent again
  funding_unconfirmed: { state: "CANCELLED", phase: "funding", code: "funding_unconfirmed" },
  // the order's execution window closed: before its funding, stopped with nothing sent; after it and before the hand-over,
  // the escrow only refunds — the user returns the funds
  order_expired: { state: "CANCELLED", phase: "funding", code: "order_expired" },
  execution_window_closed: { state: "RECOVERY_REQUIRED", phase: "execution", code: "execution_window_closed" },
};

/** A journaled order with (or without) the tracker's last derivation. */
export function fromStoredSwap(s: Pick<StoredSwap, "state" | "fundedTx" | "jobId" | "executionTx" | "campaign" | "paused">, tracked: Pick<Tracked, "state"> | null): Mapped {
  if (s.paused && !s.jobId && PAUSED_ORDER_MAP[s.paused.code]) return PAUSED_ORDER_MAP[s.paused.code];
  if (tracked) return ORDER_STATE_MAP[tracked.state];
  const own = STORED_SWAP_MAP[s.state];
  if (own) return own;
  return s.fundedTx ? { state: "SUBMITTED", phase: "execution" } : { state: "AWAITING_SIGNATURE", phase: "funding" };
}
