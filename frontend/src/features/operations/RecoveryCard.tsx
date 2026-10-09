// The recovery screen (spec §3.12, §13; plan §38, §61): "Something needs attention", the first sentence by funds
// class, what did not complete, the three legs with their state, and the two options — Continue monitoring (the
// tracker keeps polling) or Start the refund / recovery process (a refund-only job through the executor, or the
// campaign's cancel) — never a blind Retry: a retry is a new quote or a tracked resume.
import { Button, Card, StatusBadge, TransactionTimeline, type StepState } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { OperationRecord } from "../../wallet/operationRecord";
import { actionsFor, verdict } from "./recovery";

export interface RecoveryLegs { source: StepState; swap: StepState; destination: StepState }

/** The three legs from the record's state (a swap order; a send has the source leg only). */
export function legsOf(rec: OperationRecord): RecoveryLegs {
  const s = rec.state;
  const sourceDone = ["SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"].includes(s);
  const swap: StepState = s === "COMPLETED" || s === "SETTLEMENT_VERIFYING" ? "done" : s === "NETWORK_DELAYED" ? "failed" : s === "PROVIDER_FAILED" || s === "RECOVERY_REQUIRED" ? "failed" : s === "RELAYER_EXECUTING" || s === "NETWORK_CONFIRMING" ? "active" : s === "REFUNDING" || s === "REFUNDED" ? "waiting" : "waiting";
  const destination: StepState = s === "COMPLETED" ? "done" : s === "SETTLEMENT_VERIFYING" ? "active" : "waiting";
  return { source: sourceDone ? "done" : s === "SUBMISSION_FAILED" || s === "SIGNATURE_REJECTED" ? "failed" : "active", swap, destination };
}

export function Recovery({ record, onMonitor, onRefund, onNewQuote, onReview, testId = "recovery" }: { record: OperationRecord; onMonitor?: () => void; onRefund?: () => void; onNewQuote?: () => void; onReview?: () => void; testId?: string }) {
  const t = useT();
  const v = verdict(record, t);
  const legs = legsOf(record);
  const actions = actionsFor(record);
  const offerRefund = actions.includes("start-refund") && !!onRefund;
  const offerMonitor = actions.includes("continue-monitoring") && !!onMonitor;
  return (
    <Card testId={testId}>
      <div className="ds-stack-sm" data-state={record.state} data-funds={v.fundsClass}>
        <h2 className="ds-review-title">{t("recovery.title")}</h2>
        <StatusBadge tone={v.fundsClass === "not-moved" ? "ok" : v.fundsClass === "still-protected" ? "ok" : "warn"} testId={`${testId}-funds`}>{v.fundsClass === "still-protected" ? t("recovery.fundsSafe") : v.headline}</StatusBadge>
        <p className="ds-note">{v.title}. {v.reason}</p>
        <TransactionTimeline steps={[{ label: t("recovery.legSource"), state: legs.source }, { label: t("recovery.legSwap"), state: legs.swap }, { label: t("recovery.legDestination"), state: legs.destination }]} testId={`${testId}-legs`} />
        {v.tracking ? <p className="ds-note" data-testid={`${testId}-tracking`}>{v.tracking}</p> : null}
        <p className="ds-note">{t("recovery.options")}</p>
        <div className="ds-actions">
          {offerMonitor ? <Button variant="secondary" onClick={onMonitor} data-testid={`${testId}-monitor`}>{t("op.action.continue-monitoring")}</Button> : null}
          {offerRefund ? <Button onClick={onRefund} data-testid={`${testId}-refund`}>{t("op.action.start-refund")}</Button> : null}
          {actions.includes("new-quote") && onNewQuote ? <Button variant="secondary" onClick={onNewQuote} data-testid={`${testId}-new-quote`}>{t("op.action.new-quote")}</Button> : null}
          {actions.includes("review") && onReview ? <Button variant="secondary" onClick={onReview} data-testid={`${testId}-review`}>{t("op.action.review")}</Button> : null}
        </div>
        <p className="ds-note">{v.neverResend}</p>
      </div>
    </Card>
  );
}
