// A session pinned to its opening (the sixth review round, 2026-11-03): a scheduled runner's tick reads and writes the journal
// through it, and both are refused once the wallet was locked or another phrase replaced it in the same tab — a late write had
// gone into whichever journal was open then. Everything else is the session itself.
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/wallet/storage";
import { SessionChanged, WalletSession } from "../src/wallet/session";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("WalletSession.pinned", () => {
  it("reads and writes the journal while the opening lasts; refuses after a lock and after a replace; the rest is the session itself", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("a strong password", new Uint8Array(32).fill(1));
    const p = s.pinned();
    expect(p.isUnlocked()).toBe(true);
    expect(p.epoch()).toBe(s.epoch());
    p.update((j) => {
      j.activity = [...(j.activity ?? []), { id: "x:1", kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", at: 1 } as never];
    });
    expect(p.journal().activity?.length).toBe(1);
    expect(s.journal().activity?.length, "the same journal").toBe(1);
    s.lock();
    expect(() => p.journal()).toThrow(SessionChanged);
    expect(() => p.update(() => {})).toThrow(/locked or replaced since this run began/);
    expect(p.isUnlocked(), "the session's own state still answers").toBe(false);
    await s.create("another password", new Uint8Array(32).fill(2), { replace: true });
    expect(s.isUnlocked()).toBe(true);
    expect(
      () =>
        p.update((j) => {
          j.activity = [];
        }),
      "another wallet's journal: refused",
    ).toThrow(SessionChanged);
    expect(s.journal().activity ?? [], "untouched").toEqual([]);
    const q = s.pinned();
    expect(() => q.journal()).not.toThrow();
  });
});
