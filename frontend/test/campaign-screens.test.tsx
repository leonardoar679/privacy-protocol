// @vitest-environment happy-dom
// The protection screens (High-Value Protection spec §14, §15, Stage 5) on synthetic state: the Review's campaign moment
// with the maximum-loss block and the combined verdict (the privacy level is rendered by the same block as "Safe to
// execute": never one without the other), the separate device at institutional (no password fallback), the campaign
// progress panel (step, bar, amounts, the three statuses, pause / resume / return, the reroute Review button, the
// per-step lines under Advanced), Home's campaign line with the global switch, Activity collapsing a campaign's steps
// unless Advanced, Settings → Protected execution (mode, the exposure fraction bounded, the switch, notifications, the
// separate device registered cross-platform), the trade check carrying the plan, and the wording pin.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAddress } from "viem";
import { createCampaign, withCampaignState, withTrancheState, type Campaign } from "@ref/wallet/campaign";
import { Review } from "../src/components/Review";
import { Home } from "../src/components/Home";
import { Activity } from "../src/components/Activity";
import { Settings } from "../src/components/Settings";
import { CampaignProgress, campaignStatus } from "../src/components/protection/CampaignProgress";
import { ExposureDashboard, exposureTimeline } from "../src/components/protection/ExposureDashboard";
import { controlsFor } from "../src/sdk/tiers";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { noteStore } from "../src/wallet/notes";
import { putCampaign } from "../src/wallet/campaigns";
import { recordActivity } from "../src/wallet/activity";
import { ADDRESS_LIKE, tradeSummary } from "../src/zkapi/tradeCheck";
import type { StoredSwap } from "../src/wallet/journal";
import type { Protection } from "../src/sdk/swapService";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); noteStore.clear(); delete (navigator as any).credentials; delete (globalThis as any).PublicKeyCredential; });

const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
const T0 = Date.parse("2026-10-08T12:00:00Z");
const button = (c: ParentNode, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(node); });
  return container;
}
async function hold(c: HTMLElement) {
  const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
  expect(b, "a hold, never a tap").toBeTruthy();
  expect(b.disabled).toBe(false);
  await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
}

/** A $10M ETH → BTC campaign of fifty 50 ETH steps: two settled, one executing. */
function campaign(): Campaign {
  const pieces = Array.from({ length: 50 }, () => eth(50));
  let c = createCampaign({
    id: "0x" + "c1".repeat(32), now: T0, mode: "balanced", tier: "institutional", request: { from: ETH, to: BTC, amount: eth(2500).toString(), preference: "balanced" },
    bounds: { orderId: "0x" + "c1".repeat(32), assetIn: ETH, chainIn: "ethereum", amountInLimit: eth(2500).toString(), assetOut: BTC, chainOut: "bitcoin", destination: { kind: "fresh-per-tranche" }, minimumOutput: "2985000000000000", expiry: Math.floor(T0 / 1000) + 600_000, maxFeeBps: 100, privacyMode: "balanced", maxExternalExposure: eth(50).toString(), executeWindowSeconds: 7200 },
    plan: { riskClass: "R5", bandBps: [200, 200], capBps: 200, sizing: "varied", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 50, estimatedSeconds: 250_000, shapeNotes: false, elpfUsd: 4000 },
    pieces, referenceRateE18: 3_000_000_000_000_000n, riskSnapshot: { privacyScore: 72 },
  });
  c = { ...c, provider: "thorchain", policy: "privacy-execution", value: { usd: 10_000_000, at: T0 } };
  c = withCampaignState(c, "running", T0 + 1000);
  for (const i of [0, 1]) {
    c = withTrancheState(c, i, "executing", T0 + 1000 + 2000 * i, { orderId: `0x${i}`, handedOverAt: T0 + 1000 + 2000 * i, jobId: `job-${i}`, provider: "thorchain" });
    c = withTrancheState(c, i, "settled", T0 + 2000 + 2000 * i, { settledAt: T0 + 2000 + 2000 * i, outcome: { delivered: eth(50).toString() } });
  }
  c = withTrancheState(c, 2, "executing", T0 + 5000, { orderId: "0x2", handedOverAt: T0 + 5000, jobId: "job-2", provider: "thorchain" });
  return c;
}
const protection = (): Protection => ({ provider: "thorchain", riskClass: "R5", flags: [], custody: "tss-vaults", bandBps: [200, 200], capBps: 200, sizing: "varied", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 50, estimatedSeconds: 250_000, trancheUsd: [200_000, 200_000], capUsd: 200_000, trancheImpactBps: 0.18, thinMarket: false, maxPieceUnits: null, concentration: { providers: [{ id: "thorchain", shareBps: 10000 }], singleVenue: true, capBps: 10000 }, elpf: { prior: 0.02, pFailure: 0.02, perTrancheUsd: 4000, perCampaignUsd: 4000 }, staged: false, reasons: ["a bridge / MPC / counterparty route runs one piece at a time (sequential safety mode)"] });

