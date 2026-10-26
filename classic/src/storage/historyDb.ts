// The history on the device (spec v3.0 §7.4, §7.8): the Classic app's own IndexedDB `tornado-classic`, one store, four
// records per pool — the manifest and the sync state, the deposits, the withdrawals, the tree's layers (hex). Public
// chain data only: never a note, never a deposit record of this device. A refused or absent IndexedDB makes the app
// sync from the snapshot every visit (the memory store); nothing else changes.
import type { DepositEvent, WithdrawalEvent } from "../history/events";
import type { SnapshotManifest } from "../history/snapshot";
import type { Checkpoint } from "../history/sync";
import type { PoolId } from "../config";

export const HISTORY_DB = "tornado-classic";
const DB_VERSION = 1;
const STORE = "history";
const PARTS = ["meta", "deposits", "withdrawals", "layers"] as const;

export interface SyncState {
  pool: PoolId;
  address: `0x${string}`;
  /** the last block covered */
  toBlock: number;
  blockHash: `0x${string}` | null;
  leaves: number;
  checkpoints: Checkpoint[];
  /** the window size the last sync ended with */
  window?: number;
  /** when the root was last held to the chain (ms since the epoch), and the result */
  verifiedAt?: number;
  verified?: boolean;
}

export interface StoredHistory {
  manifest: SnapshotManifest | null;
  state: SyncState;
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
  /** the tree's layers, level 0 the leaves, 32-byte hex */
  layers: string[][];
}

export interface HistoryStore {
  read(pool: PoolId): Promise<StoredHistory | null>;
  write(pool: PoolId, history: StoredHistory): Promise<void>;
  clear(pool: PoolId): Promise<void>;
}

const key = (pool: PoolId, part: (typeof PARTS)[number]) => `${pool}:${part}`;

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

export function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(HISTORY_DB, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened"));
    open.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

/** The IndexedDB store; `factory` defaults to the platform's. */
export function indexedDbHistoryStore(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): HistoryStore {
  if (!factory) throw new Error("IndexedDB is not available here");
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= openDatabase(factory));
  return {
    async read(pool) {
      const tx = (await open()).transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const [meta, deposits, withdrawals, layers] = await Promise.all(PARTS.map((p) => request(store.get(key(pool, p)))));
      await done(tx);
      if (!meta) return null;
      const m = meta as { manifest: SnapshotManifest | null; state: SyncState };
      return {
        manifest: m.manifest,
        state: m.state,
        deposits: (deposits as DepositEvent[]) ?? [],
        withdrawals: (withdrawals as WithdrawalEvent[]) ?? [],
        layers: (layers as string[][]) ?? [],
      };
    },
    async write(pool, history) {
      const tx = (await open()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put({ manifest: history.manifest, state: history.state }, key(pool, "meta"));
      store.put(history.deposits, key(pool, "deposits"));
      store.put(history.withdrawals, key(pool, "withdrawals"));
      store.put(history.layers, key(pool, "layers"));
      await done(tx);
    },
    async clear(pool) {
      const tx = (await open()).transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const p of PARTS) store.delete(key(pool, p));
      await done(tx);
    },
  };
}

/** A store that forgets at the end of the page: the fallback, and the tests' stand-in. */
export function memoryHistoryStore(): HistoryStore {
  const map = new Map<string, StoredHistory>();
  return {
    read: async (pool) => map.get(pool) ?? null,
    write: async (pool, h) => {
      map.set(pool, h);
    },
    clear: async (pool) => {
      map.delete(pool);
    },
  };
}

/** IndexedDB when the platform has it, memory otherwise. */
export function historyStore(): HistoryStore {
  try {
    return indexedDbHistoryStore();
  } catch {
    return memoryHistoryStore();
  }
}
