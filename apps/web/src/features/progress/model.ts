// The progress lines of an operation (spec v2.0 §7.7; doc §58): which of "Checking balance", "Calculating fees", "Securing
// your transaction", "Waiting for confirmation" the operation is on, read from its record — the engine's progress step
// before the submission, the state after it. The line only moves forward (`furthest`): the engine reads the relayer's
// terms before it syncs the notes, and a line already passed is never shown waiting again. Pure.
import type { StepState } from "@privacy-wallet/ui";
import { isTerminal, type OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import type { ProgressModel, ProgressStepKind } from "./View";

export const PROGRESS_LINES: readonly ProgressStepKind[] = ["balance", "fees", "securing", "confirmation"];

/** The line a record is on now. */
export function progressLineOf(rec: Pick<OperationRecord, "kind" | "state" | "progress">): ProgressStepKind {
  if (["SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED", "REFUNDING", "REFUNDED"].includes(rec.state)) return "confirmation";
  switch (rec.progress?.step) {
    case "fee-terms":
      return "fees";
    case "merging":
    case "syncing":
    case "verifying":
      return "balance";
    case "witness":
    case "proof":
    case "local-verify":
      return "securing";
    case "submitting":
      return rec.kind === "protect" ? "securing" : "confirmation"; // a protect's wallet prompts secure it; a send's submission waits
    default:
      return rec.kind === "protect" ? "securing" : "balance"; // a protect read the balance and the fee before its review
  }
}

/** The furthest line reached so far (monotone across the record's updates). */
export const furthestLine = (prev: number, rec: Pick<OperationRecord, "kind" | "state" | "progress">): number =>
  Math.max(prev, PROGRESS_LINES.indexOf(progressLineOf(rec)));

/** The view-model of the progress screen: every line before the furthest done, it active (failed when the operation stopped there), the rest waiting. */
export function progressModelOf(rec: Pick<OperationRecord, "kind" | "state" | "progress" | "reason" | "declined">, furthest: number): ProgressModel {
  const done = rec.state === "COMPLETED" || rec.state === "REFUNDED";
  const stopped =
    !done && (isTerminal(rec.state) || rec.state === "RECOVERY_REQUIRED" || (!!rec.declined && ["DRAFT", "QUOTING", "REVIEW"].includes(rec.state)));
  const at = Math.max(0, Math.min(furthest, PROGRESS_LINES.length - 1));
  const steps = PROGRESS_LINES.map((kind, i): { kind: ProgressStepKind; state: StepState } => ({
    kind,
    state: done || i < at ? "done" : i === at ? (stopped ? "failed" : "active") : "waiting",
  }));
  return { steps, fraction: done ? 1 : (at + 0.5) / PROGRESS_LINES.length, large: null };
}
