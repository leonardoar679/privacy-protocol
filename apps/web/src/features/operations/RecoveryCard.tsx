// The recovery screen (spec §3.12, §13; plan §38, §61): "Something needs attention", the first sentence by funds
// class, what did not complete, the three legs with their state, and the two options — Continue monitoring (the
// tracker keeps polling) or Start the refund / recovery process (a refund-only job through the executor, or the
// campaign's cancel) — never a blind Retry: a retry is a new quote or a tracked resume.
import { Button, Card, StatusBadge, TransactionTimeline, type StepState } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { isDraft, wasSubmitted, type OperationRecord, type SettlementState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { actionsFor, verdict } from "./recovery";

export interface RecoveryLegs { source: StepState; swap: StepState; destination: StepState }

/** V6 (spec v2.0 §12.4): the legs from where the money is, when the tracker read it. */
const BY_SETTLEMENT: Record<SettlementState, RecoveryLegs> = {
  SOURCE_CONFIRMED: { source: "done", swap: "active", destination: "waiting" },
  PROVIDER_PENDING: { source: "done", swap: "active", destination: "waiting" },
  DESTINATION_PENDING: { source: "done", swap: "done", destination: "active" },
  REFUND_AVAILABLE: { source: "done", swap: "failed", destination: "waiting" },
  REFUNDING: { source: "done", swap: "waiting", destination: "waiting" },
  COMPLETED: { source: "done", swap: "done", destination: "done" },
};

/** The three legs from the settlement, else from the record's state (a swap order; a send has the source leg only). */
export function legsOf(rec: OperationRecord): RecoveryLegs {
  const s = rec.state;
  if (rec.settlement && !(rec.settlement === "COMPLETED" && (s === "REFUNDED" || s === "REFUNDING"))) return BY_SETTLEMENT[rec.settlement];
  const sourceDone = wasSubmitted(rec) || s === "COMPLETED" || s === "REFUNDED" || (s === "RECOVERY_REQUIRED" && rec.refs.txHashes.length > 0);
  const swap: StepState = s === "COMPLETED" || s === "SETTLING" ? "done" : s === "RECOVERY_REQUIRED" ? "failed" : s === "EXECUTING" ? "active" : "waiting";
  const destination: StepState = s === "COMPLETED" ? "done" : s === "SETTLING" ? "active" : "waiting";
  return { source: sourceDone ? "done" : s === "FAILED" || (!!rec.declined && isDraft(s)) ? "failed" : "active", swap, destination };
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
