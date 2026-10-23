// A tab taking the wallet over reads the journal again (audit c40) — and finds the wallet gone, or another one, or its own
// journal readable at last (audit round 2, n27/n22): a tab waiting for the wallet kept the journal of one forgotten in the
// other tab and wrote it back at its next change, or over the next wallet's journal; and a tab whose journal had not opened
// kept saving nothing after the other tab set it aside and replaced it.
import { describe, expect, it } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { JOURNAL_KEY, KEYSTORE_KEY, memoryStorage } from "../src/wallet/storage";

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
