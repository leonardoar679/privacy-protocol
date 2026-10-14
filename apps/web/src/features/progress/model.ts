// The progress lines of an operation (spec v2.0 §7.7; doc §58): which of "Checking balance", "Calculating fees", "Securing
// your transaction", "Waiting for confirmation" the operation is on, read from its record — the engine's progress step
// before the submission, the state after it. The line only moves forward (`furthest`): the engine reads the relayer's
// terms before it syncs the notes, and a line already passed is never shown waiting again. V6 Stage 13 (spec v2.0 §7.7,
// §13.5): a protected execution shows amounts — completed, executing, remaining — never a step count. Pure.
import type { StepState } from "@privacy-wallet/ui";
import { exposure, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
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

/**
 * A protected execution's progress (doc §50): "$80,000 ETH → BTC / Protected execution / Completed $20,000 / Executing
 * $20,000 / Remaining $40,000" — the dollars at the confirmation's valuation, shared out by the steps' amounts (what is
 * funded or handed over counts as executing) — and the line of the step in hand: securing while a step is funded and not
 * yet handed over, waiting for confirmation once anything is executing or done. Without a valuation, the lines alone.
 */
export function campaignProgressModel(c: Campaign): ProgressModel {
  const e = exposure(c);
  const done = c.state === "completed" || c.state === "cancelled";
  const usd = c.value && typeof c.value === "object" && "usd" in c.value ? (c.value as { usd: number }).usd : null;
  const totalCents = usd !== null ? BigInt(Math.round(usd * 100)) : null;
  const cents = (u: bigint) => (totalCents !== null && e.total > 0n ? (totalCents * u) / e.total : 0n);
  const executing = e.inFlight + e.prepared;
  const at = done ? PROGRESS_LINES.length : e.completed > 0n || e.inFlight > 0n ? 3 : e.prepared > 0n ? 2 : 1;
  const steps = PROGRESS_LINES.map((kind, i): { kind: ProgressStepKind; state: StepState } => ({
    kind,
    state: done || i < at ? "done" : i === at ? "active" : "waiting",
  }));
  const large =
    totalCents !== null
      ? {
          title: `${c.request.from.symbol} → ${c.request.to.symbol}`,
          totalUsdCents: totalCents,
          completedUsdCents: cents(e.completed),
          executingUsdCents: cents(executing),
          // the rest of the dollars: the three lines always add up to the total
          remainingUsdCents: totalCents - cents(e.completed) - cents(executing),
        }
      : null;
  return { steps, fraction: done ? 1 : e.total > 0n ? Number(((e.completed * 2n + executing) * 1000n) / (e.total * 2n)) / 1000 : 0, large };
}
