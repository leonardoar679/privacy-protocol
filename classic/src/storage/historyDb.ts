// The Classic app's own IndexedDB `tornado-classic` (spec v3.0 §7.4, §7.8): the public history of each pool — the
// manifest and the sync state, the deposits, the withdrawals, the tree's layers (hex) — and the records of what this
// device did (a deposit's or a withdrawal's ids, state, transaction and relayer job; never a note, never a recipient).
// A refused or absent IndexedDB makes the app hold both in memory for the page; nothing else changes.
import type { DepositEvent, WithdrawalEvent } from "../history/events";
import type { SnapshotManifest } from "../history/snapshot";
import type { Checkpoint } from "../history/sync";
import type { PoolId } from "../config";
import type { JobRecord } from "../app/services/operations";

export const HISTORY_DB = "tornado-classic";
const DB_VERSION = 2;
const HISTORY_STORE = "history";
const JOBS_STORE = "jobs";
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
  /** this device built the tree from its leaves (the eleventh review round, C11-2): a copy without it is hashed once before it is trusted */
  hashed?: true;
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

export interface JobsStore {
  /** the records live in this page's memory only — the fallback, or no IndexedDB (the eleventh review round's critique of C11-5): History says so */
  readonly pageOnly?: boolean;
  list(): Promise<JobRecord[]>;
  put(job: JobRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** every record gone (the fourth review round, 2026-11-03): the device's withdrawal history is the user's to clear */
  clear(): Promise<void>;
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

/** The platform refused the database (a private window, blocked site data, a quota): the stores fall back to memory (C11-5). */
export class DatabaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRefused";
  }
}

/** How long an opening blocked by another tab's connection is waited for before the stores fall back to memory (C11-5). */
export const BLOCKED_WAIT_MS = 5_000;

export function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let gaveUp = false;
    let blocked: ReturnType<typeof setTimeout> | null = null;
    let open: IDBOpenDBRequest;
    // a refusal thrown at once is a refusal too (the critique of C11-5): with the site's data blocked, open() itself throws a SecurityError
    try {
      open = factory.open(HISTORY_DB, DB_VERSION);
    } catch (e) {
      reject(new DatabaseRefused(e instanceof Error ? e.message : "IndexedDB could not be opened"));
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE);
      if (!db.objectStoreNames.contains(JOBS_STORE)) db.createObjectStore(JOBS_STORE, { keyPath: "id" });
    };
    open.onsuccess = () => {
      if (blocked) clearTimeout(blocked);
      // opened after the wait gave up: the page already uses memory, and this connection would block the next upgrade
      if (gaveUp) return open.result.close();
      resolve(open.result);
    };
    open.onerror = () => {
      if (blocked) clearTimeout(blocked);
      reject(new DatabaseRefused(open.error?.message ?? "IndexedDB could not be opened"));
    };
    // blocked waits, for a while (the eleventh review round, C11-5): another tab's connection closes on the versionchange and the open then
    // succeeds; one that never closes (an older build's tab) is waited for BLOCKED_WAIT_MS, then the stores fall back to memory
    open.onblocked = () => {
      blocked ??= setTimeout(() => {
        gaveUp = true;
        reject(new DatabaseRefused("IndexedDB is blocked by another tab"));
      }, BLOCKED_WAIT_MS);
    };
  });
}

const platformFactory = (): IDBFactory | undefined => (typeof indexedDB === "undefined" ? undefined : indexedDB);
const databases = new Map<IDBFactory, Promise<IDBDatabase>>();
const databaseOf = (factory: IDBFactory): Promise<IDBDatabase> => {
  let db = databases.get(factory);
  if (!db) {
    // closed when another tab deletes or upgrades the database (the tenth review round, D-9): the Privacy Wallet's Forget deletes this one,
    // and an open Classic tab had blocked it; the next use opens it again
    const opening = openDatabase(factory).then(
      (open) => {
        open.onversionchange = () => {
          open.close();
          if (databases.get(factory) === opening) databases.delete(factory);
        };
        return open;
      },
      (e: unknown) => {
        // a refused opening is not kept for the page (C11-5): the next use asks again, or the store falls back to memory
        if (databases.get(factory) === opening) databases.delete(factory);
        throw e;
      },
    );
    db = opening;
    databases.set(factory, opening);
  }
  return db;
};

