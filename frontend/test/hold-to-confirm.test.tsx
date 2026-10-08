// @vitest-environment happy-dom
// Hold to confirm (whale spec §24, plan V2 §12): a completed pointer hold fires once; an early release
// fires nothing; the keyboard equivalent is holding Enter; a disabled control ignores the pointer.
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HoldToConfirm } from "../src/components/HoldToConfirm";
import { HOLD_MS } from "../src/sdk/tiers";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(onConfirm: () => void, disabled = false) {
  const container = document.createElement("div");
  await act(async () => { root = createRoot(container); root.render(<HoldToConfirm label="Confirm" onConfirm={onConfirm} disabled={disabled} />); });
  return container.querySelector("button") as HTMLButtonElement;
}

describe("HoldToConfirm", () => {
  it("the test hold is short; a completed hold fires once", async () => {
    expect(HOLD_MS).toBeLessThan(200);
    const onConfirm = vi.fn();
    const b = await mount(onConfirm);
    await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await sleep(HOLD_MS * 3); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { await sleep(HOLD_MS); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("an early release fires nothing and resets; a disabled control ignores the pointer", async () => {
    const onConfirm = vi.fn();
    const b = await mount(onConfirm);
    await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await sleep(HOLD_MS / 4); b.dispatchEvent(new Event("pointerup", { bubbles: true })); await sleep(HOLD_MS * 2); });
    expect(onConfirm).not.toHaveBeenCalled();
    const d = await mount(onConfirm, true);
    await act(async () => { d.dispatchEvent(new Event("pointerdown", { bubbles: true })); await sleep(HOLD_MS * 2); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("holding Enter is the keyboard equivalent", async () => {
    const onConfirm = vi.fn();
    const b = await mount(onConfirm);
    await act(async () => { b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(HOLD_MS * 3); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
