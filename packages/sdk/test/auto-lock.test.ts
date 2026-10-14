// Auto-lock (spec v2.0 §8; doc §18; V6 Stage 15): the verdict — idle for the chosen minutes, hidden for 5, a hold
// younger than 30 minutes defers, an older one waits for a safe point — and the controller over a manual clock: the idle
// lock, activity resetting it, the hidden lock on its timer and on return (a throttled background timer), pagehide, a
// hold released letting the lock happen, a stuck hold locking at the scheduler's safe point, the hooks a lock runs.
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import {
  AUTO_LOCK_MINUTES,
  AutoLock,
  DEFAULT_AUTO_LOCK_MINUTES,
  HIDDEN_LOCK_MS,
  HOLD_CAP_MS,
  autoLockMinutesOf,
  lockVerdict,
  type AutoLockClock,
} from "../src/session/autoLock";
import { healSettings } from "../src/wallet/settings";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession } from "../src/wallet/session";

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12, deploymentCheck: false })));
const MIN = 60_000;

describe("lockVerdict", () => {
  const base = { now: 0, lastActivity: 0, hiddenSince: null, idleMinutes: 15, holds: [] };
  it("idle for the chosen minutes; hidden for five; whichever comes first", () => {
    expect(lockVerdict({ ...base, now: 15 * MIN - 1 })).toMatchObject({ due: null, nextCheck: 15 * MIN });
    expect(lockVerdict({ ...base, now: 15 * MIN }).due).toBe("idle");
    expect(lockVerdict({ ...base, now: 2 * MIN, idleMinutes: 1 }).due).toBe("idle");
    expect(lockVerdict({ ...base, now: 6 * MIN, hiddenSince: MIN }).due).toBe("hidden");
    expect(lockVerdict({ ...base, now: 3 * MIN, hiddenSince: MIN })).toMatchObject({ due: null, nextCheck: MIN + HIDDEN_LOCK_MS });
  });
  it("a hold younger than the cap defers; past the cap the lock waits for a safe point", () => {
    expect(lockVerdict({ ...base, now: 20 * MIN, holds: [{ reason: "proving", since: 10 * MIN }] })).toMatchObject({
      due: "idle",
      heldBy: "proving",
      atSafePoint: false,
      nextCheck: 10 * MIN + HOLD_CAP_MS,
    });
    expect(lockVerdict({ ...base, now: 45 * MIN, holds: [{ reason: "hand-over", since: 10 * MIN }] })).toMatchObject({
      due: "idle",
      heldBy: null,
      atSafePoint: true,
    });
    expect(lockVerdict({ ...base, now: 45 * MIN, holds: [] })).toMatchObject({ due: "idle", heldBy: null, atSafePoint: false });
  });
  it("another tab unlocked: due at once, before idle or hidden, and deferred by a live hold like every automatic lock", () => {
    expect(lockVerdict({ ...base, now: MIN, elsewhere: true })).toMatchObject({ due: "elsewhere", heldBy: null });
    expect(lockVerdict({ ...base, now: 20 * MIN, hiddenSince: MIN, elsewhere: true }).due).toBe("elsewhere");
    expect(lockVerdict({ ...base, now: MIN, elsewhere: true, holds: [{ reason: "submission", since: 0 }] })).toMatchObject({
      due: "elsewhere",
      heldBy: "submission",
    });
  });
  it("the four choices; anything else is the default", () => {
    expect(AUTO_LOCK_MINUTES).toEqual([1, 5, 15, 60]);
    expect(autoLockMinutesOf(5)).toBe(5);
    expect(autoLockMinutesOf(7)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(healSettings({ autoLockMinutes: 60 }).autoLockMinutes).toBe(60);
    expect("autoLockMinutes" in healSettings({ autoLockMinutes: 7 as never }), "a tampered value is dropped").toBe(false);
    expect("autoLockMinutes" in healSettings(undefined), "absent by default: 15 is read, nothing is written").toBe(false);
  });
});

/** A clock whose time only moves when the test says so; timers fire in order. */
function manualClock(): AutoLockClock & { advance(ms: number): void; t: number } {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const c = {
    t: 0,
    now: () => c.t,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: c.t + ms, fn });
      return seq;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const end = c.t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        c.t = next[1].at;
        next[1].fn();
      }
      c.t = end;
    },
  };
  return c;
}

