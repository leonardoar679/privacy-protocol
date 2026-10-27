// The adapters (spec §12, the mapping table): every existing vocabulary — a journaled swap order and the tracker's
// OrderState, the executor's SwapJobState, a campaign and its tranches with the pause reasons — read into the one
// operation vocabulary with the catalog code a failure carries. Pure; the engines are untouched. V6 (spec v2.0 §12):
// the frozen states — V7 (spec v3.0 §6): a swap's funding is SOURCE_CONFIRMING, its source legs PROVIDER_EXECUTING, the
// destination's DESTINATION_CONFIRMING — and a delay (a provider past its
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
  COMMITTED: { state: "AWAITING_AUTHORIZATION", phase: "funding" },
  SOURCE_SUBMITTED: { state: "SOURCE_CONFIRMING", phase: "funding" },
  SOURCE_FINAL: { state: "PROVIDER_EXECUTING", phase: "execution" },
  PROVIDER_EXECUTING: { state: "PROVIDER_EXECUTING", phase: "execution" },
  DESTINATION_SUBMITTED: { state: "DESTINATION_CONFIRMING", phase: "settlement" },
  DESTINATION_FINAL: { state: "DESTINATION_CONFIRMING", phase: "settlement" },
  COMPLETED: { state: "COMPLETED", phase: "settlement" },
  PARTIAL: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" },
  REFUND_PENDING: { state: "REFUNDING", phase: "settlement" },
  PROVIDER_TIMEOUT: { state: "PROVIDER_EXECUTING", phase: "execution", code: "provider_timeout", delayed: true },
  DESTINATION_FAILED: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "destination_failed" },
  REFUNDED: { state: "REFUNDED", phase: "settlement" },
  EXPIRED: { state: "RECOVERY_REQUIRED", phase: "funding", code: "order_expired" }, // V7: the escrow holds the funds until its refund time
  CANCELLED: { state: "CANCELLED", phase: "funding" },
  FAILED: { state: "RECOVERY_REQUIRED", phase: "execution", code: "needs_attention" },
  LATE_REFUND: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "late_refund" },
};

/** A journaled order's own `state` (sdk/swapExecute.ts, swapFunding.ts) when the tracker has not read yet. */
export const STORED_SWAP_MAP: Record<string, Mapped> = {
  committed: { state: "AWAITING_AUTHORIZATION", phase: "funding" },
  funded: { state: "SOURCE_CONFIRMING", phase: "funding" },
  abandoned: { state: "CANCELLED", phase: "funding" },
  ...SWAP_JOB_MAP,
};

