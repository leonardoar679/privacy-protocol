import type { SettlementLabel } from "@privacy-wallet/sdk/orderTracker";
import type { MessageKey } from "../app/i18n/en";

/**
 * The tracker's settlement label (its English code, journaled with the track as a string) in the reader's words (audit round 2,
 * n86); every label the tracker writes has its words, a label it does not know is shown as it is.
 */
export const SETTLEMENT_WORDS: Record<string, MessageKey | undefined> = {
  Preparing: "settlement.preparing",
  "Waiting for source": "settlement.waitingSource",
  Executing: "settlement.executing",
  "Waiting for destination": "settlement.waitingDestination",
  Partial: "settlement.partial",
  Refunding: "settlement.refunding",
  Refunded: "settlement.refunded",
  Completed: "settlement.completed",
  "Not started": "settlement.notStarted",
  "Needs attention": "settlement.needsAttention",
} satisfies Record<SettlementLabel, MessageKey>;

/** The four steps of plan §60 in the reader's words, in the tracker's order (`STEPS`; the eleventh review round: English on every screen). */
export const SETTLEMENT_STEP_WORDS = [
  "settlement.step.quoteLocked",
  "settlement.step.sourceConfirmed",
  "settlement.step.destinationSent",
  "settlement.step.destinationFinalized",
] as const satisfies readonly MessageKey[];
