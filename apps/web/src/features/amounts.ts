// The models' side of an amount (spec v2.0 §7, §9): the display decimals from the asset registry, USD in integer cents
// from a feed's 8-decimal price — bigint all the way, so a View never receives a float or a raw string.
import { ASSETS } from "@privacy-wallet/config";
import { formatAmount } from "@privacy-wallet/ui";
import type { Amount, Status } from "./viewKit";
import { isDraft, wasSubmitted, type OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { needsAttention } from "@privacy-wallet/sdk/operations/recovery";
import type { MessageKey } from "../app/i18n/en";
import type { Vars } from "../app/i18n/messages";

/** An amount of `symbol` in base units, with the registry's display decimals (the pool's chain first). */
export function amountOf(units: bigint, symbol: string, decimals: number, chain = "ethereum"): Amount {
  const a = ASSETS.find((x) => x.symbol === symbol && x.chain === chain) ?? ASSETS.find((x) => x.symbol === symbol);
  return { units, decimals, symbol, displayDecimals: a ? Math.min(a.displayDecimals, decimals) : Math.min(decimals, 6) };
}

/** A decimal string of base units (the journal's form) as an amount; a malformed one is zero. */
export function amountFrom(units: string | undefined, symbol: string, decimals: number, chain?: string): Amount {
  let v = 0n;
  try {
    v = BigInt(units ?? "0");
  } catch {
    v = 0n;
  }
  return amountOf(v, symbol, decimals, chain);
}

/** An amount's number as a sentence carries it — "4,950", "2,470.90", "0.989": the Amt component's rules (display decimals, grouping, a stablecoin's cents kept). */
export const displayAmount = (a: Amount): string =>
  formatAmount(a.units, { decimals: a.decimals, displayDecimals: a.displayDecimals, pad: a.displayDecimals <= 2 });

/** USD cents of `units` at an 8-decimal price (round down: a value is never overstated). */
export const centsOf = (units: bigint, decimals: number, usd1e8: bigint): bigint => (units * usd1e8) / 10n ** BigInt(decimals) / 10n ** 6n;

/** The word a person reads for an operation's state (spec §7.8). */
export function statusOf(r: OperationRecord): Status {
  switch (r.state) {
    case "COMPLETED":
      return "completed";
    case "REFUNDED":
      return "refunded";
    case "CANCELLED":
      return "cancelled";
    case "FAILED":
      return "failed";
    case "QUOTE_EXPIRED": // V6: a submitted swap whose quote moved waits for the user's choice
      return wasSubmitted(r) ? "action-needed" : "failed";
    case "DRAFT":
    case "QUOTING":
    case "REVIEW":
    case "AWAITING_SIGNATURE":
      return r.declined && isDraft(r.state) ? "cancelled" : "preparing"; // the user declined: nothing moved, nothing failed
    default:
      return needsAttention(r) ? "action-needed" : "executing";
  }
}

/** An activity line's journal status as the word a person reads (spec §7.8; never a bare failure for a funded order). */
export function activityStatus(kind: string, status: string): Status {
  if (["completed", "settled"].includes(status)) return "completed";
  if (["refunded", "returned"].includes(status)) return kind === "campaign" ? "completed" : "refunded";
  if (["failed"].includes(status)) return "failed";
  if (["abandoned", "cancelled"].includes(status)) return "cancelled";
  if (["execute-failed", "refund-failed", "paused", "reassessing"].includes(status)) return "action-needed";
  if (["committed", "waiting-funding", "pending", "user-confirmed", "preparing-notes"].includes(status))
    return kind === "swap" || kind === "campaign" ? "preparing" : "executing";
  return "executing";
}

/** The arrow of a swap's note ("→ BTC · step") or the record's output, for a title "ETH → BTC". */
export const targetOf = (note: string | undefined, output?: string): string | null => output ?? /→\s*([A-Za-z0-9.]+)/.exec(note ?? "")?.[1] ?? null;

/** The words of an operation's or a line's title (spec §7.8): "ETH → BTC", "Private Send", "Protected USDC". */
export function titleOf(kind: string, asset: string, target: string | null, t: (key: MessageKey, vars?: Vars) => string): string {
  if (kind === "shield" || kind === "protect") return t("operation.title.protected", { asset });
  if (kind === "transfer" || kind === "send" || kind === "withdraw") return t("operation.title.send");
  if (kind === "refund") return t("operation.title.refund");
  if (kind === "classic-deposit" || kind === "classic-withdraw") return t("operation.title.classic");
  return target ? `${asset} → ${target}` : t("operation.title.swap", { asset });
}
