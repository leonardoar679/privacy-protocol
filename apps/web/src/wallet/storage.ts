// The only two things this wallet ever writes to dapp-origin storage: the encrypted keystore and the
// encrypted journal (plan §44). Every write passes the TC-01 guard; the raw seed, note secrets and
// phrases never reach here in the clear. V5 (Privacy Wallet Web spec §8): the browser adapter is the
// secure store of src/storage — IndexedDB behind a memory mirror, hydrated before the first render
// (`ready`), moved once from localStorage; without IndexedDB it degrades to memory and the app keeps working.
import { assertNotPersistingSecret } from "../keys/wallet";
import { secureStore } from "../storage/secureStore";

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** resolves once the store holds what the device had (absent: ready at once) */
  ready?: Promise<void>;
}

export { JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY } from "../storage/keys";

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { assertNotPersistingSecret(k); m.set(k, v); },
    remove: (k) => { m.delete(k); },
  };
}

/** The device's store: the secure store (IndexedDB, or memory when it is unavailable). */
export function browserStorage(): KeyValueStorage {
  return secureStore();
}
