// The error catalog's data (Privacy Wallet Web spec §13; plan §38, §61): every code the relayer, its swap executor, the
// swap service, the wallet's own checks, the settlement tracker and the campaign can produce, with the class that decides
// the first sentence ("Your funds were not moved." / "Your funds are still protected." / "We are checking where your
// funds are.") and the actions offered — a retry is a new quote or a tracked resume, never a re-send. Pure (no imports
// but types), so the journal's upgrade can read it; ./catalog.ts adds `classify` over the wallet's error classes.
import type { FundsClass, OperationReason } from "../../wallet/operationRecord";
import type { RecoveryAction } from "../types";

/** A message key of the catalog (the app types it against its own catalog: apps/web/src/features/operations/index.ts). */
export type OpErrorKey = `op.error.${string}.title` | `op.error.${string}.reason`;

export type ErrorSource = "relayer" | "executor" | "service" | "wallet" | "tracker" | "campaign";
export interface CatalogRow {
  source: ErrorSource;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
}

export const CATALOG: Record<string, CatalogRow> = {
  bad_proof: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_public_inputs: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_payloads: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  wrong_domain: { source: "relayer", fundsClass: "not-moved", actions: ["check-settings", "new-quote"] },
  payload_hash_mismatch: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_fee: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_vault_not_accepted: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote", "check-settings"] },
  fee_note_mismatch: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_payload_unreadable: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_too_low: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_below_percent: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  nullifier_in_flight: { source: "relayer", fundsClass: "still-protected", actions: ["resume-tracking"] },
  // V6 Stage 15 (doc §75): the relayer has no job spending these notes — after a lost answer, the submission never reached it
  unknown_nullifier: { source: "relayer", fundsClass: "still-protected", actions: ["review"] },
  simulation_failed: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  send_failed: { source: "relayer", fundsClass: "unknown", actions: ["resume-tracking"] },
  too_large: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  rate_limited: { source: "relayer", fundsClass: "not-moved", actions: ["wait"] },
  unsupported_media_type: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  // a V6 follow-up of 2026-10-15: a body the relayer could not read as JSON; a service's own error, which says nothing of
  // itself (its words could carry an RPC's key) — its outcome unknown until the chain is read
  bad_json: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  internal: { source: "service", fundsClass: "unknown", actions: ["continue-monitoring"] },
  capacity: { source: "relayer", fundsClass: "not-moved", actions: ["wait"] },
  admin_closed: { source: "relayer", fundsClass: "not-moved", actions: ["wait", "check-settings"] },
  admin_token: { source: "relayer", fundsClass: "not-moved", actions: ["check-settings"] },
  bad_request: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_deadlines: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_execution: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_floors: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_payload: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_tokens: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_signature: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  refund_payload_mismatch: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  unsupported_asset: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  // V6 Stage 12 (spec v2.0 §11.2): the shield executor's refusals — at the hand-over, before the execution: the funds wait in the escrow
  unknown_factory: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_params: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_payload: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  payload_mismatch: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_deadline: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  receipt_conflict: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  no_vault: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  unknown_shield: { source: "executor", fundsClass: "still-protected", actions: ["resume-tracking"] },
  shield_unavailable: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  // a V6 follow-up of 2026-10-15: the swap executor serves one deployment's factory, and none without SWAP_FACTORY
  unknown_swap_factory: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  swap_unavailable: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_refund_vault: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  // a V6 follow-up of 2026-10-16 (audit gap 47): the relayer executes and refunds only what the API vouched for
  unvouched_order: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_shield_receipt: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  minimum_moved: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  price_guard: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  no_quote: { source: "service", fundsClass: "not-moved", actions: ["wait", "new-quote"] },
  route_filtered: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_provider: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_order: { source: "service", fundsClass: "still-protected", actions: ["resume-tracking", "start-refund"] },
  order_not_prepared: { source: "service", fundsClass: "still-protected", actions: ["new-quote"] },
  service_rejected: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  invalid_request: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  destination_not_protectable: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  // the API's 502: the provider failed or answered what the engine will not build on (whale spec §16); the wallet tries again
  provider_unavailable: { source: "service", fundsClass: "unknown", actions: ["continue-monitoring"] },
  user_rejected: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  wallet_disconnected: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  chain_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  rpc_disagreement: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings", "wait"] },
  transport_refused: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  order_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  provider_call_mismatch: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  guest_instruction_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  housekeeping_needed: { source: "wallet", fundsClass: "not-moved", actions: ["housekeeping"] },
  execution_unavailable: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  // spec v2.0 §14.1: an order to be funded from older notes that no longer cover it is stopped before anything is sent
  older_notes_unavailable: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // a V6 follow-up of 2026-10-16: the relayer that would execute the order does not run it, so it is stopped before funding
  relayer_not_ready: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings", "new-quote"] },
  // the order runner: a funding sent and never confirmed before the order's window closed (the notes unspent, or refunded)
  funding_unconfirmed: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote"] },
  // a record whose own flow is gone (operations/stale.ts): stopped before anything was sent, or its transaction dropped
  interrupted: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  transaction_dropped: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  unsafe_contract_call: { source: "wallet", fundsClass: "still-protected", actions: ["start-refund"] },
  // the order runner: a funded order whose execution window closed before its hand-over — the escrow only refunds now
  execution_window_closed: { source: "wallet", fundsClass: "still-protected", actions: ["start-refund"] },
  deployment_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  insufficient_balance: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
  wallet_insufficient_funds: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
  relayer_unreachable: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking", "check-settings"] },
  quote_expired: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  order_expired: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  receipt_reverted: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  deposit_not_found: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking"] },
  network_delayed: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  tracker_unknown: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring"] },
  provider_timeout: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring", "start-refund"] },
  destination_failed: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring", "start-refund"] },
  execute_failed: { source: "tracker", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  refund_failed: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring", "start-refund"] },
  partial_delivery: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  needs_attention: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring", "start-refund"] },
  price_deviation: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  provider_error: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  chain_congestion: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  route_degraded: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  unexpected_destination: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  security_incident: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  anomaly: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  reconcile: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  bounds: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  user_pause: { source: "campaign", fundsClass: "still-protected", actions: ["review"] },
  wallet_pause: { source: "campaign", fundsClass: "still-protected", actions: ["review"] },
  velocity: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  quote_ttl_short: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  provider_unhealthy: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote", "wait"] },
  slippage_too_wide: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
};

export const CODES: readonly string[] = Object.keys(CATALOG);
export const hasCode = (code: string): boolean => Object.prototype.hasOwnProperty.call(CATALOG, code);
export const titleKey = (code: string): OpErrorKey => (hasCode(code) ? `op.error.${code}.title` : "op.error.unknown.title");
export const reasonKey = (code: string): OpErrorKey => (hasCode(code) ? `op.error.${code}.reason` : "op.error.unknown.reason");

/**
 * I-O6 (spec v2.0 §12.3): FAILED is final, so it is only for funds that did not move or are still protected and a
 * failure that leaves nothing to track or return (no resume, monitoring or refund among the code's actions); anything
 * else needs recovery. An unknown code is `unknown`.
 */
export function failureTarget(r: Pick<OperationReason, "code" | "fundsClass">): "FAILED" | "RECOVERY_REQUIRED" {
  if (r.fundsClass === "unknown" || !hasCode(r.code)) return "RECOVERY_REQUIRED";
  return CATALOG[r.code].actions.some((a) => a === "resume-tracking" || a === "continue-monitoring" || a === "start-refund") ? "RECOVERY_REQUIRED" : "FAILED";
}
