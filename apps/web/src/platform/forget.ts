// Forget this wallet on this device (the fifth review round, 2026-11-03): the session's forget removes the keystore and the
// journal; the rest of what the origin held about the wallet stayed — WalletConnect's own store (the pairing's keys, the
// connected public account), the live connection (the next wallet created here started attached to the previous owner's
// account), the preferences (the last connector, which the next load reconnected without a prompt; the backup dates), the
// proving artifacts' cache (its presence says a private spend was proved here) and, with Tornado Classic served on this
// origin, its own database and cache (the device's withdrawal records among them). Everything goes together here.
import { config } from "@privacy-wallet/sdk/config";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { clearWalletConnectStorage, WALLET_CONNECT_DB } from "@privacy-wallet/wallet-engine/walletConnect";
import { prefs } from "../storage/prefs";
import { secureStore } from "../storage/secureStore";
import { SECURE_KEYS } from "../storage/keys";
import { removeLocalStorageKey, removeLocalStorageKeysWithPrefix } from "../storage/sameOrigin";
import { ARTIFACT_CACHE } from "./crypto/protocol";
import { endAiSession } from "../zkapi/aiSession";

/**
 * The zkAPI SDK's own stores (its sdk/services/browserWalletStore.js and the deployment it cached), as the pinned SDK names them: the
 * credit note's secret and blinding, the pending deposit, the funding address — unencrypted, per origin, outside the backup. The
 * eighth review round (2026-11-03, C-M2): a Forget had left them, and the next wallet created here inherited the previous owner's credit.
 */
export const ZKAPI_DB = "zkapi-browser-wallet-v1";
export const ZKAPI_DEPLOYMENT_KEY = "zkapi-browser-deployment";
/** Every localStorage key of the zkAPI SDK starts with this (zkapi-withdrawal-v2, zkapi-exit-rpc-url, zkapi-bundler-url, the deployment). */
export const ZKAPI_KEY_PREFIX = "zkapi-";

/**
 * The page starts again after a Forget, in a production build (the ninth review round, 2026-11-04, B-F6): the zkAPI SDK's client is a singleton
 * with its own timers, worker and cached state — kept running, it re-created the deleted database and served the forgotten wallet's credit
 * note to the next wallet opened in the same tab.
 */
export function restartAfterForget(production: boolean = config().production): void {
  if (production) window.location.replace("/");
}

/** The Classic application's storage names, as its own code names them (classic/src/storage; no import across rule 9). */
export const CLASSIC_DB = "tornado-classic";
export const CLASSIC_CACHE = "tornado-classic-artifacts-v1";
export const CLASSIC_LOCALE_KEY = "tornado-classic:locale";

/** Whether Tornado Classic is served on this origin (`/classic/`, the default) — its storage is then this origin's too. */
export const classicOnThisOrigin = (url: string | undefined = config().classicUrl): boolean => !url || url === "/classic/";

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

export interface ForgetDeps {
  caches?: CacheStorage | null;
  indexedDB?: IDBFactory | null;
  localStorage?: Storage | null;
}

/** Everything of the wallet's under this origin: the records, the public connection, the preferences, the caches, Classic's stores. */
export async function forgetEverything(d: ForgetDeps = {}): Promise<void> {
  const cacheStore = d.caches === undefined ? (typeof caches === "undefined" ? null : caches) : d.caches;
  const idb = d.indexedDB === undefined ? (typeof indexedDB === "undefined" ? null : indexedDB) : d.indexedDB;
  // the public wallet: its connection ended (a WalletConnect session at its relay too), and WalletConnect's store whatever the
  // connector of the moment — a pairing of an earlier session had stayed
  try {
    connection.disconnect();
  } catch {
    // no provider to end
  }
  clearWalletConnectStorage();
  // the preferences from the defaults: the last connector, the backup dates, the experience, the locale
  prefs().reset();
  // the Private AI session's provider key released, and the credit wallet's stores gone (C-M2)
  endAiSession();
  const deletions: Promise<unknown>[] = [deleteDatabase(idb, ZKAPI_DB), deleteDatabase(idb, WALLET_CONNECT_DB)];
  // every key the zkAPI SDK keeps (the ninth review round, B-F6): a withdrawal in flight with its destination and transaction, the exit RPC,
  // the bundler — not only its deployment
  if (d.localStorage === undefined) removeLocalStorageKeysWithPrefix(ZKAPI_KEY_PREFIX);
  else removeLocalStorageKeysWithPrefix(ZKAPI_KEY_PREFIX, d.localStorage);
  // the keystore, the journal, a journal set aside, the settings
  session.forget();
  // and a legacy localStorage copy of them a migration left in place (D-9): the next load had moved a forgotten keystore back
  for (const key of SECURE_KEYS) {
    if (d.localStorage === undefined) removeLocalStorageKey(key);
    else removeLocalStorageKey(key, d.localStorage);
  }
  // the proving artifacts kept for speed
  await cacheStore?.delete(ARTIFACT_CACHE).catch(() => false);
  if (classicOnThisOrigin()) {
    await cacheStore?.delete(CLASSIC_CACHE).catch(() => false);
    deletions.push(deleteDatabase(idb, CLASSIC_DB)); // an open Classic tab closes on the versionchange (D-9)
    if (d.localStorage === undefined) removeLocalStorageKey(CLASSIC_LOCALE_KEY);
    else removeLocalStorageKey(CLASSIC_LOCALE_KEY, d.localStorage);
  }
  // every delete written before the Forget resolves (D-9, B10-9): the secure store's queue (the keystore, the journal), the preferences', the
  // databases — the restart that follows had raced them, the journal still in IndexedDB when it came
  await Promise.all([secureStore().flush().catch(() => undefined), prefs().flush().catch(() => undefined), ...deletions]);
}
