// IndexedDB, promisified and nothing more (spec §8): the database `privacy-wallet` with two object stores —
// `secure` for the two ciphertext blobs (and the one set aside), `prefs` for the non-sensitive preferences.
// Values are strings (the serialized JSON the callers already produce), keys are strings. Absent IndexedDB
// (a private window, a blocked origin, a test without a polyfill) the stores degrade to memory (secureStore.ts).

export const DB_NAME = "privacy-wallet";
export const DB_VERSION = 1;
export const STORES = ["secure", "prefs"] as const;
export type StoreName = (typeof STORES)[number];

export function hasIndexedDb(): boolean {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; } catch { return false; }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    open.onerror = () => { dbPromise = null; reject(open.error ?? new Error("IndexedDB open failed")); };
    open.onblocked = () => { dbPromise = null; reject(new Error("IndexedDB open blocked")); };
  });
  return dbPromise;
}

/** Tests: forget the cached connection (fake-indexeddb is reset between files). */
export function resetDbCache(): void { dbPromise = null; }

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function idbGet(name: StoreName, key: string): Promise<string | undefined> {
  const v = await request((await store(name, "readonly")).get(key));
  return typeof v === "string" ? v : undefined;
}
/**
 * A write in its own transaction, settled when the transaction commits (audit round 2, n46): the request's success is not
 * the write's — a quota aborts the transaction after it, and such a write had counted as kept.
 */
async function write(name: StoreName, op: (s: IDBObjectStore) => void): Promise<void> {
  const tx = (await openDb()).transaction(name, "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB write aborted", "AbortError"));
  });
  op(tx.objectStore(name));
  return done;
}
export async function idbPut(name: StoreName, key: string, value: string): Promise<void> {
  await write(name, (s) => s.put(value, key));
}
export async function idbDelete(name: StoreName, key: string): Promise<void> {
  await write(name, (s) => s.delete(key));
}
/** Several puts and deletes in one transaction (the eleventh review round, A11-7): all of them land, or none (null: a delete). */
export async function idbWriteMany(name: StoreName, entries: readonly (readonly [string, string | null])[]): Promise<void> {
  await write(name, (s) => {
    for (const [k, v] of entries) {
      if (v === null) s.delete(k);
      else s.put(v, k);
    }
  });
}
export async function idbClear(name: StoreName): Promise<void> {
  await write(name, (s) => s.clear());
}
export async function idbEntries(name: StoreName): Promise<[string, string][]> {
  const s = await store(name, "readonly");
  const keys = (await request(s.getAllKeys())).map(String);
  const values = await request(s.getAll());
  return keys.map((k, i) => [k, String(values[i])] as [string, string]);
}
