// @vitest-environment happy-dom
// The storage container (spec §8): the two ciphertext blobs live in IndexedDB behind a memory mirror the session
// reads synchronously; the one-time move from localStorage copies, reads back, compares and only then removes;
// the TC-01 guard refuses a secret-like key, a value that is not ciphertext-shaped and an unknown key; the prefs
// store refuses anything outside its schema; without IndexedDB both run on memory; a wallet session over the
// store keeps the seed and the phrase out of every store.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { assertSecureShape, createPrefsStore, createSecureStore, idbEntriesForTest, JOURNAL_KEY, KEYSTORE_KEY, resetDbCache, UNREADABLE_JOURNAL_KEY } from "./helpers/storage";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { openDb } from "../src/storage/idb";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const keystoreJson = (ct = "11".repeat(48)) => JSON.stringify({ v: 1, kdf: { name: "scrypt", N: 4096, r: 8, p: 1, dkLen: 32 }, salt: "00".repeat(16), nonce: "00".repeat(24), ct });
const journalJson = (ct = "22".repeat(48)) => JSON.stringify({ v: 1, nonce: "00".repeat(24), ct });

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetDbCache();
  localStorage.clear();
  noteStore.clear();
  settings.reset();
});

describe("another tab's writes (a V6 follow-up of 2026-10-16, audit c40)", () => {
  it("refresh re-reads what another tab wrote since this one opened, after this tab's own writes landed", async () => {
    const a = createSecureStore();
    await a.ready;
    a.set(JOURNAL_KEY, journalJson("33".repeat(48)));
    await a.flush();
    const older = createSecureStore(); // a tab opened now: its mirror holds that journal
    await older.ready;
    a.set(JOURNAL_KEY, journalJson("44".repeat(48))); // the other tab writes on
    await a.flush();
    expect(older.get(JOURNAL_KEY)).toBe(journalJson("33".repeat(48)));
    await older.refresh();
    expect(older.get(JOURNAL_KEY)).toBe(journalJson("44".repeat(48)));
    a.remove(JOURNAL_KEY);
    await a.flush();
    await older.refresh();
    expect(older.get(JOURNAL_KEY), "a key the other tab removed is gone here too").toBeNull();
  });
});

