// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), slice 2a after its diff critique (T9): the page's side of H11-8 (src/platform/autoLock.ts), and no test
// had dispatched a scroll, a focus or a resume. A scroll is no activity — Chrome's scroll anchoring fires trusted scrolls as the wallet's own
// updates move the page, nobody at the machine — while a pointer still is; a focus on window and a Page Lifecycle resume on document check the
// deadline (a suspend with the page visible ran no timer) and lock at once past it, and neither counts as activity. vi.setSystemTime is the
// machine that slept: the clock moves past the deadline and no timer runs (fake-timers moves the pending ones with it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { lockedAutomatically, lockedElsewhere, startAutoLock } from "../src/platform/autoLock";

const MIN = 60_000;
/** The idle lock: locked, automatically, and not because another tab unlocked. */
const IDLE_LOCK = [false, true, false];
const state = (): boolean[] => [session.isUnlocked(), lockedAutomatically(), lockedElsewhere()];

let stops: (() => void)[] = [];
beforeEach(async () => {
  await session.create("pw");
  session.acknowledgePhrase();
});
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
  session.forget();
  settings.reset();
});
/** The platform's auto-lock over the unlocked session on a fake clock (as auto-lock-v6.test.tsx: 15 idle minutes by default); returns its start. */
const start = (): number => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stops.push(startAutoLock());
  return Date.now();
};

describe("the page's auto-lock events (H11-8)", () => {
  it("a scroll is no activity: one on window, one on document (the viewport's, bubbling) at 14 idle minutes, and the wallet locks at its 15 all the same — Chrome's scroll anchoring fires them as the wallet's own updates move the page", () => {
    start();
    vi.advanceTimersByTime(14 * MIN);
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(session.isUnlocked(), "a scroll locks nothing either").toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(state(), "16 minutes: the idle lock, its clock never restarted").toEqual(IDLE_LOCK);
  });

  it("the control: a pointerdown at 14 idle minutes is activity — unlocked at 16, and the 15 minutes run from it (locked by 30)", () => {
    start();
    vi.advanceTimersByTime(14 * MIN);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(2 * MIN);
    expect(session.isUnlocked(), "the scroll's moments, a pointer instead: unlocked at 16").toBe(true);
    vi.advanceTimersByTime(12 * MIN);
    expect(session.isUnlocked(), "28 minutes: 14 after the pointer").toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(state(), "30 minutes: 16 after the pointer").toEqual(IDLE_LOCK);
  });

  it("a focus on window checks the deadline: the machine slept with the page visible past the 15 minutes and no timer ran — the focus locks at once, as the idle lock", () => {
    const t0 = start();
    vi.setSystemTime(t0 + 16 * MIN);
    expect(session.isUnlocked(), "no timer ran through the sleep").toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(state(), "locked by the focus itself, no timer run").toEqual(IDLE_LOCK);
  });

  it("a Page Lifecycle resume on document checks the deadline the same way (a frozen page runs no timer either): past the 15 minutes, locked at once", () => {
    const t0 = start();
    vi.setSystemTime(t0 + 16 * MIN);
    expect(session.isUnlocked(), "no timer ran while frozen").toBe(true);
    document.dispatchEvent(new Event("resume"));
    expect(state(), "locked by the resume itself, no timer run").toEqual(IDLE_LOCK);
  });

  it("a focus or a resume only checks the deadline, never counts as activity: both at 14 idle minutes, and the wallet locks at its 15 all the same", () => {
    start();
    vi.advanceTimersByTime(14 * MIN);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("resume"));
    expect(session.isUnlocked(), "before the deadline neither locks").toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(state(), "16 minutes: the idle clock ran on through both").toEqual(IDLE_LOCK);
  });
});
