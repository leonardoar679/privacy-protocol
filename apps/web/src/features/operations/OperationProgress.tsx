// The progress of an operation (spec §3.11, §12–§13): the timeline from the record's state, the §47 lines from its
// progress step (the prover runs in its worker; the main thread never blocks), the verdict card on a failure — the
// first sentence by funds class, the catalog's reason, the actions the caller offers — and the completed badge.
import type { ReactNode } from "react";
import { ErrorCard, ProgressIndicator, StatusBadge, TransactionTimeline, type StepState, type TimelineStep } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { isOpen, type OperationRecord, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { progressWords, stateWords, verdict } from "./recovery";

const SUBMITTED_OR_LATER: readonly OperationState[] = ["SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"];
const CONFIRMING: readonly OperationState[] = ["NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "RELAYER_EXECUTING", "NETWORK_DELAYED"];

export function timelineOf(rec: OperationRecord, t: ReturnType<typeof useT>): TimelineStep[] {
  const s = rec.state;
  const prepared: StepState = s === "AWAITING_SIGNATURE" ? "active" : s === "SIGNATURE_REJECTED" || s === "QUOTE_EXPIRED" ? "failed" : SUBMITTED_OR_LATER.includes(s) || s === "SIGNED" || s === "SUBMISSION_FAILED" ? "done" : "waiting";
  const submitted: StepState = SUBMITTED_OR_LATER.includes(s) ? "done" : s === "SUBMISSION_FAILED" ? "failed" : s === "SIGNED" ? "active" : "waiting";
  const confirming: StepState = s === "COMPLETED" || s === "REFUNDED" ? "done" : CONFIRMING.includes(s) ? "active" : s === "PROVIDER_FAILED" || s === "RECOVERY_REQUIRED" ? "failed" : s === "REFUNDING" ? "active" : "waiting";
  const completed: StepState = s === "COMPLETED" ? "done" : s === "REFUNDED" ? "done" : "waiting";
  return [
    { label: t("progress.stepPrepared"), state: prepared, ...(rec.progress && s === "AWAITING_SIGNATURE" ? { detail: progressWords(rec.progress, t) } : {}) },
    { label: t("progress.stepSubmitted"), state: submitted, ...(rec.refs.txHashes.length ? { detail: `${rec.refs.txHashes[rec.refs.txHashes.length - 1].slice(0, 10)}…` } : {}) },
    { label: t("progress.stepConfirming"), state: confirming, ...(s === "NETWORK_DELAYED" ? { detail: stateWords(s, t) } : {}) },
    { label: s === "REFUNDED" || s === "REFUNDING" ? t("progress.stepRefunded") : t("progress.stepCompleted"), state: completed },
  ];
}

/** The §3.11 headline for the step in progress. */
export function headlineOf(rec: OperationRecord, t: ReturnType<typeof useT>): string | null {
  if (!isOpen(rec.state)) return null;
  if (rec.state !== "AWAITING_SIGNATURE") return rec.state === "SUBMITTED" ? t("progress.submitted") : t("progress.confirming");
  const step = rec.progress?.step;
  if (!step) return t("progress.preparing");
  if (step === "witness" || step === "proof") return t("progress.proving");
  if (step === "submitting") return rec.kind === "protect" ? (rec.progress?.n && rec.progress.n > 1 ? t("progress.waitingWalletOf", { i: rec.progress.i ?? 1, n: rec.progress.n }) : t("progress.waitingWallet")) : t("progress.almost");
  if (step === "local-verify") return t("progress.almost");
  return t("progress.preparing");
}

export function OperationProgress({ record, actions, testId = "operation-progress" }: { record: OperationRecord; /** what a failure offers (the caller decides: back to the review, a new quote, the refund) */ actions?: ReactNode; testId?: string }) {
  const t = useT();
  const headline = headlineOf(record, t);
  const v = record.failure ? verdict(record, t) : null;
  return (
    <div className="ds-stack" data-testid={testId} data-state={record.state}>
      <TransactionTimeline steps={timelineOf(record, t)} />
      {headline ? <ProgressIndicator value={null} label={headline} testId={`${testId}-bar`} /> : null}
      {record.state === "COMPLETED" ? <StatusBadge tone="ok" testId={`${testId}-completed`}>{stateWords("COMPLETED", t)}</StatusBadge> : null}
      {v ? <ErrorCard title={v.title} fundsLine={v.headline} fundsState={v.fundsClass} reason={v.reason} actions={actions} testId={`${testId}-error`} /> : null}
    </div>
  );
}
