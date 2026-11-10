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

export interface Classified {
  code: string;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
  detail: string;
}

const SERVICE_MESSAGES: [RegExp, string][] = [
  [/^no quote/i, "no_quote"],
  [/route filtered/i, "route_filtered"],
  [/unknown provider/i, "unknown_provider"],
  [/unknown order/i, "unknown_order"],
  [/not prepared/i, "order_not_prepared"],
  [/price guard|price_guard/i, "price_guard"],
  [/minimum moved|guarantees at least/i, "minimum_moved"],
];
/**
 * Rows read from any message — the wallet's own errors, a string, and a wallet app's own `{code, message}` answer, whose message had not been
 * read at all (the twelfth review round, B12-5: WalletConnect's getSdkError("USER_REJECTED"), the plain `{message: "User rejected.", code:
 * 5000}`, had read `unknown`) —, in this order (W6 §2).
 */
const ANY_MESSAGES: [RegExp, string][] = [
  // WalletConnect's own texts: its request expiry when a copy lost its code (the sign client's createDelayedPromise), and a session gone
  [/^request expired\. please try again/i, "wallet_request_expired"],
  [/no injected wallet/i, "wallet_disconnected"], // a Protect confirmed with no wallet to pay (the review round of 2026-11-03, W4): not moved, never "unknown"
  // a WalletConnect provider whose session the wallet app ended asks nothing: its request throws this before anything is sent (the eleventh
  // review round, slice 6c's critique) — not moved, never "unknown"; so does one whose session the sign client no longer holds (B12-2): gone,
  // past its expiry before its expirer ran (isValidSessionTopic), or deleted a moment ago (checkRecentlyDeleted) — the sign client's own
  // texts, their code dropped, each thrown before the request is published
  [/please call connect\(\) before request\(\)|session topic does(n't| not) exist|no matching key|^expired\. session topic|record was recently deleted - session/i, "wallet_disconnected"],
  // the funds before the refusal: "rejected: insufficient funds" reads as its remedy
  [/insufficient shielded balance/i, "insufficient_balance"],
  [/insufficient funds|doesn't have enough funds|exceeds (the )?balance/i, "wallet_insufficient_funds"],
  // the refusal in the words wallets answer it with, on a generic code (B12-5)
  [/user rejected|rejected the (request|transaction)|request rejected|user denied|denied (the )?(transaction|request)|declined|user cancel+ed/i, "user_rejected"],
  [/spread over \d+ notes|needs a private merge/i, "housekeeping_needed"],
  [/commitment was not found in the receipt/i, "deposit_not_found"],
];
/**
 * Rows read only from the wallet's own errors and its transports' — an Error or a string, never a wallet app's plain answer: its "execution
 * reverted" is its own simulation (nothing mined, no fee — receipt_reverted says the network mined it), its "Failed to fetch" its own node (a
 * Protect asks no relayer), its "Transaction expired" its own (no quote). Read so, they read `unknown`, the class the stale mover settles (W6 §2).
 */
const OWN_MESSAGES: [RegExp, string][] = [
  [/reverted/i, "receipt_reverted"],
  [/unreachable|failed to fetch|fetch failed|networkerror|ECONNREFUSED|load failed/i, "relayer_unreachable"],
  // the quote's own texts — the catch-all /expired/ had read WalletConnect's request expiry as a quote's (A12-2, B12-5)
  [/quote (has |is )?expired|expired quote/i, "quote_expired"],
];

/** The catalog row of a thrown error (the wallet's classes by instance, EIP-1193 and WalletConnect by code, the services by code or message). */
export function classify(e: unknown): Classified {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  const detail = typeof e === "string" ? e : typeof message === "string" ? message : "";
  const row = (code: string): Classified => ({ code, fundsClass: CATALOG[code].fundsClass, actions: CATALOG[code].actions, detail });
  if (e instanceof RelayerRefusal)
    return row(e.code && hasCode(e.code) ? e.code : e.status === 429 ? "rate_limited" : e.status === 503 ? "capacity" : "service_rejected");
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
    // EIP-1193, and WalletConnect's own (getSdkError): the user's refusal — 5000–5003, and 5101–5104, refused before anything was sent —,
    // the network (5100: unsupported chains); the sign client's request expiry by its shape
    if (code === 4001 || (code >= 5000 && code <= 5003) || (code >= 5101 && code <= 5104)) return row("user_rejected");
    if (code === 4900 || code === 4901) return row("wallet_disconnected");
    if (code === 4902 || code === 5100) return row("chain_mismatch");
    if (code === 6 && /request expired/i.test(detail)) return row("wallet_request_expired");
    // the wallet app ended the session while the request was open (6000, USER_DISCONNECTED): at its wc_sessionDelete the sign client rejects
    // so every request it had published (onSessionDeleteRequest → cleanupPendingSentRequestsForTopic, its one caller), whether the wallet app
    // had sent it or not — never "nothing was sent" (the twelfth review round, the critique of B12-5). This page's own disconnect and the
    // session's expiry reject nothing: a request open then waits for its fifteen minutes and reads wallet_request_expired
    if (code === 6000) return row("wallet_session_ended");
  }
  if (typeof code === "string" && hasCode(code)) return row(code);
  for (const [re, c] of SERVICE_MESSAGES) if (re.test(detail)) return row(c);
  for (const [re, c] of ANY_MESSAGES) if (re.test(detail)) return row(c);
  if (e instanceof Error || typeof e === "string") for (const [re, c] of OWN_MESSAGES) if (re.test(detail)) return row(c);
  return row("unknown");
}
