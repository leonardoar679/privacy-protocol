// @vitest-environment happy-dom
// The hold on the campaign Review (spec §3.9; Stage 12): the local-stack run found the hold inert once "Advanced
// details" was open — the three-line label "(second confirmation next)" shrank to "Keep holding…" under the pointer,
// the browser fired pointerleave and the hold cancelled itself within a frame. The button now keeps its size while
// holding (the full label stays in place under the holding words) and captures the pointer; this pins the DOM shape
// and the Review's path with the details expanded (a browser is the only place the layout shift itself shows).
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HoldButton } from "../src/design-system";
import { Review } from "../src/features/review/ReviewScreen";
import { controlsFor } from "../src/sdk/tiers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LABEL = "Confirm and start the protected execution (second confirmation next)";
const props = (over: Record<string, unknown> = {}): React.ComponentProps<typeof Review> => ({
  moment: "campaign", tier: "institutional", controls: controlsFor("institutional"), usd: "$10,000,250", amount: "2353 ETH", from: "Protected ETH, in 117 steps",
  to: { network: "Bitcoin", asset: "BTC", address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", kind: "fresh" }, receiveMin: "69.99 BTC", execution: { words: "Protected execution", detail: "117 steps", eta: "about 10 days" },
  privacy: { level: "Good", score: 91 }, lint: [], onAcknowledgeLint: () => {}, lines: [{ id: "exposure", label: "Exposure bounded", ok: true, meaning: "at most 47 ETH unsettled at once" }, { id: "security", label: "Security assessed", ok: true, meaning: "security 69/100" }],
  maximumLoss: { order: "2353 ETH (≈ $10M)", cap: "47.06 ETH (≈ $200K)", maxExposure: "47.06 ETH (≈ $200K)", protected: "2305.94 ETH (≈ $9.8M)", preparation: "117 private withdrawals" },
  verdict: { security: "Review", privacy: "Good", why: "security 69/100", execution: "Only route", executionWhy: "only one provider quoted this size" },
  advanced: true, details: { provider: "thorchain", mode: "streaming", parts: 419, fees: "0.28 BTC", expectedOutput: "70.35 BTC for the whole order", settlement: "native deposit address", alternatives: [] },
  secondFactor: { credentialId: undefined }, secondDevice: { credentialId: "BAUG" }, reviewHold: { minutes: 1 }, onExport: () => {},
  onConfirm: () => {}, onCancel: () => {}, ...over,
} as unknown as React.ComponentProps<typeof Review>);
async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { createRoot(container).render(node); });
  return container;
}
const press = (b: HTMLButtonElement) => b.dispatchEvent(new Event("pointerdown", { bubbles: true }));

describe("the hold keeps its size and survives a layout shift (spec §3.9)", () => {
  it("while holding, the full label stays in place (hidden) under the holding words; the accessible name does not change; the hold completes", async () => {
    const onConfirm = vi.fn();
    const c = await mount(<HoldButton label={LABEL} holdMs={60} onConfirm={onConfirm} />);
    const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
    expect(b.textContent).toBe(LABEL);
    await act(async () => { press(b); await new Promise((r) => setTimeout(r, 25)); });
    const hidden = b.querySelector(".ds-hold-hidden");
    expect(hidden?.textContent, "the full label keeps the button's size").toBe(LABEL);
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    expect(b.querySelector(".ds-hold-overlay")?.textContent).toBe("Keep holding…");
    expect(b.getAttribute("aria-label")).toContain(LABEL);
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(b.querySelector(".ds-hold-overlay"), "the holding words leave once the hold fired").toBeNull();
  });
  it("releasing early cancels; the label comes back whole", async () => {
    const onConfirm = vi.fn();
    const c = await mount(<HoldButton label={LABEL} holdMs={200} onConfirm={onConfirm} />);
    const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
    await act(async () => { press(b); await new Promise((r) => setTimeout(r, 40)); b.dispatchEvent(new Event("pointerup", { bubbles: true })); });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(b.querySelector(".ds-hold-hidden")).toBeNull();
    expect(b.textContent).toBe(LABEL);
  });
  it("the campaign Review at institutional: with Advanced details expanded, the hold still leads to the password prompt", async () => {
    const c = await mount(<Review {...props()} />);
    await act(async () => { (c.querySelector('[data-testid="review-advanced-toggle"]') as HTMLButtonElement).click(); });
    expect(c.querySelector('[data-testid="route-details"]')).toBeTruthy();
    const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    await act(async () => { press(b); await new Promise((r) => setTimeout(r, 160)); });
    expect(c.querySelector('[data-testid="second-factor-password"]')).toBeTruthy();
  });
});
