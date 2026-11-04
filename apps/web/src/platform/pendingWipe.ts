// What a page could not delete under its own connection (the eleventh review round, 2026-11-04, A11-3/H11-4): WalletConnect's database, while
// WalletConnect is loaded in the page — a deletion from there waited for the page to go, and every later open of it queued behind it. Its name
// is kept in the preferences and a later page start deletes it — one where no page holds WalletConnect (its Web Lock, the round's critique:
// another tab's connection had blocked the start's deletion too, and this page's WalletConnect queued behind it). A page loading WalletConnect
// waits for a deletion in progress.
import { deleteWalletConnectDatabase, WALLET_CONNECT_DB } from "@privacy-wallet/wallet-engine/walletConnect";
import { prefs } from "../storage/prefs";

/**
 * A database's deletion, awaited (the tenth review round, D-9, B10-9): a production build restarts the page as soon as the Forget resolves,
 * and the deletes still queued had raced it. A deletion another tab blocks resolves "blocked" after DELETE_WAIT_MS — that tab's
 * versionchange handler closes it (Classic's does) and the deletion completes then.
 */
export const DELETE_WAIT_MS = 5_000;
export function deleteDatabase(idb: IDBFactory | null, name: string): Promise<"deleted" | "blocked" | "failed"> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest | undefined;
    try {
      req = idb?.deleteDatabase(name);
    } catch {
      req = undefined;
    }
    if (!req) return resolve("failed");
    const timer = setTimeout(() => resolve("blocked"), DELETE_WAIT_MS);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve("deleted");
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve("failed");
    };
  });
}

/** Kept for the next page start. */
export function deferDeletion(name: string): void {
  const pending = prefs().get().pendingWipe ?? [];
  if (!pending.includes(name)) prefs().update({ pendingWipe: [...pending, name] });
}

/** At a page start: every database kept for it deleted; one another page holds, or still blocked, stays for a later start. */
export async function wipePending(idb: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB): Promise<void> {
  await prefs().ready;
  const pending = prefs().get().pendingWipe ?? [];
  if (!pending.length) return;
  const outcomes = await Promise.all(
    pending.map((name) => (name === WALLET_CONNECT_DB ? deleteWalletConnectDatabase(() => deleteDatabase(idb, name)) : deleteDatabase(idb, name))),
  );
  const left = pending.filter((_, i) => outcomes[i] === "blocked" || outcomes[i] === "held");
  const now = prefs().get().pendingWipe ?? [];
  // a name kept meanwhile (a Disconnect since this start) stays
  const next = [...new Set([...left, ...now.filter((n) => !pending.includes(n))])];
  prefs().update({ pendingWipe: next.length ? next : undefined });
}
