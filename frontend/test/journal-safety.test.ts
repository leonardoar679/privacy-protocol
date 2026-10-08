// Data safety (V2 Stage 4): a journal that fails to decrypt at unlock is kept as it is — the session runs
// on an empty journal, persists nothing, reports the state — and is set aside (never deleted) only when
// the user asks; the next journal write then persists. Every journal write notifies subscribers.
import { describe, it, expect, beforeEach } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { JOURNAL_KEY, memoryStorage, UNREADABLE_JOURNAL_KEY } from "../src/wallet/storage";
import { decryptJournal, journalKey } from "../src/wallet/journal";
import { noteStore } from "../src/wallet/notes";
import { settings } from "../src/wallet/settings";
import { recordActivity } from "../src/wallet/activity";

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
  });
});
