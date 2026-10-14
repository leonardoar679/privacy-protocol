// The recovery model's words (spec §13; plan §38, §61): the words of a state, the verdict of a failed or delayed operation —
// the first sentence from the funds class, the catalog's title and reason, the actions — and the rule that nothing is
// ever re-sent: a retry is a new quote, a tracked resume, a refund through the executor or the campaign's cancel. The
// logic (which actions, which class) is the SDK's: packages/sdk/src/operations/recovery.ts (V6 Stage 4).
// I-O5: "Transaction failed" belongs to FAILED alone; a delay (an attribute, V6) or a pending settlement has its own words.
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { isTerminal, type FundsClass, type OperationRecord, type OperationState, type ProgressStep } from "@privacy-wallet/sdk/wallet/operationRecord";
import { reasonKey, titleKey } from "@privacy-wallet/sdk/operations/errors/codes"; // the keys only: the catalog's classifier reaches the swap modules (V6 Stage 16)
import { diagnose } from "@privacy-wallet/sdk/operations/recovery";
import { FUNDS_HEADLINE_KEY, type RecoveryAction } from "@privacy-wallet/sdk/operations/types";

export { actionsFor, canRefund, needsAttention } from "@privacy-wallet/sdk/operations/recovery";

export type T = (key: MessageKey, vars?: Vars) => string;

export const stateKey = (state: OperationState): MessageKey => `op.state.${state}` as MessageKey;
export const stateWords = (state: OperationState, t: T): string => t(stateKey(state));
/** V6: a record's own words — its state's, or the delay's while the phase takes longer (I-O5: never "failed"). */
export const recordWords = (rec: Pick<OperationRecord, "state" | "delayed">, t: T): string => (rec.delayed && !isTerminal(rec.state) ? t("op.delayed") : stateWords(rec.state, t));
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

export function verdict(rec: OperationRecord, t: T): Verdict {
  const { code, fundsClass, actions, tracking } = diagnose(rec);
  const trackingKey: Record<NonNullable<OperationRecord["recovery"]>["state"], MessageKey> = {
    monitoring: "op.recovery.monitoring", "refund-offered": "op.recovery.refundOffered", refunding: "op.recovery.refunding", refunded: "op.recovery.refunded", resolved: "op.recovery.resolved",
  };
  return {
    headline: fundsHeadline(fundsClass, t),
    title: t(titleKey(code) as MessageKey),
    reason: t(reasonKey(code) as MessageKey),
    fundsClass,
    actions,
    ...(tracking ? { tracking: t(trackingKey[tracking]) } : {}),
    neverResend: t("op.recovery.neverResend"),
  };
}
