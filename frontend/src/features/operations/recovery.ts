// The recovery model (spec §13; plan §38, §61): the words of a state, the verdict of a failed or delayed operation —
// the first sentence from the funds class, the catalog's title and reason, the actions — and the rule that nothing is
// ever re-sent: a retry is a new quote, a tracked resume, a refund through the executor or the campaign's cancel.
// I-O5: "Transaction failed" belongs to SUBMISSION_FAILED alone; a delayed network or a pending settlement has its own words.
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { isDraft, isOpen, isTerminal, type FundsClass, type OperationRecord, type OperationState, type ProgressStep } from "../../wallet/operationRecord";
import { CATALOG, hasCode, reasonKey, titleKey } from "./errors/catalog";
import { FUNDS_HEADLINE_KEY, type RecoveryAction } from "./types";

export type T = (key: MessageKey, vars?: Vars) => string;

export const stateKey = (state: OperationState): MessageKey => `op.state.${state}` as MessageKey;
export const stateWords = (state: OperationState, t: T): string => t(stateKey(state));
export const progressWords = (p: { step: ProgressStep; i?: number; n?: number }, t: T): string => t(`op.progress.${p.step}` as MessageKey, { i: p.i ?? 1, n: p.n ?? 1 });
export const actionWords = (a: RecoveryAction, t: T): string => t(`op.action.${a}` as MessageKey);
export const fundsHeadline = (c: FundsClass, t: T): string => t(FUNDS_HEADLINE_KEY[c]);

export interface Verdict {
  /** the first sentence, by funds class */
  headline: string;
  title: string;
  reason: string;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
  /** the recovery's own line, when tracking is on */
  tracking?: string;
  /** the standing rule, for the screen's footnote */
  neverResend: string;
}

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
    if (a === "edit" || a === "review" || a === "new-quote") return isDraft(rec.state) || rec.state === "QUOTE_EXPIRED" || rec.state === "SIGNATURE_REJECTED" || rec.state === "SUBMISSION_FAILED" || rec.state === "PROVIDER_FAILED" || rec.state === "RECOVERY_REQUIRED";
    return true;
  });
  // a failure after the signature always keeps the monitoring open (the funds may still arrive)
  if (isOpen(rec.state) && rec.failure && !out.includes("continue-monitoring")) out.push("continue-monitoring");
  return out;
}

export function verdict(rec: OperationRecord, t: T): Verdict {
  const code = rec.failure?.code && hasCode(rec.failure.code) ? rec.failure.code : "unknown";
  const fundsClass = rec.failure?.class ?? CATALOG[code].fundsClass;
  const trackingKey: Record<NonNullable<OperationRecord["recovery"]>["state"], MessageKey> = {
    monitoring: "op.recovery.monitoring", "refund-offered": "op.recovery.refundOffered", refunding: "op.recovery.refunding", refunded: "op.recovery.refunded", resolved: "op.recovery.resolved",
  };
  return {
    headline: fundsHeadline(fundsClass, t),
    title: t(titleKey(code)),
    reason: t(reasonKey(code)),
    fundsClass,
    actions: actionsFor(rec),
    ...(rec.recovery ? { tracking: t(trackingKey[rec.recovery.state]) } : {}),
    neverResend: t("op.recovery.neverResend"),
  };
}

/** The attention states of the Activity list and the Home's running line: a failure, a delay or an open recovery. */
export const needsAttention = (rec: OperationRecord): boolean => rec.state === "RECOVERY_REQUIRED" || rec.state === "PROVIDER_FAILED" || rec.state === "NETWORK_DELAYED" || (rec.recovery?.state === "refund-offered");
