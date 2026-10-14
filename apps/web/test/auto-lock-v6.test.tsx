// @vitest-environment happy-dom
// Auto-lock on the page (spec v2.0 §8; doc §18; V6 Stage 15): the platform's listeners over the engine's controller — 15
// idle minutes by default, the minutes chosen under Security, activity, a hidden tab, pagehide —; a lock forgets the
// drafts and the runners' caches; the unlock goes back to the interrupted screen (an in-app path only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getOperation, newOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { lockedAutomatically, lockedElsewhere, startAutoLock, stepAside } from "../src/platform/autoLock";
import { Unlock } from "../src/features/onboarding/Lock";
import { returnPath } from "../src/app/Gate";
import { SecurityRoute } from "../src/features/more/MoreRoutes";

const MIN = 60_000;
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
  resetOperationsMemory();
});
const start = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stops.push(startAutoLock());
};

describe("auto-lock on the page", () => {
  it("15 idle minutes by default; a key press starts the clock again", () => {
    start();
    vi.advanceTimersByTime(14 * MIN);
    fireEvent.keyDown(window, { key: "a" });
    vi.advanceTimersByTime(14 * MIN);
    expect(session.isUnlocked()).toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(session.isUnlocked()).toBe(false);
  });

  it("the minutes chosen under Security; the choice is kept in the journal's settings", () => {
    render(
      <MemoryRouter>
        <SecurityRoute />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("auto-lock-1"));
    expect(settings.get().autoLockMinutes).toBe(1);
    expect(session.journal().settings?.autoLockMinutes).toBe(1);
    start();
    vi.advanceTimersByTime(MIN + 100);
    expect(session.isUnlocked()).toBe(false);
  });

  it("another tab unlocked (a V6 follow-up): the lock waits for the hand-over to end, and the lock screen says why", () => {
    start();
    const release = session.hold("hand-over");
    stepAside();
    expect(session.isUnlocked(), "never inside a hand-over").toBe(true);
    release();
    expect([session.isUnlocked(), lockedAutomatically(), lockedElsewhere()]).toEqual([false, true, true]);
    render(
      <MemoryRouter>
        <Unlock />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("locked-elsewhere").textContent).toBe("The wallet was opened in another tab, so it locked here.");
  });

  it("pagehide locks at once", () => {
    start();
    window.dispatchEvent(new Event("pagehide"));
    expect(session.isUnlocked()).toBe(false);
  });

  it("five minutes in a hidden tab", () => {
    start();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5 * MIN + 100);
    expect(session.isUnlocked()).toBe(false);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("a lock forgets the drafts (the store's own lock hook)", () => {
    const draft = newOperation({
      kind: "send",
      amounts: { asset: "USDC", decimals: 6, input: "2500000000" },
      destination: { kind: "entered", display: "0x43…82C1", chain: "ethereum" },
      tier: "standard",
    });
    expect(getOperation(draft.id)).not.toBeNull();
    session.lock();
    expect(getOperation(draft.id)).toBeNull();
  });

  it("an automatic lock is told apart from the Lock button (the unlock returns to the screen only after the first)", async () => {
    start();
    vi.advanceTimersByTime(16 * MIN);
    expect([session.isUnlocked(), lockedAutomatically()]).toEqual([false, true]);
    vi.useRealTimers();
    expect(await session.unlock("pw")).toBe(true);
    session.lock();
    expect(lockedAutomatically(), "the Lock button").toBe(false);
  });

  it("the unlock goes back to the interrupted screen, an in-app path only", () => {
    expect(returnPath({ from: "/swap/progress/op_1" })).toBe("/swap/progress/op_1");
    expect(returnPath(null)).toBe("/");
    expect(returnPath({ from: "//evil.example/x" })).toBe("/");
    expect(returnPath({ from: "https://evil.example" })).toBe("/");
    expect(returnPath({ from: "/unlock" })).toBe("/");
  });
});
