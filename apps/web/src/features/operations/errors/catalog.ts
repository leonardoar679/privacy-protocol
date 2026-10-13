// The error catalog (Privacy Wallet Web spec §13; plan §38, §61): every code the relayer, its swap executor, the swap
// service, the wallet's own checks, the settlement tracker and the campaign can produce, with the class that decides
// the first sentence ("Your funds were not moved." / "Your funds are still protected." / "We are checking where your
// funds are.") and the actions offered — a retry is a new quote or a tracked resume, never a re-send. The words live
// in the message catalog as op.error.<code>.title / .reason; apps/web/test/operations/catalog.test.ts scans the
// relayer's and the service's sources and fails on a code without a row.
import { TransportRefusal } from "../../../api/transport";
import { RpcDisagreement } from "../../../sdk/chain";
import { GuestInstructionMismatch } from "../../../sdk/guestGuard";
import { MinimumMoved, ProviderCallMismatch } from "../../../sdk/providerCall";
import { RelayerRefusal } from "../../../sdk/relayer";
import { OrderMismatch } from "../../../sdk/swapGuard";
import { ServiceMinimumMoved } from "../../../sdk/swapService";
import type { MessageKey } from "../../../app/i18n/en";
import type { FundsClass } from "../../../wallet/operationRecord";
import type { RecoveryAction } from "../types";

export type ErrorSource = "relayer" | "executor" | "service" | "wallet" | "tracker" | "campaign";
export interface CatalogRow { source: ErrorSource; fundsClass: FundsClass; actions: RecoveryAction[] }

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
  simulation_failed: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  send_failed: { source: "relayer", fundsClass: "unknown", actions: ["resume-tracking"] },
  too_large: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  rate_limited: { source: "relayer", fundsClass: "not-moved", actions: ["wait"] },
  unsupported_media_type: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
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
  minimum_moved: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  price_guard: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  no_quote: { source: "service", fundsClass: "not-moved", actions: ["wait", "new-quote"] },
  route_filtered: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_provider: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_order: { source: "service", fundsClass: "still-protected", actions: ["resume-tracking", "start-refund"] },
  order_not_prepared: { source: "service", fundsClass: "still-protected", actions: ["new-quote"] },
  service_rejected: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  user_rejected: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  wallet_disconnected: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  chain_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  rpc_disagreement: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings", "wait"] },
  transport_refused: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  order_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  provider_call_mismatch: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  guest_instruction_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  housekeeping_needed: { source: "wallet", fundsClass: "not-moved", actions: ["housekeeping"] },
  insufficient_balance: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
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
export const titleKey = (code: string): MessageKey => (hasCode(code) ? `op.error.${code}.title` : "op.error.unknown.title") as MessageKey;
export const reasonKey = (code: string): MessageKey => (hasCode(code) ? `op.error.${code}.reason` : "op.error.unknown.reason") as MessageKey;

export interface Classified { code: string; fundsClass: FundsClass; actions: RecoveryAction[]; detail: string }

const SERVICE_MESSAGES: [RegExp, string][] = [
  [/^no quote/i, "no_quote"], [/route filtered/i, "route_filtered"], [/unknown provider/i, "unknown_provider"], [/unknown order/i, "unknown_order"],
  [/not prepared/i, "order_not_prepared"], [/price guard|price_guard/i, "price_guard"], [/minimum moved|guarantees at least/i, "minimum_moved"],
];
const WALLET_MESSAGES: [RegExp, string][] = [
  [/insufficient shielded balance/i, "insufficient_balance"], [/spread over \d+ notes/i, "housekeeping_needed"], [/commitment was not found in the receipt/i, "deposit_not_found"],
  [/reverted/i, "receipt_reverted"], [/unreachable|failed to fetch|fetch failed|networkerror|ECONNREFUSED|load failed/i, "relayer_unreachable"], [/expired/i, "quote_expired"],
];

/** The catalog row of a thrown error (the wallet's classes by instance, EIP-1193 by code, the services by code or message). */
export function classify(e: unknown): Classified {
  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const row = (code: string): Classified => ({ code, fundsClass: CATALOG[code].fundsClass, actions: CATALOG[code].actions, detail });
  if (e instanceof RelayerRefusal) return row(e.code && hasCode(e.code) ? e.code : e.status === 429 ? "rate_limited" : e.status === 503 ? "capacity" : "service_rejected");
  if (e instanceof ServiceMinimumMoved || e instanceof MinimumMoved) return row("minimum_moved");
  if (e instanceof RpcDisagreement) return row("rpc_disagreement");
  if (e instanceof TransportRefusal) return row("transport_refused");
  if (e instanceof OrderMismatch) return row("order_mismatch");
  if (e instanceof GuestInstructionMismatch) return row("guest_instruction_mismatch");
  if (e instanceof ProviderCallMismatch) return row("provider_call_mismatch");
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "number") {
    if (code === 4001) return row("user_rejected");
    if (code === 4900 || code === 4901) return row("wallet_disconnected");
    if (code === 4902) return row("chain_mismatch");
  }
  if (typeof code === "string" && hasCode(code)) return row(code);
  for (const [re, c] of SERVICE_MESSAGES) if (re.test(detail)) return row(c);
  for (const [re, c] of WALLET_MESSAGES) if (re.test(detail)) return row(c);
  return row("unknown");
}
