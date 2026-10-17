// The secure store (spec §8): the `KeyValueStorage` the wallet session reads synchronously, backed by IndexedDB
// through a memory mirror. `ready` resolves once the mirror holds what IndexedDB had (after the one-time move from
// localStorage); writes update the mirror at once and reach IndexedDB in order; `flush()` awaits them. Without
// IndexedDB the mirror is the store (the wallet keeps working for the session, as it did when localStorage was blocked).
import { hasIndexedDb, idbDelete, idbEntries, idbPut } from "./idb";
import { assertSecureShape } from "./guard";
import { migrateFromLocalStorage, type MigrationReport } from "./migrate";
import type { KeyValueStorage } from "@privacy-wallet/sdk/wallet/storage";

export interface SecureStore extends KeyValueStorage {
  readonly backend: "indexeddb" | "memory";
  readonly ready: Promise<void>;
  /** the keys held, sorted (tests, the Privacy Center's "stored locally" fact) */
  keys(): string[];
  /** awaits every write queued so far */
  flush(): Promise<void>;
  /**
   * What IndexedDB holds now, once this store's own writes have landed (a V6 follow-up of 2026-10-16, audit c40): the
   * mirror was filled at page load, and another tab may have written since — an older tab unlocking on its mirror had
   * brought back its old journal and written it over the newer one.
   */
  refresh(): Promise<void>;
  /** what the one-time move did at hydrate (empty when there was nothing to move) */
  migration(): MigrationReport | null;
}

export function createSecureStore(): SecureStore {
  const mirror = new Map<string, string>();
  const useIdb = hasIndexedDb();
  let queue: Promise<void> = Promise.resolve();
  let report: MigrationReport | null = null;
  const enqueue = (op: () => Promise<void>) => { queue = queue.then(op, op).catch(() => undefined); return queue; };

  const ready: Promise<void> = (async () => {
    if (!useIdb) return;
    try {
      report = await migrateFromLocalStorage();
      for (const [k, v] of await idbEntries("secure")) mirror.set(k, v);
    } catch {
      // IndexedDB refused (quota, a closed private window): the session runs on the mirror alone
    }
  })();

  return {
    backend: useIdb ? "indexeddb" : "memory",
    ready,
    get: (k) => mirror.get(k) ?? null,
    set: (k, v) => {
      assertSecureShape(k, v);
      mirror.set(k, v);
      if (useIdb) void enqueue(() => idbPut("secure", k, v));
    },
    remove: (k) => {
      mirror.delete(k);
      if (useIdb) void enqueue(() => idbDelete("secure", k));
    },
    keys: () => [...mirror.keys()].sort(),
    flush: () => queue,
    refresh: async () => {
      await ready;
      if (!useIdb) return;
      await queue;
      try {
        const now = await idbEntries("secure");
        mirror.clear();
        for (const [k, v] of now) mirror.set(k, v);
      } catch {
        // IndexedDB refused: the mirror stays as it was
      }
    },
    migration: () => report,
  };
}

let shared: SecureStore | null = null;
/** The one secure store of the page. */
export function secureStore(): SecureStore { return (shared ??= createSecureStore()); }
/** Tests: a fresh store on the next call (after `fake-indexeddb`'s reset or a cleared database). */
export function resetSecureStore(): void { shared = null; }
