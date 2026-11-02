// The scheduler's last failure, kept for the screens (a V7 follow-up; audit gap 59): a failed action records the error and
// the catalog's code with its backoff; the operation's detail finds it by the order or campaign id; "Try again now" pulls
// the next attempt to now and wakes the scheduler; a done action, or none, is nothing to show.
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession } from "../src/wallet/session";
import { BACKOFF_BASE_MS, completeAction, failedAttempt, isDue, onSchedulerKick, retryNow, scheduleAction } from "../src/wallet/schedule";

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12, deploymentCheck: false })));

async function unlocked() {
  const s = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
  await s.create("pw");
  s.acknowledgePhrase();
  return s;
}

describe("the scheduler's last failure", () => {
  it("a failed action keeps its error and code with the backoff; the operation's detail finds it by the order id; done, it is gone", async () => {
    const s = await unlocked();
    const now = 1_800_000_000_000;
    scheduleAction({ kind: "order-tick", orderId: "0xabc", dueAt: now - 10 }, s);
    expect(failedAttempt("0xabc", s), "nothing failed yet").toBeNull();
    completeAction("order-tick:0xabc", "relayer unreachable", s, now, "relayer_unreachable");
    const a = failedAttempt("0xabc", s);
    expect(a).toMatchObject({
      id: "order-tick:0xabc",
      error: "relayer unreachable",
      errorCode: "relayer_unreachable",
      attempts: 1,
      nextAttemptAt: now + BACKOFF_BASE_MS,
    });
    expect(failedAttempt("0xabc", s), "the journal's own entry, stable between changes").toBe(a);
    expect(failedAttempt("0xother", s)).toBeNull();
    completeAction("order-tick:0xabc", undefined, s, now + 1);
    expect(failedAttempt("0xabc", s), "done: nothing to show").toBeNull();
  });

  it("a campaign's tick is found by the campaign id, and a code the error never had is left out", async () => {
    const s = await unlocked();
    const now = 1_800_000_000_000;
    scheduleAction({ kind: "campaign-tick", orderId: "0xca", dueAt: now - 10 }, s);
    completeAction("campaign-tick:0xca", "the pool moved", s, now);
    expect(failedAttempt("0xca", s)).toMatchObject({ kind: "campaign-tick", error: "the pool moved", attempts: 1 });
    expect(failedAttempt("0xca", s)?.errorCode).toBeUndefined();
  });

  it("Try again now: the next attempt is now, the action due, and the scheduler woken; an unknown id changes nothing", async () => {
    const s = await unlocked();
    const now = 1_800_000_000_000;
    scheduleAction({ kind: "fund-escrow", orderId: "0xfe", dueAt: now + 60_000 }, s);
    completeAction("fund-escrow:0xfe", "No route available right now", s, now, "no_quote");
    expect(isDue(s.journal().schedule[0], now + 1_000), "under its backoff").toBe(false);
    let kicks = 0;
    const off = onSchedulerKick(() => kicks++);
    try {
      expect(retryNow("fund-escrow:0xfe", s, now + 1_000)).toBe(true);
      const a = s.journal().schedule[0];
      expect(a.nextAttemptAt).toBeUndefined();
      expect(a.dueAt).toBe(now + 1_000);
      expect(isDue(a, now + 1_000)).toBe(true);
      expect(a.error, "the failure stays on record until the next attempt answers").toBe("No route available right now");
      expect(kicks).toBe(1);
      expect(retryNow("fund-escrow:0xnone", s, now + 1_000)).toBe(false);
      expect(kicks).toBe(1);
    } finally {
      off();
    }
  });
});