/** A tranche's state (reference campaign.ts) → the operation state; `failed` needs recovery either way (before the hand-over the send's outcome is unknown, I-O6). */
export function fromTranche(state: TrancheState, handedOver: boolean): Mapped {
  switch (state) {
    case "planned":
    case "ready":
      return { state: "READY_TO_REVIEW", phase: "funding" };
    case "committed":
    case "funded":
      return { state: "AWAITING_AUTHORIZATION", phase: "funding" };
    case "signed":
      return { state: "SUBMITTING", phase: "funding" };
    case "executing":
      return { state: "SOURCE_CONFIRMING", phase: "execution" };
    case "source-confirmed":
      return { state: "PROVIDER_EXECUTING", phase: "execution" };
    case "destination-submitted":
    case "destination-confirmed":
      return { state: "DESTINATION_CONFIRMING", phase: "settlement" };
    case "settled":
      return { state: "COMPLETED", phase: "settlement" };
    case "partial":
      return { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" };
    case "refunding":
      return { state: "REFUNDING", phase: "settlement" };
    case "refunded":
      return { state: "REFUNDED", phase: "settlement" };
    case "failed":
      return handedOver
        ? { state: "RECOVERY_REQUIRED", phase: "execution", code: "execute_failed" }
        : { state: "RECOVERY_REQUIRED", phase: "funding", code: "send_failed" };
    case "skipped":
      return { state: "CANCELLED", phase: "funding" };
  }
}

/** A campaign's pause reason → the operation state and its code. */
export const PAUSE_MAP: Record<PauseReason, Mapped> = {
  "price-deviation": { state: "RECOVERY_REQUIRED", code: "price_deviation" },
  "provider-error": { state: "RECOVERY_REQUIRED", code: "provider_error" },
  "chain-congestion": { state: "PROVIDER_EXECUTING", code: "chain_congestion", delayed: true },
  "route-degraded": { state: "RECOVERY_REQUIRED", code: "route_degraded" },
  "unexpected-destination": { state: "RECOVERY_REQUIRED", code: "unexpected_destination" },
  "security-incident": { state: "RECOVERY_REQUIRED", code: "security_incident" },
  anomaly: { state: "RECOVERY_REQUIRED", code: "anomaly" },
  reconcile: { state: "RECOVERY_REQUIRED", code: "reconcile" },
  bounds: { state: "RECOVERY_REQUIRED", code: "bounds" },
  user: { state: "PROVIDER_EXECUTING", code: "user_pause", delayed: true },
  "wallet-pause": { state: "PROVIDER_EXECUTING", code: "wallet_pause", delayed: true },
  velocity: { state: "PROVIDER_EXECUTING", code: "velocity", delayed: true },
};

const CAMPAIGN_MAP: Record<Exclude<CampaignState, "running" | "paused">, Mapped> = {
  "user-confirmed": { state: "AWAITING_AUTHORIZATION", phase: "funding" },
  "preparing-notes": { state: "AWAITING_AUTHORIZATION", phase: "funding" },
  reassessing: { state: "RECOVERY_REQUIRED", phase: "execution", code: "price_deviation" },
  requoting: { state: "RECOVERY_REQUIRED", phase: "execution", code: "quote_expired" },
  rerouting: { state: "RECOVERY_REQUIRED", phase: "execution", code: "route_degraded" },
  "winding-down": { state: "REFUNDING", phase: "settlement" },
  completed: { state: "COMPLETED", phase: "settlement" },
  cancelled: { state: "CANCELLED", phase: "settlement" },
};

/** A campaign as one operation: running follows its furthest open step, a pause its reason. */
export function fromCampaign(c: Pick<Campaign, "state" | "tranches" | "pause">): Mapped {
  if (c.state === "paused")
    return c.pause ? { ...PAUSE_MAP[c.pause.reason], phase: "execution" } : { state: "RECOVERY_REQUIRED", phase: "execution", code: "reconcile" };
  if (c.state !== "running") return CAMPAIGN_MAP[c.state];
  const open = c.tranches.filter((t) => !["planned", "ready", "settled", "refunded", "skipped"].includes(t.state));
  if (!open.length) return { state: "SOURCE_CONFIRMING", phase: "execution" };
  const rank: TrancheState[] = [
    "committed",
    "funded",
    "signed",
    "executing",
    "source-confirmed",
    "destination-submitted",
    "destination-confirmed",
    "partial",
    "refunding",
    "failed",
  ];
  const furthest = open.reduce((a, b) => (rank.indexOf(b.state) > rank.indexOf(a.state) ? b : a));
  const m = fromTranche(furthest.state, !!furthest.handedOverAt || !!furthest.jobId);
  return m.state === "READY_TO_REVIEW" || m.state === "AWAITING_AUTHORIZATION" || m.state === "SUBMITTING"
    ? { state: "SOURCE_CONFIRMING", phase: "execution" }
    : m; // I-O7: a running campaign was submitted
}

/** V6 Stage 11: an order the runner stopped before its hand-over → the operation state (spec v2.0 §12): a moved minimum waits as RECOVERY_REQUIRED (V7, spec v3.0 §6) for the user's choice; the rest need a decision about the escrow. */
export const PAUSED_ORDER_MAP: Record<string, Mapped> = {
  minimum_moved: { state: "RECOVERY_REQUIRED", phase: "execution", code: "minimum_moved" },
  execution_unavailable: { state: "RECOVERY_REQUIRED", phase: "execution", code: "execution_unavailable" },
  unsafe_contract_call: { state: "RECOVERY_REQUIRED", phase: "execution", code: "unsafe_contract_call" },
  reconcile: { state: "RECOVERY_REQUIRED", phase: "funding", code: "reconcile" },
  // "Delay for more privacy" (spec v2.0 §14.1): the older notes no longer covered the order — stopped, never funded
  older_notes_unavailable: { state: "CANCELLED", phase: "funding", code: "older_notes_unavailable" },
  // the relayer that would execute it does not run it (a V6 follow-up of 2026-10-16): stopped before anything was sent
  relayer_not_ready: { state: "CANCELLED", phase: "funding", code: "relayer_not_ready" },
  // the swap service no longer takes the key the order was confirmed under (a V6 follow-up of 2026-10-16): stopped unfunded
  service_key_changed: { state: "CANCELLED", phase: "funding", code: "service_key_changed" },
  // an older build committed it under the privacy address's owner commitment (the audit round of 2026-10-16, c18): never funded
  order_outdated: { state: "CANCELLED", phase: "funding", code: "order_outdated" },
  // the relayer's fee is more than the Review showed (the audit round of 2026-10-16, c46): never funded at that fee
  fee_moved: { state: "CANCELLED", phase: "funding", code: "fee_moved" },
  // its executor tip no longer pays its execution at today's gas price (audit round 2, p04): never funded to wait it out
  tip_stale: { state: "CANCELLED", phase: "funding", code: "tip_stale" },
  // a funding sent and never confirmed before the order's window closed: stopped, never sent again
  funding_unconfirmed: { state: "CANCELLED", phase: "funding", code: "funding_unconfirmed" },
  // the order's execution window closed: before its funding, stopped with nothing sent; after it and before the hand-over,
  // the escrow only refunds — the user returns the funds
  order_expired: { state: "CANCELLED", phase: "funding", code: "order_expired" },
  execution_window_closed: { state: "RECOVERY_REQUIRED", phase: "execution", code: "execution_window_closed" },
};

/** A journaled order with (or without) the tracker's last derivation. */
export function fromStoredSwap(
  s: Pick<StoredSwap, "state" | "fundedTx" | "jobId" | "executionTx" | "campaign" | "paused">,
  tracked: Pick<Tracked, "state"> | null,
): Mapped {
  if (s.paused && !s.jobId && PAUSED_ORDER_MAP[s.paused.code]) return PAUSED_ORDER_MAP[s.paused.code];
  if (tracked) return ORDER_STATE_MAP[tracked.state];
  const own = STORED_SWAP_MAP[s.state];
  if (own) return own;
  return s.fundedTx ? { state: "SOURCE_CONFIRMING", phase: "execution" } : { state: "AWAITING_AUTHORIZATION", phase: "funding" };
}
