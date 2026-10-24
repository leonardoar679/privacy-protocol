// A tab taking the wallet over reads the journal again (audit c40) — and finds the wallet gone, or another one, or its own
// journal readable at last (audit round 2, n27/n22): a tab waiting for the wallet kept the journal of one forgotten in the
// other tab and wrote it back at its next change, or over the next wallet's journal; and a tab whose journal had not opened
// kept saving nothing after the other tab set it aside and replaced it.
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { WalletSession } from "../src/wallet/session";
import { decryptJournal, journalKey } from "../src/wallet/journal";
import { noteStore } from "../src/wallet/notes";
import { settings } from "../src/wallet/settings";
import { JOURNAL_KEY, KEYSTORE_KEY, memoryStorage, UNREADABLE_JOURNAL_KEY, type KeyValueStorage } from "../src/wallet/storage";
import { generateMasterSeed } from "../src/keys/wallet";
import { seedToPhrase } from "../src/wallet/keystore";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("a tab's journal read again at its takeover (audit round 2, n27/n22)", () => {
  it("a wallet forgotten in the other tab locks this one, which writes nothing back", async () => {
    const store = memoryStorage();
    const a = new WalletSession(store, KDF);
    await a.create("pw");
    const b = new WalletSession(store, KDF);
    expect(await b.unlock("pw")).toBe(true);
    a.forget();
    await b.reload(); // granted the wallet
    expect(b.isUnlocked(), "locked: the wallet is gone").toBe(false);
    b.update((j) => {
      j.chainIndexes.evm = 9;
    });
    expect([store.get(KEYSTORE_KEY), store.get(JOURNAL_KEY)], "nothing written back").toEqual([null, null]);
  });

  it("a wallet replaced by another in the other tab locks this one, whose journal never goes over the new one's", async () => {
    const store = memoryStorage();
    const a = new WalletSession(store, KDF);
    await a.create("pw");
    const b = new WalletSession(store, KDF);
    expect(await b.unlock("pw")).toBe(true);
    a.forget();
    await a.create("another password");
    const next = store.get(JOURNAL_KEY);
    await b.reload();
    expect(b.isUnlocked()).toBe(false);
    expect(store.get(JOURNAL_KEY), "the new wallet's journal intact").toBe(next);
  });

  it("an unreadable journal the other tab set aside and replaced: this tab saves again once it reads it", async () => {
    const store = memoryStorage();
    const a = new WalletSession(store, KDF);
    await a.create("pw");
    a.lock();
    store.set(JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(64) }));
    const b = new WalletSession(store, KDF);
    expect(await b.unlock("pw")).toBe(true);
    expect(b.state().journalUnreadable).toBe(true);
    expect(await a.unlock("pw")).toBe(true);
    a.discardUnreadableJournal(); // the other tab's choice: a readable journal stored
    await b.reload();
    expect(b.isUnlocked(), "its own journal: still open").toBe(true);
    expect(b.state().journalUnreadable, "saves again").toBe(false);
  });
});

describe("an unlock and a takeover write nothing (audit round 2, n47)", () => {
  beforeAll(() => configure(defaultConfig({ kdfLog2N: 12, deploymentCheck: false })));
  /** the store, counting the journal's writes */
  const counted = (store: KeyValueStorage) => {
    const n = { writes: 0 };
    return { n, store: { ...store, set: (k: string, v: string) => (k === JOURNAL_KEY && n.writes++, store.set(k, v)) } as KeyValueStorage };
  };

  it("settings a load heals stay in memory until the next write: neither the unlock nor the takeover writes the journal", async () => {
    const shared = memoryStorage();
    const a = new WalletSession(shared, KDF);
    await a.create("pw");
    // a journal of an older build: its settings lack what this build has
    a.update((j) => {
      j.settings = { advanced: true };
    });
    a.lock();
    try {
      const { n, store } = counted(shared);
      const b = new WalletSession(store, KDF);
      expect(await b.unlock("pw")).toBe(true);
      expect(n.writes, "nothing written at the unlock").toBe(0);
      expect(b.journal().settings, "the healed settings, in memory").toEqual({ ...settings.get() });
      expect(settings.get().advanced).toBe(true);
      await b.reload(); // granted the wallet: it reads the journal again
      expect(n.writes, "nor at the takeover").toBe(0);
      b.update((j) => {
        j.chainIndexes.evm = 3;
      });
      expect(n.writes, "they go out with the next write").toBe(1);
      const c = new WalletSession(shared, KDF);
      expect(await c.unlock("pw")).toBe(true);
      expect(c.journal().settings).toEqual({ ...settings.get() });
      b.lock();
      c.lock();
    } finally {
      settings.reset();
    }
  });
});