const reviewProps = (over: Partial<React.ComponentProps<typeof Review>> = {}): React.ComponentProps<typeof Review> => ({
  moment: "campaign", tier: "high-value", controls: controlsFor("high-value"), usd: "$1,000,000", amount: "400 ETH", from: "Private ETH, in 40 steps",
  to: { network: "Bitcoin", asset: "BTC", address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", kind: "fresh" }, receiveMin: "11.94 BTC", execution: { words: "Protected execution", detail: "40 steps", eta: "about 2 days" },
  privacy: { level: "Good", score: 72 }, lint: [], onAcknowledgeLint: () => {}, lines: [{ id: "exposure", label: "Exposure bounded", ok: true, meaning: "at most 10 ETH unsettled at once" }, { id: "security", label: "Security assessed", ok: true, meaning: "security 69/100" }],
  maximumLoss: { order: "400 ETH (≈ $1M)", cap: "10 ETH (≈ $25K)", maxExposure: "10 ETH (≈ $25K)", protected: "390 ETH (≈ $975K)", preparation: "40 private withdrawals (one per step) at the relayer's live fee" },
  verdict: { security: "Safe to execute", privacy: "Good", why: "security 69/100 · reliability 100/100 · no incident on record" },
  onConfirm: () => {}, onCancel: () => {}, ...over,
});

describe("the Review's campaign moment (spec §15)", () => {
  it("shows the maximum-loss model and the combined verdict: 'Safe to execute' never without the privacy level; the hold starts the operation", async () => {
    const onConfirm = vi.fn();
    const c = await mount(<Review {...reviewProps({ onConfirm })} />);
    expect(c.querySelector('[data-testid="review"]')!.getAttribute("data-moment")).toBe("campaign");
    expect(c.textContent).toContain("Review the protected swap");
    const loss = c.querySelector('[data-testid="maximum-loss"]')!;
    expect(loss.textContent).toContain("In-flight cap");
    expect(loss.textContent).toContain("10 ETH (≈ $25K)");
    expect(loss.textContent).toContain("Remaining protected");
    expect(loss.textContent).toContain("Preparation cost");
    const verdict = c.querySelector('[data-testid="verdict"]')!;
    expect(verdict.querySelector('[data-testid="verdict-security"]')!.textContent).toBe("Safe to execute");
    expect(verdict.querySelector('[data-testid="verdict-privacy"]')!.textContent).toBe("Good");
    // the pin: wherever "Safe to execute" is rendered, the privacy level is in the same block
    for (const el of [...c.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === "Safe to execute")) {
      expect(el.closest('[data-testid="verdict"]')?.querySelector('[data-testid="verdict-privacy"]')?.textContent).toMatch(/Excellent|Good|Reduced/);
    }
    expect(c.querySelector('[data-line="exposure"]')!.getAttribute("data-ok")).toBe("1");
    expect(c.querySelector('[data-line="security"]')!.getAttribute("data-ok")).toBe("1");
    expect(c.querySelector('[data-testid="confirm-tap"]'), "a hold at high-value").toBeNull();
    await hold(c);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // the Review source renders the two verdict lines from one prop, inside one block
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/components/Review.tsx"), "utf8");
    const block = src.slice(src.indexOf('data-testid="verdict"'), src.indexOf('data-testid="verdict-privacy"'));
    expect(block).toContain('data-testid="verdict-security"');
    expect(src.match(/Safe to execute/g)!.length, "the words appear only in the verdict type and its class choice").toBeLessThanOrEqual(3);
  });

  it("institutional: the separate device is asked after the second factor; without one the confirmation is refused with no password fallback", async () => {
    const onConfirm = vi.fn();
    await session.create("pw"); session.acknowledgePhrase();
    const get = vi.fn(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    // no device registered: refused after the (platform) second factor passed
    let c = await mount(<Review {...reviewProps({ tier: "institutional", controls: controlsFor("institutional"), secondFactor: { credentialId: "AQID" }, secondDevice: { credentialId: undefined }, onConfirm })} />);
    expect(c.textContent).toContain("second confirmation next");
    await hold(c);
    await vi.waitFor(() => expect(c.querySelector('[data-testid="second-device-error"]')).toBeTruthy());
    expect(c.textContent).toContain("no password fallback");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1); // the platform factor only
    // a registered device: asked after the factor, with its own credential; then the confirmation
    c = await mount(<Review {...reviewProps({ tier: "institutional", controls: controlsFor("institutional"), secondFactor: { credentialId: "AQID" }, secondDevice: { credentialId: "BAUG" }, onConfirm })} />);
    await hold(c);
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledTimes(3);
    expect(Array.from((get.mock.calls[2] as any[])[0].publicKey.allowCredentials[0].id)).toEqual([4, 5, 6]);
    // the device declines: no fallback
    get.mockImplementationOnce(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer })).mockImplementationOnce(async () => { throw new Error("NotAllowedError"); });
    c = await mount(<Review {...reviewProps({ tier: "institutional", controls: controlsFor("institutional"), secondFactor: { credentialId: "AQID" }, secondDevice: { credentialId: "BAUG" }, onConfirm })} />);
    await hold(c);
    await vi.waitFor(() => expect(c.querySelector('[data-testid="second-device-error"]')?.textContent).toContain("did not confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-testid="second-factor-password"]'), "no password box for the device").toBeNull();
  });
});

describe("the campaign progress panel (spec §15)", () => {
  it("shows the step, the bar, the four amounts, the status and the buttons; Advanced lists every step", async () => {
    const c0 = campaign();
    const onPause = vi.fn(), onCancel = vi.fn(), onResume = vi.fn();
    let c = await mount(<CampaignProgress campaign={c0} onPause={onPause} onResume={onResume} onCancel={onCancel} now={T0 + 10_000} />);
    expect(c.querySelector('[data-testid="campaign-step"]')!.textContent).toBe("Step 3 of ~50");
    expect(c.querySelector('[data-testid="campaign-status"]')!.textContent).toBe("● Processing");
    expect(campaignStatus(c0)).toEqual({ mark: "●", word: "Processing" });
    const amounts = c.querySelector('[data-testid="campaign-amounts"]')!;
    expect(amounts.querySelector('[data-amount="completed"]')!.textContent).toContain("100 ETH");
    expect(amounts.querySelector('[data-amount="completed"]')!.textContent).toContain("$400K");
    expect(amounts.querySelector('[data-amount="in-flight"]')!.textContent).toContain("50 ETH");
    expect(amounts.querySelector('[data-amount="protected"]')!.textContent).toContain("2350 ETH");
    expect(amounts.querySelector('[data-amount="remaining"]')!.textContent).toContain("2350 ETH");
    const bar = c.querySelector('[data-testid="protection-bar"]')!;
    expect((bar.querySelector('[data-segment="completed"]') as HTMLElement).style.width).toBe("4%");
    expect((bar.querySelector('[data-segment="in-flight"]') as HTMLElement).style.width).toBe("2%");
    expect((bar.querySelector('[data-segment="protected"]') as HTMLElement).style.width).toBe("94%");
    expect(c.textContent).toContain("Privacy: Good");
    expect(c.textContent).toContain("You can safely leave this screen — keep the wallet unlocked");
    expect(c.textContent).toContain("one step at a time");
    expect(c.querySelector('[data-testid="campaign-steps"]')).toBeNull();
    await act(async () => { button(c, "Pause")!.click(); });
    expect(onPause).toHaveBeenCalledTimes(1);
    await act(async () => { button(c, "Return the rest to my private balance")!.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    c = await mount(<CampaignProgress campaign={c0} advanced onPause={onPause} onResume={onResume} onCancel={onCancel} now={T0 + 10_000} />);
    const steps = c.querySelector('[data-testid="campaign-steps"]')!;
    expect(steps.querySelectorAll("[data-tranche]")).toHaveLength(50);
    expect(steps.querySelector('[data-tranche="2"]')!.getAttribute("data-tranche-state")).toBe("executing");
    const dashboard = c.querySelector('[data-testid="exposure-dashboard"]')!;
    expect(dashboard.textContent).toContain("class R5");
    expect(dashboard.textContent).toContain("Expected loss per failure");
  });
  it("the exposure dashboard (Advanced): the figures, the provider exposure, the timeline never above the cap, the per-step table, the pause history", async () => {
    let c0 = withCampaignState(campaign(), "paused", T0 + 20_000, "the provider is skipped", { pause: { reason: "provider-error", detail: "x", at: T0 + 20_000 } });
    c0 = { ...c0, alerts: [{ kind: "provider-degraded", at: T0 + 20_000, text: "The provider is skipped after repeated failures." }] };
    const timeline = exposureTimeline(c0);
    expect(timeline.map((p) => [p.trancheIndex, p.note, p.inFlight])).toEqual([[0, "handed over", eth(50)], [0, "settled", 0n], [1, "handed over", eth(50)], [1, "settled", 0n], [2, "handed over", eth(50)]]);
    for (const p of timeline) expect(p.inFlight).toBeLessThanOrEqual(eth(50)); // I1: never above the cap
    const c = await mount(<ExposureDashboard campaign={c0} now={T0 + 30_000} />);
    const d = c.querySelector('[data-testid="exposure-dashboard"]')!;
    expect(d.querySelector('[data-dashboard="in-flight"]')!.textContent).toContain("50 ETH");
    expect(d.querySelector('[data-dashboard="cap"]')!.textContent).toContain("50 ETH");
    expect(d.querySelector('[data-dashboard="cap"]')!.textContent).toContain("(2 %)");
    expect(d.querySelector('[data-dashboard="provider-exposure"]')!.textContent).toContain("thorchain: 150 ETH");
    expect(d.textContent).toContain("Maximum allowed at once");
    expect(d.textContent).toContain("Expected loss per failure");
    expect(d.textContent).toContain("$4,000");
    expect(d.querySelectorAll('[data-testid="exposure-timeline"] [data-timeline-inflight]')).toHaveLength(5);
    expect(d.querySelectorAll('[data-testid="campaign-steps"] [data-tranche]')).toHaveLength(50);
    expect(d.querySelector('[data-testid="pause-history"]')!.textContent).toContain("paused");
    expect(d.querySelector('[data-testid="pause-history"]')!.textContent).toContain("Provider degraded");
  });
  it("a paused campaign says why and offers Resume; a reroute offers its Review; a finished one stops offering actions", async () => {
    const paused = withCampaignState(campaign(), "paused", T0 + 20_000, "x", { pause: { reason: "provider-error", detail: "The provider is skipped after repeated failures.", at: T0 + 20_000, trancheIndex: 2 } });
    const onResume = vi.fn(), onReroute = vi.fn();
    let c = await mount(<CampaignProgress campaign={paused} onPause={() => {}} onResume={onResume} onCancel={() => {}} onReviewReroute={onReroute} />);
    expect(c.querySelector('[data-testid="campaign-status"]')!.textContent).toBe("⚠ Review");
    expect(c.querySelector('[data-testid="campaign-pause"]')!.textContent).toContain("Provider degraded");
    expect(c.querySelector('[data-testid="campaign-pause"]')!.textContent).toContain("(step 3)");
    expect(button(c, "Pause")).toBeUndefined();
    await act(async () => { button(c, "Resume")!.click(); });
    expect(onResume).toHaveBeenCalledTimes(1);
    const rerouting = withCampaignState(campaign(), "rerouting", T0 + 20_000, "x", { pendingReroute: { provider: "chainflip", at: T0 + 20_000 } });
    c = await mount(<CampaignProgress campaign={rerouting} onPause={() => {}} onResume={() => {}} onCancel={() => {}} onReviewReroute={onReroute} />);
    expect(c.querySelector('[data-testid="campaign-reroute"]')!.textContent).toContain("The route changed to chainflip");
    await act(async () => { button(c, "Review the new route")!.click(); });
    expect(onReroute).toHaveBeenCalledTimes(1);
    const done = withCampaignState(campaign(), "completed", T0 + 30_000);
    c = await mount(<CampaignProgress campaign={done} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(c.querySelector('[data-testid="campaign-status"]')!.textContent).toBe("✓ Completed");
    expect(button(c, "Pause")).toBeUndefined();
    expect(button(c, /Return the rest/)).toBeUndefined();
    expect(c.textContent).not.toContain("keep the wallet unlocked");
  });
});

describe("Home, Activity and Settings (spec §14, §15)", () => {
  it("Home shows the campaign line with the global switch; Activity shows one row and hides the steps unless Advanced", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const c0 = campaign();
    putCampaign(c0);
    recordActivity({ id: `campaign:${c0.id}`, kind: "campaign", asset: "ETH", decimals: 18, amount: eth(2500).toString(), status: "running", ref: c0.id, note: "→ BTC" });
    for (const i of [0, 1, 2]) {
      const stored: StoredSwap = { orderId: `0x${i}`, attemptId: "0x", refundCounter: i, provider: "thorchain", policy: "privacy-execution", request: { from: ETH, to: BTC, amount: eth(50).toString(), destination: "bc1q", slippageBps: 50 }, params: { amount: eth(50).toString() }, endpoint: "0xe", createdAt: T0, state: "executing", campaign: { id: c0.id, index: i } };
      session.update((j) => { j.swaps = [...j.swaps, stored]; });
      recordActivity({ id: `swap:0x${i}`, kind: "swap", asset: "ETH", decimals: 18, amount: eth(50).toString(), status: "executing", ref: `0x${i}`, note: "→ BTC · step" });
    }
    const home = await mount(<Home masterSeed={session.state().seed!} deployment={null} account={null} privacyLevel="Good" onOpen={() => {}} onTab={() => {}} />);
    const line = home.querySelector('[data-testid="campaign-line"]')!;
    expect(line.textContent).toContain("● Processing");
    expect(line.textContent).toContain("Step 3 of ~50");
    const sw = line.querySelector('[data-testid="pause-large-operations"]') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await act(async () => { sw.click(); });
    expect(settings.get().protection.pauseLargeOperations).toBe(true);
    expect((session.journal().settings as any).protection.pauseLargeOperations, "journaled").toBe(true);
    let activity = await mount(<Activity />);
    let rows = [...activity.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Protected swap");
    expect(rows[0].textContent).toContain("In progress");
    expect(rows[0].textContent).not.toContain("Remove");
    settings.set({ advanced: true });
    activity = await mount(<Activity />);
    rows = [...activity.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows).toHaveLength(4);
  });
  it("Settings → Protected execution: the mode, the exposure fraction inside 2–3 %, the switch, notifications, the separate device registered cross-platform", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const create = vi.fn(async () => ({ rawId: new Uint8Array([9, 9, 9]).buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get: vi.fn(), create }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const c = await mount(<Settings deployment={null} readsLine="" coreLine="" />);
    const panel = c.querySelector('[data-testid="protected-execution"]')!;
    expect(panel.textContent).toContain("Maximum safety");
    const radios = [...panel.querySelectorAll('input[name="protection-mode"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(4); // V4: Best execution joins the three
    expect(radios[0].checked).toBe(true);
    await act(async () => { radios[2].click(); });
    expect(settings.get().protection.mode).toBe("max-safety");
    expect((panel.querySelector('[data-testid="exposure-input"]') as HTMLInputElement).value, "V4: Maximum Safety is 1 %").toBe("1.0");
    const exposure = panel.querySelector('[data-testid="exposure-input"]') as HTMLInputElement;
    await act(async () => { setValue(exposure, "2.5"); exposure.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.capBps).toBe(250);
    await act(async () => { setValue(exposure, "6"); exposure.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.capBps, "outside the range: refused").toBe(250);
    expect(panel.textContent).toContain("stays between 1 % and 5 %");
    const sw = panel.querySelector('[data-testid="pause-large-operations"]') as HTMLInputElement;
    await act(async () => { sw.click(); });
    expect(settings.get().protection.pauseLargeOperations).toBe(true);
    await act(async () => { button(panel, "Register a separate device")!.click(); });
    await vi.waitFor(() => expect(settings.get().protection.secondDevice.credentialId).toBe("CQkJ"));
    expect((create.mock.calls[0] as any[])[0].publicKey.authenticatorSelection.authenticatorAttachment).toBe("cross-platform");
    expect(panel.textContent).toContain("no password fallback");
    // the user's settings are journaled
    expect((session.journal().settings as any).protection).toMatchObject({ mode: "max-safety", capBps: 250, pauseLargeOperations: true, secondDevice: { enabled: true, credentialId: "CQkJ" } });
  });
  it("the trade check carries the protection plan, sanitized; no new protection module says anonymous or atomic", () => {
    const s = tradeSummary({ from: { chain: "ethereum", symbol: "ETH", decimals: 18 }, to: { chain: "bitcoin", symbol: "BTC", decimals: 8 }, amountUnits: eth(400), usd: 1_000_000, tier: "high-value", protection: protection() });
    expect(s.protection).toEqual({ riskClass: "R5", custody: "tss-vaults", bandBps: [200, 200], capBps: 200, steps: 50, gate: "destination-final", concurrency: "sequential", elpfUsd: "4000", concentration: "single venue", staged: false });
    expect(JSON.stringify(s)).not.toMatch(ADDRESS_LIKE);
    for (const f of ["../src/components/protection/CampaignProgress.tsx", "../src/wallet/campaigns.ts", "../src/wallet/campaignRunner.ts", "../src/wallet/alerts.ts", "../src/wallet/notifications.ts", "../src/sdk/swapExecute.ts"]) {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), "utf8");
      expect(src, f).not.toMatch(/anonymous|atomic/i);
    }
  });
});
