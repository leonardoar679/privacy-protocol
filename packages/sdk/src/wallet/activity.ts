// The Activity list (whale spec §25, plan V2 §49–§50): one local record per money flow — shields,
// private transfers, withdrawals, swaps, refunds, housekeeping — with date, asset, amount, status and the
// private reference, kept in the encrypted journal and nowhere else. Records are written by the money
// flows themselves (sdk/privateTx.ts, sdk/swapFunding.ts, the Swap screen); a swap's record follows the
// order's state. Finished records can be removed by the user; the backup file carries them.
import type { ActivityRecord, JournalData } from "./journal";
import { session as defaultSession, type WalletSession } from "./session";

export type { ActivityRecord };

export const activityOf = (j: JournalData): ActivityRecord[] => j.activity ?? [];

/** Add a record, or replace the one with the same id (a flow that reports twice updates its line). */
export function recordActivity(rec: Omit<ActivityRecord, "at"> & { at?: number }, s: WalletSession = defaultSession): void {
  s.update((j) => {
    const list = j.activity ?? [];
    const i = list.findIndex((x) => x.id === rec.id);
    const full: ActivityRecord = { at: Date.now(), ...rec };
    j.activity = i >= 0 ? list.map((x, k) => (k === i ? { ...x, ...full, at: x.at } : x)) : [...list, full];
  });
}

export function updateActivity(id: string, patch: Partial<ActivityRecord>, s: WalletSession = defaultSession): void {
  if (!s.isUnlocked() || !(s.journal().activity ?? []).some((x) => x.id === id)) return;
  s.update((j) => { j.activity = (j.activity ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)); });
}

export function deleteActivity(id: string, s: WalletSession = defaultSession): void {
  s.update((j) => { j.activity = (j.activity ?? []).filter((x) => x.id !== id); });
}

/** A swap order's journal state → the Activity / Swap label (plan §33: never a bare "failed" for a funded order). */
const SWAP_LABELS: Record<string, string> = {
  committed: "Pending", "waiting-funding": "Pending", funded: "Funded", executing: "Executing", executed: "Executing", completed: "Completed",
  expired: "Refunding", "refund-only": "Refunding", refunding: "Refunding", refunded: "Refunded", "execute-failed": "Needs attention", "refund-failed": "Needs attention", abandoned: "Abandoned",
};
const PLAIN_LABELS: Record<string, string> = { completed: "Completed", pending: "Pending", failed: "Failed" };

export function activityStatusLabel(rec: Pick<ActivityRecord, "kind" | "status">): string {
  if (rec.kind === "swap") return SWAP_LABELS[rec.status] ?? rec.status;
  if (rec.kind === "campaign") return CAMPAIGN_LABELS[rec.status] ?? rec.status;
  return PLAIN_LABELS[rec.status] ?? rec.status;
}

export const KIND_LABELS: Record<ActivityRecord["kind"], string> = { shield: "Added funds", transfer: "Sent privately", withdraw: "Withdrawn", swap: "Swap", refund: "Refund", housekeeping: "Housekeeping", campaign: "Protected swap" };
/** A campaign's journal state → its Activity label (V3 §15: Completed / In progress / Protected, never a bare failure). */
const CAMPAIGN_LABELS: Record<string, string> = { "user-confirmed": "Starting", "preparing-notes": "Preparing", running: "In progress", paused: "Paused — review", reassessing: "Reassessing", requoting: "Requoting", rerouting: "Route changed — review", "winding-down": "Returning the rest", completed: "Completed", cancelled: "Cancelled" };

/** A record the user may remove: nothing is still moving. */
export const isFinished = (rec: Pick<ActivityRecord, "kind" | "status">): boolean =>
  rec.kind === "swap" ? ["completed", "refunded", "abandoned"].includes(rec.status) : rec.kind === "campaign" ? ["completed", "cancelled"].includes(rec.status) : rec.status !== "pending";

/** The id convention: `${kind}:${ref}` so a flow that reports twice updates its own line. */
export const activityId = (kind: ActivityRecord["kind"], ref: string): string => `${kind}:${ref.toLowerCase()}`;