async function unlocked(clock: AutoLockClock, minutes = 15) {
  const s = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
  await s.create("pw");
  s.acknowledgePhrase();
  const locks: string[] = [];
  const ctrl = new AutoLock({ session: s, minutes: () => minutes, clock, onLock: (why) => locks.push(why) });
  const stop = ctrl.start();
  return { s, ctrl, locks, stop };
}

describe("the controller", () => {
  it("locks after the idle minutes; activity starts the clock again", async () => {
    const clock = manualClock();
    const { s, ctrl, locks } = await unlocked(clock);
    clock.advance(14 * MIN);
    ctrl.activity();
    clock.advance(14 * MIN);
    expect(s.isUnlocked()).toBe(true);
    clock.advance(MIN + 100);
    expect([s.isUnlocked(), locks]).toEqual([false, ["idle"]]);
  });

  it("locks 5 minutes after the tab is hidden, and on return when the hidden timer never ran", async () => {
    const clock = manualClock();
    const { s, ctrl } = await unlocked(clock);
    ctrl.visibility(true);
    clock.advance(HIDDEN_LOCK_MS + 100);
    expect(s.isUnlocked()).toBe(false);

    const c2 = manualClock();
    const u = await unlocked(c2);
    u.ctrl.visibility(true);
    c2.t += 6 * MIN; // a throttled background tab: no timer ran
    u.ctrl.visibility(false);
    expect([u.s.isUnlocked(), u.locks]).toEqual([false, ["hidden"]]);
  });

  it("another tab unlocked (one unlocked tab at a time): the lock at once, or as soon as the critical section ends; the next unlock is this tab's own", async () => {
    const clock = manualClock();
    const { s, ctrl, locks } = await unlocked(clock);
    const release = s.hold("hand-over", clock.now());
    ctrl.stepAside();
    expect(s.isUnlocked(), "never inside a hand-over").toBe(true);
    release();
    expect([s.isUnlocked(), locks]).toEqual([false, ["elsewhere"]]);
    expect(await s.unlock("pw")).toBe(true);
    clock.advance(MIN);
    expect(s.isUnlocked(), "unlocked here again: no leftover step-aside").toBe(true);
    ctrl.stepAside();
    expect([s.isUnlocked(), locks]).toEqual([false, ["elsewhere", "elsewhere"]]);
  });

  it("pagehide locks at once, holds or not", async () => {
    const clock = manualClock();
    const { s, ctrl, locks } = await unlocked(clock);
    s.hold("signature");
    ctrl.pageHide();
    expect([s.isUnlocked(), locks]).toEqual([false, ["pagehide"]]);
  });

  it("a hold defers the idle lock until it is released", async () => {
    const clock = manualClock();
    const { s } = await unlocked(clock);
    const release = s.hold("proving", clock.now());
    clock.advance(20 * MIN);
    expect(s.isUnlocked(), "the hold defers").toBe(true);
    release();
    expect(s.isUnlocked(), "released: the due lock happens").toBe(false);
  });

  it("a hold past 30 minutes: the lock happens at the scheduler's next safe point", async () => {
    const clock = manualClock();
    const { s, locks } = await unlocked(clock);
    s.hold("hand-over", clock.now());
    clock.advance(31 * MIN);
    expect(s.isUnlocked(), "no safe point yet").toBe(true);
    s.safePoint();
    expect([s.isUnlocked(), locks]).toEqual([false, ["idle"]]);
  });

  it("a lock runs the hooks and ends every hold; the idle clock restarts at the next unlock", async () => {
    const clock = manualClock();
    const { s, ctrl } = await unlocked(clock, 1);
    let wiped = 0;
    s.onLock(() => wiped++);
    const release = s.hold("submission", clock.now());
    s.lock();
    expect([wiped, s.holds()]).toEqual([1, []]);
    release(); // a stale release is a no-op
    clock.advance(10 * MIN);
    expect(await s.unlock("pw")).toBe(true);
    clock.advance(30_000);
    expect(s.isUnlocked(), "the unlock restarted the clock").toBe(true);
    clock.advance(31_000);
    expect(s.isUnlocked()).toBe(false);
    void ctrl;
  });
});
