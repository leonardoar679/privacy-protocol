// The only two things this wallet ever writes to dapp-origin storage: the encrypted keystore and the
// encrypted journal (plan §44). Every write passes the TC-01 guard; the raw seed, note secrets and
// phrases never reach here in the clear. V5 (Privacy Wallet Web spec §8): the browser adapter is the
// secure store of apps/web/src/storage — IndexedDB behind a memory mirror, hydrated before the first render
// (`ready`), moved once from localStorage; without IndexedDB it degrades to memory and the app keeps working.
import { assertNotPersistingSecret } from "../keys/wallet";
import { config } from "../config";

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** resolves once the store holds what the device had (absent: ready at once) */
  ready?: Promise<void>;
  /** re-reads what another tab of this browser may have written since (absent: nothing else writes it) */
  refresh?(): Promise<void>;
  /**
   * the device keeps nothing of this store past this tab: it refused it at hydrate (the web's secure store, m49) or refused a
   * write since (r16); absent, it keeps what it is given
   */
  readonly refused?: boolean;
  /**
   * several records written as one where the store can (the eleventh review round, 2026-11-04, A11-7: the web's secure store commits them in
   * one IndexedDB transaction) — null removes; absent, the session writes them one by one
   */
  setMany?(entries: readonly (readonly [string, string | null])[]): void;
}

export { JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY } from "./storageKeys";

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { assertNotPersistingSecret(k); m.set(k, v); },
    remove: (k) => { m.delete(k); },
    setMany: (entries) => {
      for (const [k, v] of entries) if (v !== null) assertNotPersistingSecret(k);
      for (const [k, v] of entries) if (v === null) m.delete(k); else m.set(k, v);
    },
  };
}

/** The device's store, from the platform (the web: the IndexedDB container of apps/web/src/storage; V6 Stage 4 — the engine never
 *  imports the platform). Read at the moment of use. */
export function browserStorage(): KeyValueStorage {
  const storage = config().storage;
  if (!storage) throw new Error("no storage configured: the platform passes its store to configure() (apps/web/src/config.ts)");
  return storage();
}
