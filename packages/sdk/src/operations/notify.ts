// The operation notifications (spec v2.0 §12.5; doc §76; V6 Stage 15): which change of an operation the user is told
// about — five kinds, decided from the record before and after a write — and a watcher over the operation store. The
// words live in the app's catalog (the platform renders them); an amount appears only when the user allowed amount
// previews (the V3 setting: `notifications.generic` off). Delivery is the in-app list and, while the tab is hidden, the
// browser's Notification API (../wallet/notifications.ts); web push is later.
import type { OperationKind, OperationRecord } from "../wallet/operationRecord";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { allOperations, subscribeOperations } from "./store";

export type OperationNotificationKind = "quote-ready" | "confirmed" | "cross-chain-executing" | "completed" | "recovery-required";
export const NOTIFICATION_KINDS: readonly OperationNotificationKind[] = ["quote-ready", "confirmed", "cross-chain-executing", "completed", "recovery-required"];

export interface NotificationPrefs {
  /** the user allowed amount previews; off by default */
  amounts: boolean;
}

/** An amount in base units with its asset, for the platform to format. */
export interface NotifiedAmount {
  asset: string;
  decimals: number;
  value: string;
}

export interface OperationNotification {
  kind: OperationNotificationKind;
  operationId: string;
  operation: OperationKind;
  /** only when the user allowed amounts: what went in and, for a swap, what came (or is expected to come) out */
  amounts?: { input: NotifiedAmount; output?: NotifiedAmount };
  /** a finished swap's outcome when it is not the whole delivery (the ninth review round, C-03/C-07): its own words, never "complete" */
  outcome?: OperationRecord["outcome"];
}

/** The kind a transition earns, or null: a quote in for review, a swap's funding confirmed (a cross-chain swap's is
 *  "executing"), any operation completed, any operation needing recovery. Nothing for a state the record already had. */
export function kindFor(prev: OperationRecord, next: OperationRecord): OperationNotificationKind | null {
  if (prev.state === next.state) return null;
  if (next.state === "READY_TO_REVIEW" && prev.state === "QUOTING") return "quote-ready";
  if (next.state === "PROVIDER_EXECUTING" && prev.state === "SOURCE_CONFIRMING") return next.kind === "cross-chain" ? "cross-chain-executing" : "confirmed";
  if (next.state === "COMPLETED") return "completed";
  if (next.state === "RECOVERY_REQUIRED") return "recovery-required";
  return null;
}

/** The notification a write deserves (doc §76), without amounts unless the user opted in; null for a record seen for
 *  the first time (a reload or an unlock lists records, it does not change them). */
export function notificationFor(prev: OperationRecord | null, next: OperationRecord, prefs: NotificationPrefs): OperationNotification | null {
  if (!prev) return null;
  const kind = kindFor(prev, next);
  if (!kind) return null;
  const n: OperationNotification = {
    kind,
    operationId: next.id,
    operation: next.kind,
    ...(kind === "completed" && next.outcome ? { outcome: next.outcome } : {}),
  };
  if (!prefs.amounts) return n;
  const a = next.amounts;
  // nothing of the output arrived when the provider refunded at the destination: no expected amount stands in for it
  const out = next.outcome === "refunded-at-destination" ? undefined : (a.delivered ?? a.expectedOutput);
  return {
    ...n,
    amounts: {
      input: { asset: a.asset, decimals: a.decimals, value: a.input },
      ...(out !== undefined && a.outputAsset ? { output: { asset: a.outputAsset, decimals: a.outputDecimals ?? a.decimals, value: out } } : {}),
    },
  };
}

/**
 * Watches the operation store and delivers each notification once. The records present when it starts (or when the
 * wallet unlocks) are its baseline and notify nothing; a lock forgets them. Returns the unsubscribe.
 */
export function watchOperationNotifications(
  deliver: (n: OperationNotification) => void,
  o: { prefs: () => NotificationPrefs; session?: WalletSession },
): () => void {
  const s = o.session ?? defaultSession;
  const seen = new Map<string, OperationRecord>();
  let baseline = false;
  const check = () => {
    if (!s.isUnlocked()) {
      seen.clear();
      baseline = false;
      return;
    }
    const all = allOperations(s);
    if (!baseline) {
      for (const r of all) seen.set(r.id, r);
      baseline = true;
      return;
    }
    for (const r of all) {
      const n = notificationFor(seen.get(r.id) ?? null, r, o.prefs());
      seen.set(r.id, r);
      if (n) deliver(n);
    }
  };
  check();
  const offStore = subscribeOperations(check, s);
  const offSession = s.subscribe(check);
  return () => {
    offStore();
    offSession();
  };
}
