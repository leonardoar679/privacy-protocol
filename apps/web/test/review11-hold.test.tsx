// @vitest-environment happy-dom
// The hold to confirm and a button that turns disabled midway (the eleventh review round's local run, 2026-11-04): the Review's
// confirm returns while the Review is not ready, and the button had read `disabled` only when the hold began — a hold that ended
// while the network was flagged gone a moment filled its ring and confirmed nothing, without a word, and the run waited out its
// seven minutes. Such a hold is cancelled now, its ring empty again; held once more when the button can confirm, it fires once.
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HoldButton } from "@privacy-wallet/ui";
import { holdMs } from "@privacy-wallet/sdk/tiers";
// 40 ms under test (test/setup.ts) is shorter than a few of the button's 16 ms ticks and React's commits on a loaded machine: this test
// holds 480 ms, so each step it times lands inside the hold
const HOLD_MS = Math.max(holdMs(), 480);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a hold whose button turns disabled midway (the eleventh review round's local run)", () => {
  it("is cancelled — the ring empty, nothing confirmed — and a hold once the button can confirm again fires once", async () => {
    const onConfirm = vi.fn();
    const container = document.createElement("div");
    const render = (disabled: boolean) => root!.render(<HoldButton label="Confirm" holdMs={HOLD_MS} onConfirm={onConfirm} disabled={disabled} />);
    await act(async () => {
      root = createRoot(container);
      render(false);
    });
    const b = container.querySelector("button") as HTMLButtonElement;
    const ring = () => container.querySelector(".ds-hold-ring")!.getAttribute("data-progress");
    await act(async () => {
      b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await sleep(HOLD_MS / 3);
    });
    expect(Number(ring()), "the hold is filling").toBeGreaterThan(0);
    // each render in an act of its own: React 19's act commits an update only when its scope ends, so a render and a wait in one act
    // had the button learn it was disabled only after the hold had run out
    await act(async () => {
      render(true); // the Review no longer ready: the network flagged gone a moment
    });
    await act(async () => {
      await sleep(HOLD_MS * 3);
    });
    expect(onConfirm, "nothing confirmed while it could not be").not.toHaveBeenCalled();
    expect(ring(), "the ring empty again — before, it filled and stayed full").toBe("0.00");
    await act(async () => {
      render(false);
    });
    await act(async () => {
      await sleep(HOLD_MS);
    });
    expect(onConfirm, "re-enabled: a hold that was cancelled does not fire by itself").not.toHaveBeenCalled();
    await act(async () => {
      b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await sleep(HOLD_MS * 3);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("control: a hold that stays enabled to its end fires once and keeps its ring full", async () => {
    const onConfirm = vi.fn();
    const container = document.createElement("div");
    await act(async () => {
      root = createRoot(container);
      root.render(<HoldButton label="Confirm" holdMs={HOLD_MS} onConfirm={onConfirm} />);
    });
    const b = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await sleep(HOLD_MS * 3);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".ds-hold-ring")!.getAttribute("data-progress")).toBe("1.00");
  });
});