describe("the secure store (spec §8)", () => {
  it("writes reach IndexedDB in order and a fresh store hydrates them before it is ready", async () => {
    const a = createSecureStore();
    expect(a.backend).toBe("indexeddb");
    await a.ready;
    a.set(KEYSTORE_KEY, keystoreJson());
    a.set(JOURNAL_KEY, journalJson("33".repeat(48)));
    a.set(JOURNAL_KEY, journalJson("44".repeat(48)));
    await a.flush();
    expect(await idbEntriesForTest()).toEqual([[JOURNAL_KEY, journalJson("44".repeat(48))], [KEYSTORE_KEY, keystoreJson()]]);
    const b = createSecureStore();
    expect(b.get(KEYSTORE_KEY), "before hydrate the mirror is empty").toBeNull();
    await b.ready;
    expect(b.get(KEYSTORE_KEY)).toBe(keystoreJson());
    expect(b.get(JOURNAL_KEY)).toBe(journalJson("44".repeat(48)));
    expect(b.keys()).toEqual([JOURNAL_KEY, KEYSTORE_KEY]);
    b.remove(JOURNAL_KEY);
    await b.flush();
    expect((await idbEntriesForTest()).map(([k]) => k)).toEqual([KEYSTORE_KEY]);
  });
  it("moves the legacy localStorage entries once, after an equal read-back, and leaves a conflicting entry alone", async () => {
    localStorage.setItem(KEYSTORE_KEY, keystoreJson());
    localStorage.setItem(JOURNAL_KEY, journalJson());
    localStorage.setItem("unrelated", "x");
    const a = createSecureStore();
    await a.ready;
    expect(a.migration()).toEqual({ moved: [KEYSTORE_KEY, JOURNAL_KEY], kept: [] });
    expect(a.get(KEYSTORE_KEY)).toBe(keystoreJson());
    expect(localStorage.getItem(KEYSTORE_KEY)).toBeNull();
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated"), "only our keys are touched").toBe("x");
    const b = createSecureStore();
    await b.ready;
    expect(b.migration(), "idempotent").toEqual({ moved: [], kept: [] });
    // a stale copy left in localStorage while the store already holds a newer journal: kept, never deleted, never overwriting
    localStorage.setItem(JOURNAL_KEY, journalJson("55".repeat(48)));
    const c = createSecureStore();
    await c.ready;
    expect(c.migration()).toEqual({ moved: [], kept: [JOURNAL_KEY] });
    expect(c.get(JOURNAL_KEY)).toBe(journalJson());
    expect(localStorage.getItem(JOURNAL_KEY)).toBe(journalJson("55".repeat(48)));
  });
  it("TC-01: a secret-like key, a value that is not ciphertext-shaped and an unknown key are refused", async () => {
    const s = createSecureStore();
    await s.ready;
    expect(() => s.set("pp.seed", keystoreJson())).toThrow(/TC-01/);
    expect(() => s.set(KEYSTORE_KEY, "not json")).toThrow(/TC-01/);
    expect(() => s.set(KEYSTORE_KEY, journalJson())).toThrow(/not an encrypted keystore/);
    expect(() => s.set(JOURNAL_KEY, keystoreJson())).toThrow(/not an encrypted journal/);
    expect(() => s.set(JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(48), note: "plain" }))).toThrow(/not an encrypted journal/);
    // the keystore's shape is exact too (the fifth review round, 2026-11-03): no extra field, no other length
    expect(() => s.set(KEYSTORE_KEY, JSON.stringify({ ...JSON.parse(keystoreJson()), owner: "a name" }))).toThrow(/not an encrypted keystore/);
    expect(() => s.set(KEYSTORE_KEY, JSON.stringify({ ...JSON.parse(keystoreJson()), salt: "" }))).toThrow(/not an encrypted keystore/);
    expect(() => s.set(KEYSTORE_KEY, JSON.stringify({ ...JSON.parse(keystoreJson()), nonce: "00".repeat(25) }))).toThrow(/not an encrypted keystore/);
    expect(() => s.set(KEYSTORE_KEY, keystoreJson("11".repeat(49)))).toThrow(/not an encrypted keystore/);
    expect(() => s.set(KEYSTORE_KEY, JSON.stringify({ ...JSON.parse(keystoreJson()), kdf: { name: "scrypt", N: 4096, r: 8, p: 1, dkLen: 32, note: 1 } }))).toThrow(/not an encrypted keystore/);
    expect(() => s.set(KEYSTORE_KEY, keystoreJson())).not.toThrow();
    s.remove(KEYSTORE_KEY);
    expect(() => s.set("pp.other", journalJson())).toThrow(/unknown key/);
    expect(() => assertSecureShape(UNREADABLE_JOURNAL_KEY, journalJson())).not.toThrow();
    expect(s.keys()).toEqual([]);
  });
  it("prefs: the defaults, a schema that refuses an unknown key or a bad value, persistence, recovery from an unreadable value", async () => {
    const p = createPrefsStore();
    await p.ready;
    expect(p.get()).toEqual({ v: 1, experience: "simple", theme: "system", locale: "en", firstLaunchDone: false });
    p.update({ experience: "advanced", locale: "ko", backup: { exportedAt: 1700000000000 } });
    expect(() => p.update({ amount: "1000" } as never)).toThrow();
    expect(() => p.update({ locale: "english" })).toThrow();
    expect(() => p.update({ backup: { address: "0x12" } } as never)).toThrow();
    expect(p.get().experience, "a refused update changes nothing").toBe("advanced");
    await p.flush();
    const q = createPrefsStore();
    await q.ready;
    expect(q.get()).toMatchObject({ experience: "advanced", locale: "ko", backup: { exportedAt: 1700000000000 } });
    const db = await openForTest();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("prefs", "readwrite"); tx.objectStore("prefs").put("{\"v\":1,\"experience\":\"loud\"}", "prefs"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    const r = createPrefsStore();
    await r.ready;
    expect(r.get().experience, "an unreadable preference falls back to the defaults").toBe("simple");
  });
  it("prefs: a first read that failed never writes the defaults over what is stored; the page's own change joins it (audit round 2, n24)", async () => {
    const a = createPrefsStore();
    await a.ready;
    a.update({ experience: "advanced", locale: "ko", backup: { exportedAt: 1700000000000 } });
    await a.flush();
    // the next page's first read fails (IndexedDB busy for a moment)
    const get = IDBObjectStore.prototype.get;
    let fail = true;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (fail && this.name === "prefs") {
        fail = false;
        throw new DOMException("busy for a moment", "UnknownError");
      }
      return get.call(this, key);
    };
    try {
      const b = createPrefsStore();
      await b.ready;
      expect(b.get().experience, "not read: the defaults in memory").toBe("simple");
      b.update({ theme: "dark" });
      await b.flush();
      expect(b.get(), "read before it wrote: the stored values and its own change").toMatchObject({ experience: "advanced", locale: "ko", theme: "dark" });
    } finally {
      IDBObjectStore.prototype.get = get;
    }
    const r = createPrefsStore();
    await r.ready;
    expect(r.get()).toMatchObject({ experience: "advanced", locale: "ko", theme: "dark", backup: { exportedAt: 1700000000000 } });
  });
  it("prefs: a page reads again what another page wrote, before it writes (the audit's unverified m46)", async () => {
    const a = createPrefsStore();
    const b = createPrefsStore();
    await a.ready;
    await b.ready;
    a.update({ backup: { exportedAt: 1700000000000 } });
    await a.flush();
    await b.reload();
    b.update({ experience: "advanced" });
    await b.flush();
    const r = createPrefsStore();
    await r.ready;
    expect(r.get(), "the other page's backup time kept").toMatchObject({ experience: "advanced", backup: { exportedAt: 1700000000000 } });
    // a read again that finds what the page holds tells no screen (a locale taken from the URL stays); a change does
    let heard = 0;
    r.subscribe(() => heard++);
    await r.reload();
    expect(heard, "nothing new").toBe(0);
    b.update({ theme: "dark" });
    await b.flush();
    await r.reload();
    expect([heard, r.get().theme]).toEqual([1, "dark"]);
  });
  it("IndexedDB present but refusing: the store says memory and never writes over what it could not read (the audit's unverified m49)", async () => {
    const real = new IDBFactory();
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = real;
    resetDbCache();
    const a = createSecureStore();
    await a.ready;
    a.set(KEYSTORE_KEY, keystoreJson());
    await a.flush();
    resetDbCache();
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
      open: () => {
        const r: { error?: DOMException; onerror?: () => void } = {};
        queueMicrotask(() => {
          r.error = new DOMException("denied", "UnknownError");
          r.onerror?.();
        });
        return r;
      },
    };
    const s = createSecureStore();
    await s.ready;
    expect([s.backend, s.refused], "said, not hidden").toEqual(["memory", true]);
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = real; // the refusal has passed
    s.set(KEYSTORE_KEY, keystoreJson("99".repeat(48)));
    s.remove(JOURNAL_KEY);
    await s.flush();
    expect(await idbEntriesForTest(), "the keystore it could not read is untouched").toEqual([[KEYSTORE_KEY, keystoreJson()]]);
  });
  it("a write IndexedDB refuses after the store hydrated is said at once, and nothing is read back over the mirror (audit round 2, r16)", async () => {
    const s = createSecureStore();
    await s.ready;
    s.set(KEYSTORE_KEY, keystoreJson());
    await s.flush();
    let told = 0;
    const off = s.subscribe(() => told++);
    (await openDb()).close(); // the writes from here fail, as a full quota's would
    s.set(JOURNAL_KEY, journalJson());
    await s.flush();
    expect([s.backend, s.refused, told], "said, not swallowed").toEqual(["memory", true, 1]);
    await s.refresh();
    expect(s.get(JOURNAL_KEY), "the mirror keeps what IndexedDB did not take").toBe(journalJson());
    off();
  });

  it("without IndexedDB both stores run on memory and are ready at once", async () => {
    const saved = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    delete (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    try {
      const s = createSecureStore();
      const p = createPrefsStore();
      expect(s.backend).toBe("memory");
      expect(p.backend).toBe("memory");
      await s.ready; await p.ready;
      s.set(KEYSTORE_KEY, keystoreJson());
      expect(s.get(KEYSTORE_KEY)).toBe(keystoreJson());
      p.update({ theme: "dark" });
      expect(p.get().theme).toBe("dark");
    } finally {
      (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = saved;
    }
  });
  it("a wallet session over the store keeps the seed and the phrase out of every store; forget() leaves nothing", async () => {
    const store = createSecureStore();
    await store.ready;
    const s = new WalletSession(store, KDF);
    await s.ready;
    expect(s.state().status).toBe("none");
    const phrase = await s.create("password-1");
    const seedHex = bytesToHex(s.state().seed!);
    noteStore.add({ note: { vaultId: 7n, amount: 5n * 10n ** 17n, ownerCommitment: 9n, noteSecret: 11n }, leafIndex: 12, noteData: "0x0102", counter: noteStore.allocateCounter(), spent: false, label: "shield" });
    await store.flush();
    expect(store.keys()).toEqual([JOURNAL_KEY, KEYSTORE_KEY]);
    expect(localStorage.length, "nothing of ours in localStorage").toBe(0);
    const persisted = (await idbEntriesForTest()).map(([k, v]) => `${k}=${v}`).join("\n");
    expect(persisted).not.toContain(seedHex);
    for (const w of phrase.split(" ").filter((w) => w.length > 5)) expect(persisted.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    expect(persisted).not.toContain("500000000000000000");
    s.lock();
    expect(await s.unlock("password-1")).toBe(true);
    expect(noteStore.all()).toHaveLength(1);
    s.forget();
    await store.flush();
    expect(store.keys()).toEqual([]);
    expect(await idbEntriesForTest()).toEqual([]);
  });
  it("an unreadable journal is set aside under its own key in the store, never deleted", async () => {
    const store = createSecureStore();
    await store.ready;
    const s = new WalletSession(store, KDF);
    await s.create("pw");
    s.lock();
    const corrupt = journalJson("66".repeat(64));
    store.set(JOURNAL_KEY, corrupt);
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(true);
    s.discardUnreadableJournal();
    await store.flush();
    expect(store.get(UNREADABLE_JOURNAL_KEY)).toBe(corrupt);
    expect(store.get(JOURNAL_KEY)).not.toBe(corrupt);
    expect((await idbEntriesForTest()).map(([k]) => k)).toEqual([JOURNAL_KEY, UNREADABLE_JOURNAL_KEY, KEYSTORE_KEY]);
  });
});

async function openForTest(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const r = indexedDB.open("privacy-wallet", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
