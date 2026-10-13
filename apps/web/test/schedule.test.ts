// Randomized scheduling (plan §30): due times are uniform inside the policy window, actions live in
// the encrypted journal (survive lock/unlock), and completion / errors are recorded once.
import { describe, it, expect, beforeEach } from "vitest";
import { cancelAction, completeAction, isDue, pendingActions, sampleDueAt, scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("sampleDueAt", () => {
  it("stays inside the window and covers both halves (uniform, not a point mass)", () => {
    const now = 1_000_000_000_000;
    const [min, max] = [6 * 3600, 72 * 3600];
    let early = 0, late = 0;
    for (let i = 0; i < 400; i++) {
      const due = sampleDueAt([min, max], now);
      expect(due).toBeGreaterThanOrEqual(now + min * 1000);
      expect(due).toBeLessThanOrEqual(now + max * 1000);
      if (due < now + ((min + max) / 2) * 1000) early++; else late++;
    }
    expect(early).toBeGreaterThan(100);
    expect(late).toBeGreaterThan(100);
    expect(sampleDueAt([0, 0], now)).toBe(now); // "fastest": no delay
    expect(sampleDueAt([3600, 86400], now, () => 0)).toBe(now + 3600 * 1000);
    expect(sampleDueAt([3600, 86400], now, () => 1)).toBe(now + 86400 * 1000);
    expect(() => sampleDueAt([10, 5], now)).toThrow(/window/);
  });
});

describe("scheduled actions in the journal", () => {
  beforeEach(() => noteStore.clear());

  it("persist across lock/unlock, fire only when due, and record completion or the error", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw");
    const now = Date.now();
    scheduleAction({ kind: "fund-escrow", orderId: "0xaa", dueAt: now + 60_000 }, s);
    scheduleAction({ kind: "fund-escrow", orderId: "0xbb", dueAt: now - 1 }, s);
    scheduleAction({ kind: "fund-escrow", orderId: "0xbb", dueAt: now - 5 }, s); // re-scheduling the same order replaces it
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xaa", "0xbb"]);
    expect(pendingActions(s).filter((a) => isDue(a, now)).map((a) => a.orderId)).toEqual(["0xbb"]);
    expect(isDue(pendingActions(s)[0], now + 61_000)).toBe(true);
    s.lock();
    expect(pendingActions(s)).toEqual([]);
    await s.unlock("pw");
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xaa", "0xbb"]);
    completeAction("fund-escrow:0xbb", undefined, s);
    completeAction("fund-escrow:0xaa", "relayer unreachable", s);
    expect(pendingActions(s).map((a) => a.id)).toEqual(["fund-escrow:0xaa"]); // a failed action stays pending with its error
    const failed = s.journal().schedule.find((a) => a.orderId === "0xaa")!;
    expect(failed.error).toBe("relayer unreachable");
    expect(failed.attempts).toBe(1);
    expect(isDue(failed, failed.dueAt + 1), "not due again before its backoff").toBe(false);
    expect(isDue(failed, failed.nextAttemptAt!)).toBe(true);
    expect(s.journal().schedule.find((a) => a.orderId === "0xbb")?.done).toBe(true);
    cancelAction("fund-escrow:0xaa", s);
    expect(pendingActions(s)).toEqual([]);
    expect(s.journal().schedule.map((a) => a.orderId)).toEqual(["0xbb"]);
  });
});
