// The progress of an operation (spec §3.11, §12–§13): the timeline from the record's state, the §47 lines from its
// progress step (the prover runs in its worker; the main thread never blocks), the verdict card on a failure — the
// first sentence by funds class, the catalog's reason, the actions the caller offers — and the completed badge.
import type { ReactNode } from "react";
import { ErrorCard, ProgressIndicator, StatusBadge, TransactionTimeline, type StepState, type TimelineStep } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { isDraft, isOpen, wasSent, type OperationRecord, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { progressWords, stateWords, verdict } from "./recovery";
import { AttemptLine, attemptIdOf } from "./AttemptLine";

const UNDER_WAY: readonly OperationState[] = ["SOURCE_CONFIRMING", "PROVIDER_EXECUTING", "DESTINATION_CONFIRMING", "REFUNDING"];

export function timelineOf(rec: OperationRecord, t: ReturnType<typeof useT>): TimelineStep[] {
  const s = rec.state;
  // V6: submitted once a hash is known or the record is past the send (SUBMITTING is the send in progress: the step stays
  // active — the review round of 2026-11-02); a declined prompt leaves a draft
  const sent = wasSent(rec);
  const declined = !!rec.declined && isDraft(s);
  const expired = s === "READY_TO_REVIEW" && rec.reason?.code === "quote_expired"; // V7: the quote expired before the funding
  const prepared: StepState =
    s === "AWAITING_AUTHORIZATION" || s === "PREPARING_PROOF" ? "active" : declined || (expired && !sent) ? "failed" : sent || s === "SUBMITTING" || s === "FAILED" || s === "RECOVERY_REQUIRED" ? "done" : "waiting";
  const submitted: StepState = sent ? "done" : s === "FAILED" ? "failed" : s === "SUBMITTING" ? "active" : "waiting";
  const confirming: StepState = s === "COMPLETED" || s === "REFUNDED" ? "done" : UNDER_WAY.includes(s) ? "active" : s === "RECOVERY_REQUIRED" || (s === "FAILED" && sent) ? "failed" : "waiting";
  const completed: StepState = s === "COMPLETED" ? "done" : s === "REFUNDED" ? "done" : "waiting";
  return [
    { label: t("progress.stepPrepared"), state: prepared, ...(rec.progress && (s === "AWAITING_AUTHORIZATION" || s === "PREPARING_PROOF") ? { detail: progressWords(rec.progress, t) } : {}) },
    { label: t("progress.stepSubmitted"), state: submitted, ...(rec.refs.txHashes.length ? { detail: `${rec.refs.txHashes[rec.refs.txHashes.length - 1].slice(0, 10)}…` } : {}) },
    { label: t("progress.stepConfirming"), state: confirming, ...(rec.delayed ? { detail: t("op.delayed") } : {}) },
    { label: s === "REFUNDED" || s === "REFUNDING" ? t("progress.stepRefunded") : t("progress.stepCompleted"), state: completed },
  ];
}

/** The §3.11 headline for the step in progress. */
export function headlineOf(rec: OperationRecord, t: ReturnType<typeof useT>): string | null {
  if (!isOpen(rec.state)) return null;
  if (rec.state === "SUBMITTING" && rec.progress?.step !== "submitting") return t("progress.submitted");
  if (rec.state !== "AWAITING_AUTHORIZATION" && rec.state !== "PREPARING_PROOF" && rec.state !== "SUBMITTING") return t("progress.confirming");
  const step = rec.progress?.step;
  if (!step) return t("progress.preparing");
  if (step === "witness" || step === "proof") return t("progress.proving");
  // the connected wallet's prompt: a Protect's, or a spend's that it submits (no relayer kept); the relayer path is "almost ready"
  if (step === "submitting") return rec.kind === "protect" || !rec.refs.relayerUrl ? (rec.progress?.n && rec.progress.n > 1 ? t("progress.waitingWalletOf", { i: rec.progress.i ?? 1, n: rec.progress.n }) : t("progress.waitingWallet")) : t("progress.almost");
  if (step === "local-verify") return t("progress.almost");
  return t("progress.preparing");
}

export function OperationProgress({ record, actions, testId = "operation-progress" }: { record: OperationRecord; /** what a failure offers (the caller decides: back to the review, a new quote, the refund) */ actions?: ReactNode; testId?: string }) {
  const t = useT();
  const headline = headlineOf(record, t);
  // V6: a failure's reason, a declined prompt or a delay has its verdict card
  const v = record.reason || record.delayed || (record.declined && isDraft(record.state)) ? verdict(record, t) : null;
  return (
    <div className="ds-stack" data-testid={testId} data-state={record.state} data-code={record.reason?.code}>
      <TransactionTimeline steps={timelineOf(record, t)} />
      {headline ? <ProgressIndicator value={null} label={headline} testId={`${testId}-bar`} /> : null}
      {record.state === "COMPLETED" ? <StatusBadge tone="ok" testId={`${testId}-completed`}>{stateWords("COMPLETED", t)}</StatusBadge> : null}
      {v ? <ErrorCard title={v.title} fundsLine={v.headline} fundsState={v.fundsClass} reason={v.reason} actions={actions} testId={`${testId}-error`} /> : null}
      <AttemptLine orderId={attemptIdOf(record)} testId={`${testId}-attempt`} />
    </div>
  );
}
