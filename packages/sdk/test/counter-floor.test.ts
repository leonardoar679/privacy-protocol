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

describe("a flow waits for the scan after an unlock (the fifth review round, 2026-11-03)", () => {
  it("untilScanned resolves at once without a hold, when the scan releases the unlock's hold, or at its timeout — a restore's hold is not waited on", async () => {
    const store = new NoteStore();
    await store.untilScanned(50); // nothing held: at once
    store.holdUntilScanned();
    let released = false;
    const waiting = store.untilScanned(5_000).then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(released, "still held: still waiting").toBe(false);
    store.observeCounter(0);
    store.releaseCounters(256);
    await waiting;
    expect(released).toBe(true);
    expect(() => store.allocateCounter()).not.toThrow();
    store.holdUntilScanned();
    const t0 = Date.now();
    await store.untilScanned(30); // the scan never came: the wait ends, the allocation still throws
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(() => store.allocateCounter()).toThrow(CountersHeld);
    store.clear();
    store.holdCounters(); // a restore's hold: not waited on
    await store.untilScanned(5_000);
    expect(() => store.allocateCounter()).toThrow(CountersHeld);
    store.clear();
  });
});

describe("the counters at every unlock (the fifth review round, 2026-11-03)", () => {
  it("an unlock holds the counters until one complete scan; a journal the scan finds current resumes where it was; one behind the chain resumes a reserve past what was found", async () => {
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("pw");
    noteStore.allocateCounter();
    noteStore.allocateCounter(); // counters 0 and 1 used: the journal's counter is 2
    expect(noteStore.countersHeld(), "a creation holds nothing").toBe(false);
    s.lock();
    expect(await s.unlock("pw")).toBe(true);
    expect(noteStore.countersHeld(), "held until the scan after the unlock").toBe(true);
    expect(() => noteStore.allocateCounter()).toThrow(CountersHeld);
    expect(s.journal().countersHeld, "the unlock's hold is not journaled: a reload holds again at its unlock").toBeUndefined();
    // the scan finds counters 0 and 1, which the journal knew: current, no reserve
    noteStore.observeCounter(0);
    noteStore.observeCounter(1);
    noteStore.releaseCounters(256);
    expect(noteStore.countersHeld()).toBe(false);
    expect(noteStore.nextCounter(), "no reserve: the journal was current").toBe(2);
    // a journal behind the chain: the scan finds counter 3, which the journal did not know
    s.lock();
    expect(await s.unlock("pw")).toBe(true);
    noteStore.observeCounter(3);
    noteStore.releaseCounters(256);
    expect(noteStore.nextCounter(), "past what was found, and the reserve").toBe(4 + 256);
    // a restore's hold keeps its reserve whatever the scan found (the first session locked: the store is one for every session)
    s.lock();
    const t = new WalletSession(memoryStorage(), KDF);
    await t.create("pw", undefined, { holdCounters: true });
    expect(noteStore.countersHeld()).toBe(true);
    noteStore.releaseCounters(256);
    expect(noteStore.nextCounter()).toBe(256);
    t.lock();
  });
});
