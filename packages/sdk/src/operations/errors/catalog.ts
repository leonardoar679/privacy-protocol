// The error catalog (Privacy Wallet Web spec §13; plan §38, §61): the codes and their rows (./codes.ts, pure data) and
// `classify`, which reads a thrown error into a row — the wallet's classes by instance, EIP-1193 by code, the services
// by code or message. The words live in the message catalog as op.error.<code>.title / .reason;
// apps/web/test/operations/catalog.test.ts scans the relayer's and the service's sources and fails on a code without a row.
import { TransportRefusal } from "@privacy-wallet/privacy-engine/transport/http";
import { RpcDisagreement } from "../../chain";
import { GuestInstructionMismatch } from "../../guestGuard";
import { MinimumMoved, ProviderCallMismatch, ProviderCallUnverified } from "../../providerCall";
import { RelayerRefusal, RelayerTimeout } from "../../relayer";
import { OrderMismatch } from "../../swapGuard";
import { ServiceMinimumMoved } from "../../swapService";
import type { FundsClass } from "../../wallet/operationRecord";
import type { RecoveryAction } from "../types";
import { CATALOG, hasCode } from "./codes";

export { CATALOG, CODES, failureTarget, hasCode, reasonKey, titleKey, type CatalogRow, type ErrorSource, type OpErrorKey } from "./codes";

export interface Classified { code: string; fundsClass: FundsClass; actions: RecoveryAction[]; detail: string }

const SERVICE_MESSAGES: [RegExp, string][] = [
  [/^no quote/i, "no_quote"], [/route filtered/i, "route_filtered"], [/unknown provider/i, "unknown_provider"], [/unknown order/i, "unknown_order"],
  [/not prepared/i, "order_not_prepared"], [/price guard|price_guard/i, "price_guard"], [/minimum moved|guarantees at least/i, "minimum_moved"],
];
const WALLET_MESSAGES: [RegExp, string][] = [
  [/insufficient shielded balance/i, "insufficient_balance"], [/insufficient funds|doesn't have enough funds|exceeds (the )?balance/i, "wallet_insufficient_funds"], [/spread over \d+ notes|needs a private merge/i, "housekeeping_needed"], [/commitment was not found in the receipt/i, "deposit_not_found"],
  [/reverted/i, "receipt_reverted"], [/unreachable|failed to fetch|fetch failed|networkerror|ECONNREFUSED|load failed/i, "relayer_unreachable"], [/expired/i, "quote_expired"],
];

/** The catalog row of a thrown error (the wallet's classes by instance, EIP-1193 by code, the services by code or message). */
export function classify(e: unknown): Classified {
  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const row = (code: string): Classified => ({ code, fundsClass: CATALOG[code].fundsClass, actions: CATALOG[code].actions, detail });
  if (e instanceof RelayerRefusal) return row(e.code && hasCode(e.code) ? e.code : e.status === 429 ? "rate_limited" : e.status === 503 ? "capacity" : "service_rejected");
  if (e instanceof RelayerTimeout) return row("relayer_unreachable"); // a lost answer: the chain and the relayer's job are read before anything is sent again
  if (e instanceof ServiceMinimumMoved || e instanceof MinimumMoved) return row("minimum_moved");
  if (e instanceof RpcDisagreement) return row("rpc_disagreement");
  if (e instanceof TransportRefusal) return row("transport_refused");
  if (e instanceof OrderMismatch) return row("order_mismatch");
  if (e instanceof GuestInstructionMismatch) return row("guest_instruction_mismatch");
  if (e instanceof ProviderCallMismatch) return row("provider_call_mismatch");
  if (e instanceof ProviderCallUnverified) return row("provider_unavailable"); // an outage: nothing signed, tried again
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
