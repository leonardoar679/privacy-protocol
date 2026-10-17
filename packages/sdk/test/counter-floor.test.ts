// The note counters after a start without the whole journal (PP-P03; the audit round of 2026-10-16). A wallet restored from
// its phrase starts at counter 0, and one restored from a backup at the backup's: a Protect or a swap commit made before the
// first scan reused counters already on chain — the same note secret and, for a deposit, the same owner commitment as an
// earlier deposit or escrow, which links the two and the public account that sent the new one. The counters are now held
// (in the journal too) until one complete scan has seen the used ones, and resume a reserve past them.
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession } from "../src/wallet/session";
import { CountersHeld, NoteStore, noteStore } from "../src/wallet/notes";
import { classify } from "../src/operations/errors/catalog";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("held counters", () => {
  let store: NoteStore;
  beforeEach(() => {
    store = new NoteStore();
  });
  it("none is handed out while held; the release resumes a reserve past the counter; kept through serialize and load; a clear forgets it", () => {
    store.observeCounter(4); // the next is 5
    store.holdCounters();
    expect(store.countersHeld()).toBe(true);
    expect(() => store.allocateCounter()).toThrow(CountersHeld);
    const err = (() => {
      try {
        store.allocateCounter();
      } catch (e) {
        return e;
      }
    })();
    expect(classify(err)).toMatchObject({ code: "notes_loading", fundsClass: "not-moved", actions: ["wait"] });
    expect(store.serialize()).toMatchObject({ noteCounter: 5, countersHeld: true });
    const again = new NoteStore();
    again.load(store.serialize());
    expect(again.countersHeld()).toBe(true);
    store.releaseCounters(256);
    expect(store.countersHeld()).toBe(false);
    expect(store.allocateCounter()).toBe(261);
    expect(store.serialize().countersHeld).toBeUndefined();
    store.releaseCounters(256); // released once only
    expect(store.nextCounter()).toBe(262);
    again.clear();
    expect(again.countersHeld()).toBe(false);
  });
});

describe("a start without the whole journal holds them", () => {
  beforeEach(() => noteStore.clear());

  it("a new wallet does not; a restore from the phrase does, in its journal too, so a reload keeps them held", async () => {
    const a = new WalletSession(memoryStorage(), KDF);
    const phrase = await a.create("a password");
    expect(noteStore.countersHeld(), "a new wallet has used no counter").toBe(false);
    a.lock();
    const b = new WalletSession(memoryStorage(), KDF);
    await b.restoreFromPhrase(phrase, "another password");
    expect(noteStore.countersHeld()).toBe(true);
    expect(() => noteStore.allocateCounter()).toThrow(CountersHeld);
    expect(b.journal().countersHeld).toBe(true);
    b.lock();
    expect(noteStore.countersHeld(), "a lock forgets the store").toBe(false);
    expect(await b.unlock("another password")).toBe(true);
    expect(noteStore.countersHeld(), "read back from the journal").toBe(true);
    noteStore.releaseCounters(256);
    expect(b.journal().countersHeld).toBeUndefined();
    b.lock();
  });

  it("a restore from a backup does too, and so does a journal that does not open", async () => {
    const a = new WalletSession(memoryStorage(), KDF);
    await a.create("a password");
    noteStore.observeCounter(9);
    const backup = a.exportBackup();
    a.lock();
    const c = new WalletSession(memoryStorage(), KDF);
    expect(await c.restoreFromBackup(backup, "a password")).toBe(true);
    expect(noteStore.nextCounter()).toBe(10);
    expect(noteStore.countersHeld()).toBe(true);
    c.lock();
    const store = memoryStorage();
    const d = new WalletSession(store, KDF);
    await d.create("a password");
    d.lock();
    store.set("pp.journal", JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "00".repeat(40) }));
    expect(await d.unlock("a password")).toBe(true);
    expect(noteStore.countersHeld(), "an unreadable journal: the counters used are unknown").toBe(true);
    d.lock();
  });
});
