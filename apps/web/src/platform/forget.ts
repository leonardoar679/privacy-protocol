// Forget this wallet on this device (the fifth review round, 2026-11-03): the session's forget removes the keystore and the
// journal; the rest of what the origin held about the wallet stayed — WalletConnect's own store (the pairing's keys, the
// connected public account), the live connection (the next wallet created here started attached to the previous owner's
// account), the preferences (the last connector, which the next load reconnected without a prompt; the backup dates), the
// proving artifacts' cache (its presence says a private spend was proved here) and, with Tornado Classic served on this
// origin, its own database and cache (the device's withdrawal records among them). Everything goes together here.
import { config } from "@privacy-wallet/sdk/config";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { clearWalletConnectStorage } from "@privacy-wallet/wallet-engine/walletConnect";
import { prefs } from "../storage/prefs";
import { removeLocalStorageKey } from "../storage/sameOrigin";
import { ARTIFACT_CACHE } from "./crypto/protocol";

/** The Classic application's storage names, as its own code names them (classic/src/storage; no import across rule 9). */
export const CLASSIC_DB = "tornado-classic";
export const CLASSIC_CACHE = "tornado-classic-artifacts-v1";
export const CLASSIC_LOCALE_KEY = "tornado-classic:locale";

/** Whether Tornado Classic is served on this origin (`/classic/`, the default) — its storage is then this origin's too. */
export const classicOnThisOrigin = (url: string | undefined = config().classicUrl): boolean => !url || url === "/classic/";

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
  // the keystore, the journal, a journal set aside, the settings
  session.forget();
  // the proving artifacts kept for speed
  await cacheStore?.delete(ARTIFACT_CACHE).catch(() => false);
  if (classicOnThisOrigin()) {
    await cacheStore?.delete(CLASSIC_CACHE).catch(() => false);
    try {
      const req = idb?.deleteDatabase(CLASSIC_DB);
      if (req) req.onerror = () => undefined; // a database that is not there, or in use elsewhere: nothing more to do here
    } catch {
      // no IndexedDB
    }
    if (d.localStorage === undefined) removeLocalStorageKey(CLASSIC_LOCALE_KEY);
    else removeLocalStorageKey(CLASSIC_LOCALE_KEY, d.localStorage);
  }
}
