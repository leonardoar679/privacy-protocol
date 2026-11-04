// Data safety (V2 Stage 4): a journal that fails to decrypt at unlock is kept as it is — the session runs
// on an empty journal, persists nothing, reports the state — and is set aside (never deleted) only when
// the user asks; the next journal write then persists. Every journal write notifies subscribers.
import { describe, it, expect, beforeEach } from "vitest";
import { assertJournalSaved, JournalNotKept, WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { JOURNAL_KEY, KEYSTORE_KEY, memoryStorage, UNREADABLE_JOURNAL_KEY } from "@privacy-wallet/sdk/wallet/storage";
import { ADDRESS_INDEX_RESERVE, decryptJournal, journalKey, reservedIndexes } from "@privacy-wallet/sdk/wallet/journal";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { commitOrder } from "@privacy-wallet/sdk/swapExecute";
import { startCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { fundEscrow } from "@privacy-wallet/sdk/swapFunding";
import { consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("unreadable journal", () => {
  beforeEach(() => { noteStore.clear(); settings.reset(); });

  it("is kept untouched, reported, and set aside only on request", async () => {
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    const seed = s.state().seed!.slice();
    s.lock();
    const corrupt = JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(64) });
    storage.set(JOURNAL_KEY, corrupt);
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(true);
    expect(s.journal().notes).toEqual([]);
    let notified = 0;
    s.subscribe(() => notified++);
    recordActivity({ id: "a", kind: "shield", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x1" }, s);
    expect(notified, "a journal write notifies the screens").toBe(1);
    expect(s.journal().activity).toHaveLength(1);
    expect(storage.get(JOURNAL_KEY), "the unreadable blob is not overwritten").toBe(corrupt);
    s.discardUnreadableJournal();
    expect(s.state().journalUnreadable).toBe(false);
    expect(storage.get(UNREADABLE_JOURNAL_KEY)).toBe(corrupt);
    const fresh = decryptJournal(journalKey(seed), JSON.parse(storage.get(JOURNAL_KEY)!));
    expect(fresh?.activity?.map((r) => r.id)).toEqual(["a"]);
    recordActivity({ id: "b", kind: "shield", asset: "ETH", decimals: 18, amount: "2", status: "completed", ref: "0x2" }, s);
    expect(decryptJournal(journalKey(seed), JSON.parse(storage.get(JOURNAL_KEY)!))?.activity?.map((r) => r.id)).toEqual(["a", "b"]);
    s.lock();
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(false);
    expect(s.journal().activity?.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("while it is unreadable, no swap is committed, started or funded: its record would be lost at the next lock (audit round 2, r47)", async () => {
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    s.lock();
    storage.set(JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(64) }));
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(true);
    await expect(commitOrder({ session: s } as never)).rejects.toMatchObject({ code: "journal_unreadable" });
    expect(() => startCampaign({ session: s } as never)).toThrow(/journal could not be read/);
    await expect(fundEscrow({ session: s, stored: {} } as never)).rejects.toMatchObject({ code: "journal_unreadable" });
    expect(s.journal().swaps, "nothing journaled in memory either").toEqual([]);
    s.discardUnreadableJournal(); // the user's choice: from here the session saves again
    await expect(commitOrder({ session: s } as never)).rejects.not.toMatchObject({ code: "journal_unreadable" });
  });

  it("while it is unreadable, no fresh address is reserved: the counter would go back at the next lock, the address out again (audit round 2, n48)", async () => {
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    const seed = s.state().seed!.slice();
    const first = consumeFreshAddress(seed, "evm", s);
    s.lock();
    storage.set(JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "22".repeat(64) }));
    expect(await s.unlock("pw")).toBe(true);
    // the journal in memory resumes past the reserve (the tenth review round, D-2): never the first address again — and while unreadable
    // still nothing is reserved
    expect(peekFreshAddress(seed, "evm", s).address, "never the first one again").not.toBe(first.address);
    const resumedAt = { ...s.journal().chainIndexes };
    // at a draw past the reserve (the eleventh review round, F11-7)
    for (const chain of Object.keys(reservedIndexes())) expect(resumedAt[chain] >= ADDRESS_INDEX_RESERVE && resumedAt[chain] < 2 * ADDRESS_INDEX_RESERVE, chain).toBe(true);
    expect(() => consumeFreshAddress(seed, "evm", s)).toThrow(/journal could not be read/);
    expect(s.journal().chainIndexes, "nothing reserved past the resume point").toEqual(resumedAt);
    s.discardUnreadableJournal();
    expect(consumeFreshAddress(seed, "bitcoin", s).index, "saved again: reserved").toBe(resumedAt.bitcoin);
  });

  it("while the browser keeps nothing past this tab, no swap is committed, started or funded: its record would die with the tab (audit round 2, n46)", async () => {
    let refused = true;
    const storage = Object.defineProperty(memoryStorage(), "refused", { get: () => refused });
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    expect(() => assertJournalSaved(s)).toThrow(JournalNotKept);
    await expect(commitOrder({ session: s } as never)).rejects.toMatchObject({ code: "journal_not_kept" });
    expect(() => startCampaign({ session: s } as never)).toThrow(/not keeping the wallet's data/);
    await expect(fundEscrow({ session: s, stored: {} } as never)).rejects.toMatchObject({ code: "journal_not_kept" });
    expect(() => consumeFreshAddress(s.state().seed!, "evm", s), "nor a fresh address (n48)").toThrow(JournalNotKept);
    refused = false; // a browser that keeps it
    expect(() => assertJournalSaved(s)).not.toThrow();
  });

  it("a blob that is not even JSON-shaped is handled the same way; a readable journal never sets the flag", async () => {
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    s.lock();
    storage.set(JOURNAL_KEY, "{not json");
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(true);
    s.discardUnreadableJournal();
    s.lock();
    expect(await s.unlock("pw")).toBe(true);
    expect(s.state().journalUnreadable).toBe(false);
    expect(storage.get(UNREADABLE_JOURNAL_KEY)).toBe("{not json");
    // forgetting the wallet takes the set-aside journal too, not only the keystore and the journal (the audit's unverified m44)
    s.forget();
    expect([storage.get(KEYSTORE_KEY), storage.get(JOURNAL_KEY), storage.get(UNREADABLE_JOURNAL_KEY)]).toEqual([null, null, null]);
  });
});
