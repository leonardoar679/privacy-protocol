// Persistent storage (V7 Stage 16, spec v3.0 §9): the browser is asked once per page to keep this origin's storage — the
// encrypted journal and the keystore in IndexedDB, the preferences — out of its eviction: a phone under pressure evicts
// "best effort" origins first, and iOS Safari drops an origin's storage after a week without a visit unless it is
// persistent. The answer is remembered for the screens. A browser without the API, or one that refuses, changes
// nothing: the backup file and the recovery phrase are the way back, as always (spec v2.0 §8).
export type PersistentStorageState = "unknown" | "persistent" | "best-effort" | "unsupported";

let asked: Promise<boolean | null> | null = null;
let state: PersistentStorageState = "unknown";

/** What the browser answered: persistent, best effort, no such API, or not asked yet. */
export const persistentStorageState = (): PersistentStorageState => state;

/** Asks once; later calls return the same answer. null when the browser has no such API or the call failed. */
export function askPersistentStorage(): Promise<boolean | null> {
  if (asked) return asked;
  asked = (async () => {
    try {
      const api = typeof navigator === "undefined" ? undefined : navigator.storage;
      if (!api || typeof api.persist !== "function") {
        state = "unsupported";
        return null;
      }
      const already = typeof api.persisted === "function" ? await api.persisted() : false;
      const granted = already || (await api.persist());
      state = granted ? "persistent" : "best-effort";
      return granted;
    } catch {
      state = "unsupported";
      return null;
    }
  })();
  return asked;
}

/** Tests: ask again. */
export function resetPersistentStorage(): void {
  asked = null;
  state = "unknown";
}
