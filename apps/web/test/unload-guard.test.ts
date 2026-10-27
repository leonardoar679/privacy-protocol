// @vitest-environment happy-dom
// The unload guard (V7 Stage 16, spec v3.0 §9): leaving the page while a critical section holds the lock off — a wallet
// prompt, a proof, a submission, a hand-over — is confirmed by the browser first; with nothing in progress, or locked, a
// reload is free; a stopped guard listens no more.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { leavingInterrupts, startUnloadGuard } from "../src/platform/unloadGuard";

let stop: (() => void) | null = null;
beforeEach(async () => {
  await session.create("pw");
  session.acknowledgePhrase();
});
afterEach(() => {
  stop?.();
  stop = null;
  session.forget();
});
const leave = (): boolean => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("the unload guard", () => {
  it("asks before leaving only while a hold is live; nothing in progress, or a locked wallet, leaves freely", () => {
    stop = startUnloadGuard();
    expect(leavingInterrupts()).toBe(false);
    expect(leave(), "nothing in progress").toBe(false);
    const release = session.hold("signature");
    expect(leavingInterrupts()).toBe(true);
    expect(leave(), "a wallet prompt is waiting: the browser asks first").toBe(true);
    release();
    expect(leave(), "answered: free again").toBe(false);
    const proof = session.hold("spend");
    session.lock();
    expect(leave(), "a lock ends every hold: nothing to interrupt").toBe(false);
    proof();
  });

  it("a stopped guard listens no more", () => {
    stop = startUnloadGuard();
    const release = session.hold("hand-over");
    expect(leave()).toBe(true);
    stop();
    stop = null;
    expect(leave()).toBe(false);
    release();
  });
});
