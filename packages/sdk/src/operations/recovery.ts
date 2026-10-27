// The recovery model's logic (spec §13; plan §38, §61; V6 Stage 4 — the words stay with the app,
// apps/web/src/features/operations/recovery.ts): what a failed or delayed operation offers, decided by the catalog and
// the record alone. Nothing is ever re-sent: a retry is a new quote, a tracked resume, a refund through the executor or
// the campaign's cancel. V6 (spec v2.0 §12.4): the record's `reason` (or a declined prompt) names the code; the
// settlement decides whether a refund is possible (the escrow still holds the money) and a FAILED record — final —
// offers only a fresh start.
import { CATALOG, hasCode } from "./errors/codes";
import {
  isDraft,
  isOpen,
  isTerminal,
  wasSubmitted,
  type FundsClass,
  type OperationRecord,
  type RecoveryState,
  type SettlementState,
} from "../wallet/operationRecord";
import type { RecoveryAction } from "./types";

/** Where the escrow still holds the money (spec v2.0 §12.4): a refund-only job can return it. */
const REFUNDABLE: readonly SettlementState[] = ["SOURCE_CONFIRMED", "REFUND_AVAILABLE"];

/**
 * Whether a refund through the executor (an order) or the campaign's cancel can be offered for this record: an open
 * swap whose settlement says the escrow holds the money (without a settlement read yet, the screen's own check decides).
 */
export const canRefund = (rec: OperationRecord): boolean =>
  (rec.kind === "swap" || rec.kind === "cross-chain") &&
  (!!rec.refs.orderId || !!rec.refs.campaignId) &&
  !isDraft(rec.state) &&
  !isTerminal(rec.state) &&
  (rec.settlement === undefined || REFUNDABLE.includes(rec.settlement));

/** The code a record's recovery reads: its reason, else a declined prompt's, else none. */
const codeOf = (rec: OperationRecord): string | null => {
  const c = rec.reason?.code ?? rec.declined?.code ?? rec.delayed?.code;
  return c && hasCode(c) ? c : null;
};

/** The actions a record can offer now: the catalog's, filtered by what the record is. */
export function actionsFor(rec: OperationRecord): RecoveryAction[] {
  // V6: FAILED is final — the funds did not move or are still protected; what is left is a fresh start
  if (rec.state === "FAILED") {
    const code = codeOf(rec);
    const fresh = (code ? CATALOG[code].actions : []).filter(
      (a) => a === "edit" || a === "review" || a === "new-quote" || a === "check-wallet" || a === "check-settings" || a === "housekeeping" || a === "wait",
    );
    return fresh.length ? fresh : ["new-quote"];
  }
  if (isTerminal(rec.state)) return [];
  const code = codeOf(rec);
  const base: RecoveryAction[] = code ? [...CATALOG[code].actions] : isOpen(rec.state) ? ["continue-monitoring"] : ["review"];
  const out = base.filter((a) => {
    if (a === "start-refund") return canRefund(rec);
    if (a === "continue-monitoring" || a === "resume-tracking") return isOpen(rec.state);
    // a fresh start before anything was submitted, or for a submitted swap the price or the route stopped
    if (a === "edit" || a === "review" || a === "new-quote")
      return isDraft(rec.state) || rec.state === "RECOVERY_REQUIRED" || (!!rec.declined && !wasSubmitted(rec));
    return true;
  });
  // a failure after the signature always keeps the monitoring open (the funds may still arrive)
  if (isOpen(rec.state) && (rec.reason || rec.delayed) && !out.includes("continue-monitoring")) out.push("continue-monitoring");
  return out;
}

/**
 * The attention states of the Activity list and the Home's running line: a recovery, a delay, an offered refund, or a
 * submitted swap whose quote moved (the user chooses: the new minimum or the money back).
 */
export const needsAttention = (rec: OperationRecord): boolean =>
  !isTerminal(rec.state) && (rec.state === "RECOVERY_REQUIRED" || !!rec.delayed || rec.recovery?.state === "refund-offered");

/** A record's recovery without words: the catalog code ("unknown" when it has none), the class of its funds, the actions it
 *  offers now and the state of a recovery under way. The app turns it into sentences. */
export interface Diagnosis {
  code: string;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
  tracking?: RecoveryState;
}

export function diagnose(rec: OperationRecord): Diagnosis {
  const code = codeOf(rec) ?? "unknown";
  return {
    code,
    fundsClass: rec.reason?.fundsClass ?? CATALOG[code].fundsClass,
    actions: actionsFor(rec),
    ...(rec.recovery ? { tracking: rec.recovery.state } : {}),
  };
}