/** The IndexedDB history store; `factory` defaults to the platform's. */
export function indexedDbHistoryStore(factory: IDBFactory | undefined = platformFactory()): HistoryStore {
  if (!factory) throw new Error("IndexedDB is not available here");
  return {
    async read(pool) {
      const tx = (await databaseOf(factory)).transaction(HISTORY_STORE, "readonly");
      const store = tx.objectStore(HISTORY_STORE);
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
      const tx = (await databaseOf(factory)).transaction(HISTORY_STORE, "readwrite");
      const store = tx.objectStore(HISTORY_STORE);
      store.put({ manifest: history.manifest, state: history.state }, key(pool, "meta"));
      store.put(history.deposits, key(pool, "deposits"));
      store.put(history.withdrawals, key(pool, "withdrawals"));
      store.put(history.layers, key(pool, "layers"));
      await done(tx);
    },
    async clear(pool) {
      const tx = (await databaseOf(factory)).transaction(HISTORY_STORE, "readwrite");
      const store = tx.objectStore(HISTORY_STORE);
      for (const p of PARTS) store.delete(key(pool, p));
      await done(tx);
    },
  };
}

/** The IndexedDB jobs store (the device's own records); `factory` defaults to the platform's. */
export function indexedDbJobsStore(factory: IDBFactory | undefined = platformFactory()): JobsStore {
  if (!factory) throw new Error("IndexedDB is not available here");
  return {
    pageOnly: false,
    async list() {
      const tx = (await databaseOf(factory)).transaction(JOBS_STORE, "readonly");
      const all = (await request(tx.objectStore(JOBS_STORE).getAll())) as JobRecord[];
      await done(tx);
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    async put(job) {
      const tx = (await databaseOf(factory)).transaction(JOBS_STORE, "readwrite");
      tx.objectStore(JOBS_STORE).put(job);
      await done(tx);
    },
    async remove(id) {
      const tx = (await databaseOf(factory)).transaction(JOBS_STORE, "readwrite");
      tx.objectStore(JOBS_STORE).delete(id);
      await done(tx);
    },
    async clear() {
      const tx = (await databaseOf(factory)).transaction(JOBS_STORE, "readwrite");
      tx.objectStore(JOBS_STORE).clear();
      await done(tx);
    },
  };
}

/** A history store that forgets at the end of the page: the fallback, and the tests' stand-in. */
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

export function memoryJobsStore(): JobsStore {
  const map = new Map<string, JobRecord>();
  return {
    pageOnly: true,
    list: async () => [...map.values()].sort((a, b) => a.createdAt - b.createdAt),
    put: async (job) => {
      map.set(job.id, job);
    },
    remove: async (id) => {
      map.delete(id);
    },
    clear: async () => {
      map.clear();
    },
  };
}

/**
 * A store over IndexedDB that falls back to its memory twin at the first refused opening, for the page (the eleventh review round, 2026-11-04,
 * C11-5): a refused database had been kept as refused — no history and no withdrawal, while deposits went through.
 */
function withFallback<S extends object>(primary: S, memory: () => S): S {
  let use: S | null = null;
  return new Proxy(primary, {
    get(target, key) {
      const own = Reflect.get(use ?? target, key);
      if (typeof own !== "function") return own;
      return async (...args: unknown[]) => {
        if (use) return (Reflect.get(use, key) as (...a: unknown[]) => unknown).apply(use, args);
        try {
          return await (own as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          if (!(e instanceof DatabaseRefused)) throw e;
          use = memory();
          return (Reflect.get(use, key) as (...a: unknown[]) => unknown).apply(use, args);
        }
      };
    },
  });
}

/** IndexedDB when the platform has it — memory when it has none or refuses it. */
export function historyStore(): HistoryStore {
  try {
    return withFallback(indexedDbHistoryStore(), memoryHistoryStore);
  } catch {
    return memoryHistoryStore();
  }
}

export function jobsStore(): JobsStore {
  try {
    return withFallback(indexedDbJobsStore(), memoryJobsStore);
  } catch {
    return memoryJobsStore();
  }
}