describe("a journal set aside as unreadable, at a create or a restore (audit round 2, n49/n70)", () => {
  const CORRUPT = JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(64) });

  it("another wallet's goes with it: a create or a restore over it leaves none on the device", async () => {
    for (const how of ["create", "phrase", "backup"] as const) {
      const store = memoryStorage();
      const a = new WalletSession(store, KDF);
      await a.create("pw");
      const backup = a.exportBackup();
      store.set(UNREADABLE_JOURNAL_KEY, CORRUPT); // set aside earlier: no seed opens it
      a.lock();
      const b = new WalletSession(store, KDF);
      if (how === "create") await b.create("another", undefined, { replace: true });
      else if (how === "phrase") await b.restoreFromPhrase(seedToPhrase(generateMasterSeed()), "another", { replace: true });
      else expect(await b.restoreFromBackup(backup, "pw", { replace: true })).toBe(true);
      expect(store.get(UNREADABLE_JOURNAL_KEY), how).toBeNull();
      b.lock();
    }
  });

  it("this seed's is its journal again: a restore of the seed that wrote it reads it", async () => {
    const store = memoryStorage();
    const a = new WalletSession(store, KDF);
    const phrase = await a.create("pw");
    a.update((j) => {
      j.chainIndexes.evm = 7;
    });
    // another wallet replaced it here, and its unlock set this one's journal aside
    const own = store.get(JOURNAL_KEY)!;
    a.lock();
    const other = new WalletSession(store, KDF);
    await other.create("other", undefined, { replace: true });
    other.lock();
    store.set(UNREADABLE_JOURNAL_KEY, own);
    const back = new WalletSession(store, KDF);
    await back.restoreFromPhrase(phrase, "new password", { replace: true });
    expect(back.journal().chainIndexes.evm, "its journal again").toBe(7);
    expect(store.get(UNREADABLE_JOURNAL_KEY), "no longer set aside").toBeNull();
    back.lock();
    expect(await back.unlock("new password")).toBe(true);
    expect(back.journal().chainIndexes.evm, "stored as the journal").toBe(7);
  });
});

describe("a restore's counters, whenever its tab closes (audit round 2, n71)", () => {
  it("the first journal a restore writes holds them; an unlock that finds a keystore and no journal holds them too", async () => {
    const store = memoryStorage();
    const first: { journal?: string } = {};
    const watched = {
      ...store,
      set: (k: string, v: string) => (k === JOURNAL_KEY && first.journal === undefined && (first.journal = v), store.set(k, v)),
    } as KeyValueStorage;
    const s = new WalletSession(watched, KDF);
    await s.restoreFromPhrase(seedToPhrase(generateMasterSeed()), "pw");
    const seed = s.state().seed!.slice();
    expect(decryptJournal(journalKey(seed), JSON.parse(first.journal!))?.countersHeld, "held in the first write").toBe(true);
    s.lock();
    // the tab closed after the keystore's write, before the journal's
    store.remove(JOURNAL_KEY);
    noteStore.clear();
    expect(await s.unlock("pw")).toBe(true);
    expect(noteStore.serialize().countersHeld, "held until one complete scan").toBe(true);
    s.lock();
  });
});
