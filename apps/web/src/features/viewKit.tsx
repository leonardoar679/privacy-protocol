// What the screens' Views share (spec v2.0 §7; doc §92): an amount as the engine holds it — base units with the asset's
// decimals — and the asset's display decimals from the registry, drawn through AmountText (never a raw base-unit
// string, never eighteen decimals), USD from integer cents, and the status vocabulary of the operation cards and rows.
// Views import this, the design system and the message catalog — never a store or the SDK (eslint enforces it).
import { AmountText, type Rounding, type StatusTone } from "@privacy-wallet/ui";
import type { MessageKey } from "../app/i18n/en";

export interface Amount {
  units: bigint;
  decimals: number;
  displayDecimals: number;
  symbol: string;
}

/** Money-like assets (two display decimals: the dollar stablecoins) keep both decimals of a fraction: "2,470.90". */
const padded = (a: Amount) => a.displayDecimals <= 2;

/** An amount; `bare` drops the symbol where the asset is already named beside it (a flow card's asset chip). */
export function Amt({
  a,
  approx,
  size,
  rounding,
  bare,
  testId,
}: {
  a: Amount;
  approx?: boolean;
  size?: "large" | "medium";
  rounding?: Rounding;
  bare?: boolean;
  testId?: string;
}) {
  return (
    <AmountText
      value={a.units}
      decimals={a.decimals}
      displayDecimals={a.displayDecimals}
      symbol={bare ? undefined : a.symbol}
      pad={padded(a)}
      approx={approx}
      size={size}
      rounding={rounding}
      testId={testId}
    />
  );
}

export function Usd({ cents, approx, size, testId }: { cents: bigint; approx?: boolean; size?: "large" | "medium"; testId?: string }) {
  return <AmountText usdCents={cents} approx={approx} size={size} testId={testId} />;
}

/** The states a person sees (spec §7.8): one word each, from the operation's state. */
export type Status =
  "preparing" | "executing" | "action-needed" | "completed" | "partial" | "other-token" | "refunded-at-destination" | "refunded" | "failed" | "cancelled";
export const STATUS_TONE: Record<Status, StatusTone> = {
  preparing: "pending",
  executing: "pending",
  "action-needed": "warn",
  completed: "ok",
  // a finished swap that is not the whole delivery (the tenth review round, A10-4): its chip had read "Completed" or "Returned"
  partial: "warn",
  "other-token": "warn",
  "refunded-at-destination": "warn",
  refunded: "neutral",
  failed: "danger",
  cancelled: "neutral",
};
export const STATUS_WORD: Record<Status, MessageKey> = {
  preparing: "operation.preparing",
  executing: "operation.executing",
  "action-needed": "operation.actionNeeded",
  completed: "operation.completed",
  partial: "operation.partial",
  "other-token": "operation.otherToken",
  "refunded-at-destination": "operation.refundedAtDestination",
  refunded: "operation.refunded",
  failed: "operation.failed",
  cancelled: "operation.cancelled",
};
