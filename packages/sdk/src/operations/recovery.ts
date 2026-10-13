// The recovery model's logic (spec §13; plan §38, §61; V6 Stage 4 — the words stay with the app,
// apps/web/src/features/operations/recovery.ts): what a failed or delayed operation offers, decided by the catalog and
// the record alone. Nothing is ever re-sent: a retry is a new quote, a tracked resume, a refund through the executor or
// the campaign's cancel.
import { isDraft, isOpen, isTerminal, type FundsClass, type OperationRecord, type RecoveryState } from "../wallet/operationRecord";
import { CATALOG, hasCode } from "./errors/catalog";
import type { RecoveryAction } from "./types";

/** Whether a refund through the executor (an order) or the campaign's cancel can be offered for this record. */
export const canRefund = (rec: OperationRecord): boolean =>
  (rec.kind === "swap" || rec.kind === "cross-chain") && (!!rec.refs.orderId || !!rec.refs.campaignId) && !isDraft(rec.state) && !isTerminal(rec.state);

/** The actions a record can offer now: the catalog's, filtered by what the record is. */
export function actionsFor(rec: OperationRecord): RecoveryAction[] {
  if (isTerminal(rec.state)) return [];
  const code = rec.failure?.code && hasCode(rec.failure.code) ? rec.failure.code : null;
  const base: RecoveryAction[] = code ? [...CATALOG[code].actions] : isOpen(rec.state) ? ["continue-monitoring"] : ["review"];
  const out = base.filter((a) => {
    if (a === "start-refund") return canRefund(rec);
    if (a === "continue-monitoring" || a === "resume-tracking") return isOpen(rec.state);
    if (a === "edit" || a === "review" || a === "new-quote")
      return (
        isDraft(rec.state) ||
        rec.state === "QUOTE_EXPIRED" ||
        rec.state === "SIGNATURE_REJECTED" ||
        rec.state === "SUBMISSION_FAILED" ||
        rec.state === "PROVIDER_FAILED" ||
        rec.state === "RECOVERY_REQUIRED"
      );
    return true;
  });
  // a failure after the signature always keeps the monitoring open (the funds may still arrive)
  if (isOpen(rec.state) && rec.failure && !out.includes("continue-monitoring")) out.push("continue-monitoring");
  return out;
}

/** The attention states of the Activity list and the Home's running line: a failure, a delay or an open recovery. */
export const needsAttention = (rec: OperationRecord): boolean =>
  rec.state === "RECOVERY_REQUIRED" || rec.state === "PROVIDER_FAILED" || rec.state === "NETWORK_DELAYED" || rec.recovery?.state === "refund-offered";

/** A record's recovery without words: the catalog code ("unknown" when it has none), the class of its funds, the actions it
 *  offers now and the state of a recovery under way. The app turns it into sentences. */
export interface Diagnosis {
  code: string;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
  tracking?: RecoveryState;
}

export function diagnose(rec: OperationRecord): Diagnosis {
  const code = rec.failure?.code && hasCode(rec.failure.code) ? rec.failure.code : "unknown";
  return {
    code,
    fundsClass: rec.failure?.class ?? CATALOG[code].fundsClass,
    actions: actionsFor(rec),
    ...(rec.recovery ? { tracking: rec.recovery.state } : {}),
  };
}
