// An order's closed states, the readings that close it and what its refund notes say (the twelfth review round): in a module that imports no
// reader, so the records they serve (operations/swapRecords.ts, which Home and Activity load) never pull the order tracker's chain readers into
// Home's chunks (the performance budget, scripts/check-budget.mjs: Home at most 80 KB beyond the first route).
import { lateRefundHeld } from "@privacy-wallet/protocol/wallet/settlement";
import type { OrderState } from "./orderTracker";
import type { StoredSwap } from "./wallet/journal";

/**
 * The readings that close an order (or are its closed state's own): a closed order's other readings never replace them (C12-3's critique) — but
 * a late refund, which reopens a closed order whose record is not terminal (gap 91's Return funds: journaled, the order journaled executed again and
 * an order tick planned unless it is a campaign's).
 */
export const CLOSING_READINGS: readonly OrderState[] = [
  "COMPLETED",
  "PARTIAL",
  "REFUNDED",
  "REFUNDED_AT_DESTINATION",
  "PROVIDER_FAILED",
  "EXPIRED",
  "CANCELLED",
];

/** The journal's closed states of an order (swapFunding.ts CLOSED_STATES, which imports the tracker; apps/web platform/connectivity.ts keeps its own). */
export const SWAP_CLOSED_STATES: readonly string[] = ["completed", "refunded", "abandoned", "lapsed"];

/**
 * Whether the refund notes found for an order say its escrow came back (the twelfth review round, XG's critique): more than dust together in its own
 * refund vault (lateRefundHeld: 1 % of the order), or a note in one of its refund tokens' vaults at that token's floor. A note is a vault deposit
 * anyone holding the order's payload can make, and a stranger's 1 wei had turned a delivered order Partial (a campaign step held in flight for good),
 * closed an executed one Refunded for good (its late refund never offered back) and closed a lapsed one. Below that, a note is no refund of the
 * order: it stays in the private balance, and the order reads as if none were found.
 */
export function refundNotesBack(s: Pick<StoredSwap, "refunds"> & Partial<Pick<StoredSwap, "params" | "refundVaults">>): boolean {
  const notes = s.refunds ?? [];
  if (!notes.length) return false;
  const p = (s.params ?? {}) as { amount?: string; refundVault?: string };
  const own = String(p.refundVault ?? "").toLowerCase();
  // ... the order's own vault, or, for a journal that names none, every vault but its refund tokens'
  const ownNotes = own ? notes.filter((x) => x.vault.toLowerCase() === own) : notes.filter((x) => s.refundVaults?.[x.vault.toLowerCase()] === undefined);
  const back = ownNotes.reduce((a, x) => a + BigInt(x.amount), 0n);
  if (lateRefundHeld(back, BigInt(p.amount ?? "0"))) return true;
  return notes.some((x) => {
    const floor = s.refundVaults?.[x.vault.toLowerCase()];
    return x.vault.toLowerCase() !== own && floor !== undefined && BigInt(x.amount) >= BigInt(floor);
  });
}
