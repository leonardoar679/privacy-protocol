// The adapters (spec §12, the mapping table): every existing vocabulary — a journaled swap order and the tracker's
// OrderState, the executor's SwapJobState, a campaign and its tranches with the pause reasons — read into the one
// operation vocabulary with the catalog code a failure carries. Pure; the engines are untouched.
import type { Campaign, CampaignState, PauseReason, TrancheState } from "@privacy-wallet/protocol/wallet/campaign";
import type { OrderState, Tracked } from "../../sdk/orderTracker";
import type { SwapJobState } from "../../sdk/relayer";
import type { StoredSwap } from "../../wallet/journal";
import type { OperationPhase, OperationState } from "../../wallet/operationRecord";

export interface Mapped { state: OperationState; phase?: OperationPhase; code?: string }

/** The tracker's OrderState (sdk/orderTracker.ts) → the operation state. */
export const ORDER_STATE_MAP: Record<OrderState, Mapped> = {
  COMMITTED: { state: "AWAITING_SIGNATURE", phase: "funding" },
  SOURCE_SUBMITTED: { state: "NETWORK_CONFIRMING", phase: "funding" },
  SOURCE_FINAL: { state: "NETWORK_CONFIRMING", phase: "execution" },
  PROVIDER_EXECUTING: { state: "NETWORK_CONFIRMING", phase: "execution" },
  DESTINATION_SUBMITTED: { state: "SETTLEMENT_VERIFYING", phase: "settlement" },
  DESTINATION_FINAL: { state: "SETTLEMENT_VERIFYING", phase: "settlement" },
  COMPLETED: { state: "COMPLETED", phase: "settlement" },
  PARTIAL: { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" },
  REFUND_PENDING: { state: "REFUNDING", phase: "settlement" },
  PROVIDER_TIMEOUT: { state: "NETWORK_DELAYED", phase: "execution", code: "provider_timeout" },
  DESTINATION_FAILED: { state: "PROVIDER_FAILED", phase: "settlement", code: "destination_failed" },
  REFUNDED: { state: "REFUNDED", phase: "settlement" },
  EXPIRED: { state: "QUOTE_EXPIRED", phase: "funding", code: "order_expired" },
  CANCELLED: { state: "CANCELLED", phase: "funding" },
  FAILED: { state: "RECOVERY_REQUIRED", phase: "execution", code: "needs_attention" },
};

/** The executor's job state (sdk/relayer.ts) → the operation state. */
export const SWAP_JOB_MAP: Record<SwapJobState, Mapped> = {
  "waiting-funding": { state: "SUBMITTED", phase: "funding" },
  executing: { state: "RELAYER_EXECUTING", phase: "execution" },
  executed: { state: "NETWORK_CONFIRMING", phase: "execution" },
  completed: { state: "COMPLETED", phase: "settlement" },
  expired: { state: "REFUNDING", phase: "settlement" },
  "refund-only": { state: "REFUNDING", phase: "settlement" },
  refunding: { state: "REFUNDING", phase: "settlement" },
  refunded: { state: "REFUNDED", phase: "settlement" },
  "execute-failed": { state: "PROVIDER_FAILED", phase: "execution", code: "execute_failed" },
  "refund-failed": { state: "RECOVERY_REQUIRED", phase: "settlement", code: "refund_failed" },
};

/** A journaled order's own `state` (sdk/swapExecute.ts, swapFunding.ts) when the tracker has not read yet. */
export const STORED_SWAP_MAP: Record<string, Mapped> = {
  committed: { state: "AWAITING_SIGNATURE", phase: "funding" },
  funded: { state: "AWAITING_SIGNATURE", phase: "funding" },
  abandoned: { state: "CANCELLED", phase: "funding" },
  ...SWAP_JOB_MAP,
};

/** A tranche's state (reference campaign.ts) → the operation state; `failed` before a hand-over is a submission failure, after it a provider failure. */
export function fromTranche(state: TrancheState, handedOver: boolean): Mapped {
  switch (state) {
    case "planned": case "ready": return { state: "QUOTE_READY", phase: "funding" };
    case "committed": case "funded": return { state: "AWAITING_SIGNATURE", phase: "funding" };
    case "signed": return { state: "SIGNED", phase: "funding" };
    case "executing": return { state: "SUBMITTED", phase: "execution" };
    case "source-confirmed": return { state: "NETWORK_CONFIRMING", phase: "execution" };
    case "destination-submitted": case "destination-confirmed": return { state: "SETTLEMENT_VERIFYING", phase: "settlement" };
    case "settled": return { state: "COMPLETED", phase: "settlement" };
    case "partial": return { state: "RECOVERY_REQUIRED", phase: "settlement", code: "partial_delivery" };
    case "refunding": return { state: "REFUNDING", phase: "settlement" };
    case "refunded": return { state: "REFUNDED", phase: "settlement" };
    case "failed": return handedOver ? { state: "PROVIDER_FAILED", phase: "execution", code: "execute_failed" } : { state: "SUBMISSION_FAILED", phase: "funding", code: "send_failed" };
    case "skipped": return { state: "CANCELLED", phase: "funding" };
  }
}

/** A campaign's pause reason → the operation state and its code. */
export const PAUSE_MAP: Record<PauseReason, Mapped> = {
  "price-deviation": { state: "QUOTE_EXPIRED", code: "price_deviation" },
  "provider-error": { state: "PROVIDER_FAILED", code: "provider_error" },
  "chain-congestion": { state: "NETWORK_DELAYED", code: "chain_congestion" },
  "route-degraded": { state: "PROVIDER_FAILED", code: "route_degraded" },
  "unexpected-destination": { state: "RECOVERY_REQUIRED", code: "unexpected_destination" },
  "security-incident": { state: "PROVIDER_FAILED", code: "security_incident" },
  anomaly: { state: "RECOVERY_REQUIRED", code: "anomaly" },
  reconcile: { state: "RECOVERY_REQUIRED", code: "reconcile" },
  bounds: { state: "QUOTE_EXPIRED", code: "bounds" },
  user: { state: "SIGNATURE_REJECTED", code: "user_pause" },
  "wallet-pause": { state: "SIGNATURE_REJECTED", code: "wallet_pause" },
  velocity: { state: "NETWORK_DELAYED", code: "velocity" },
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
  return m.state === "QUOTE_READY" || m.state === "AWAITING_SIGNATURE" || m.state === "SIGNED" ? { state: "SUBMITTED", phase: "execution" } : m;
}

/** A journaled order with (or without) the tracker's last derivation. */
export function fromStoredSwap(s: Pick<StoredSwap, "state" | "fundedTx" | "jobId" | "executionTx" | "campaign">, tracked: Pick<Tracked, "state"> | null): Mapped {
  if (tracked) return ORDER_STATE_MAP[tracked.state];
  const own = STORED_SWAP_MAP[s.state];
  if (own) return own;
  return s.fundedTx ? { state: "SUBMITTED", phase: "execution" } : { state: "AWAITING_SIGNATURE", phase: "funding" };
}
