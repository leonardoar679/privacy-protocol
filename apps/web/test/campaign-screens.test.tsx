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
import { createCampaign, withCampaignState, withTrancheState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { MemoryRouter } from "react-router-dom";
import { Review } from "../src/features/review/ReviewScreen";
import { Providers } from "../src/app/Providers";
import { Home } from "../src/features/wallet/Home";
import { Activity } from "../src/features/activity/Activity";
import { Detail } from "../src/features/activity/Detail";
import { Advanced } from "../src/features/more/Advanced";
import { CampaignProgress, campaignStatus } from "../src/features/swap/protected/CampaignProgress";
import { ExposureDashboard, exposureTimeline } from "../src/features/swap/protected/ExposureDashboard";
import { controlsFor } from "@privacy-wallet/sdk/tiers";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { ADDRESS_LIKE, tradeSummary } from "../src/zkapi/tradeCheck";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { feeRowsText } from "../src/features/review/View";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { Protection } from "@privacy-wallet/sdk/swapService";

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
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features/review/ReviewScreen.tsx"), "utf8");
    const block = src.slice(src.indexOf('data-testid="verdict"'), src.indexOf('data-testid="verdict-privacy"'));
    expect(block).toContain('data-testid="verdict-security"');
    expect(src.match(/Safe to execute/g)!.length, "the words appear only in the verdict type and its class choice").toBeLessThanOrEqual(3);
  });

  it("the Review from $100,000 states every fee, the total and the fee statement (the seventh review round: it had stated none)", async () => {
    const fees = feeRowsText(t, {
      kind: "swap",
      fees: [
        { kind: "privacy", usdCents: 1_000_000n, amount: { units: 4n * 10n ** 18n, decimals: 18, displayDecimals: 4, symbol: "ETH" } },
        { kind: "relayer", count: 40, approx: true, usdCents: 50_000n, amount: { units: 2n * 10n ** 17n, decimals: 18, displayDecimals: 4, symbol: "ETH" } },
        { kind: "merges", count: 2, usdCents: null, amount: { units: 10n ** 15n, decimals: 18, displayDecimals: 4, symbol: "ETH" } },
      ],
      totalFeesUsdCents: 1_050_000n,
    });
    const c = await mount(<Review {...reviewProps({ fees })} />);
    const block = c.querySelector('[data-testid="review-fees"]')!;
    expect(block.querySelector('[data-testid="review-fee-privacy"]')!.textContent).toContain("$10,000.00");
    expect(block.querySelector('[data-testid="review-fee-relayer"]')!.textContent).toMatch(/40/);
    expect(block.querySelector('[data-testid="review-fee-merges"]')!.textContent).toContain("0.001 ETH");
    expect(block.querySelector('[data-testid="review-total-fees"]')!.textContent).toContain("$10,500.00");
    expect(block.querySelector('[data-testid="review-fee-statement"]')!.textContent).toMatch(/1 %/);
  });
  it("the progress names what did not arrive as asked and what stays in the balance (the seventh review round)", async () => {
    let c0 = campaign();
    c0 = withTrancheState(c0, 2, "undelivered", T0 + 9000, { orderId: "0x2", provider: "thorchain", outcome: { undelivered: "refunded-at-destination" } });
    c0 = withTrancheState(c0, 3, "skipped", T0 + 9500, { outcome: { kept: true } });
    const c = await mount(<CampaignProgress campaign={c0} onPause={() => {}} onResume={() => {}} onCancel={() => {}} now={T0 + 10_000} />);
    expect(c.querySelector('[data-amount="ended"]')!.textContent).toContain("50 ETH");
    expect(c.querySelector('[data-amount="kept"]')!.textContent).toContain("50 ETH");
    expect(c.textContent).toContain("Not delivered as asked");
    expect(c.textContent).toContain("Kept in your private balance");
  });
  it("V4 (plan §55, §69): the verdict's EXECUTION line, and 'Cross-chain settlement is not atomic' stated on a cross-chain route", async () => {
    const c = await mount(<Review {...reviewProps({ verdict: { security: "Safe to execute", privacy: "Good", why: "security 69/100", execution: "Best available", executionWhy: "2 providers quoted this size; thorchain won on the policy's weights" }, crossChain: true })} />);
    expect(c.querySelector('[data-testid="verdict-execution"]')!.textContent).toBe("Best available ✓");
    expect(c.querySelector('[data-testid="verdict"]')!.textContent).toContain("2 providers quoted this size");
    expect(c.querySelector('[data-testid="non-atomic"]')!.textContent).toContain("Cross-chain settlement is not atomic");
    const only = await mount(<Review {...reviewProps({ verdict: { security: "Review", privacy: "Good", why: "x", execution: "Only route" }, crossChain: false })} />);
    expect(only.querySelector('[data-testid="verdict-execution"]')!.textContent).toBe("Only route");
    expect(only.querySelector('[data-testid="non-atomic"]')).toBeNull();
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
  it("institutional: the device is the tier's rule, asked even when the caller passed none (a Send, a one-order swap) — never confirmed after the platform factor alone (audit round 2, r28)", async () => {
    const onConfirm = vi.fn();
    await session.create("pw"); session.acknowledgePhrase();
    const get = vi.fn(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const c = await mount(<Review {...reviewProps({ moment: "send", tier: "institutional", controls: controlsFor("institutional"), secondFactor: { credentialId: "AQID" }, onConfirm })} />);
    expect(c.textContent).toContain("second confirmation next");
    await hold(c);
    await vi.waitFor(() => expect(c.querySelector('[data-testid="second-device-error"]')?.textContent).toContain("no password fallback"));
    expect(onConfirm, "refused: no device was registered").not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1); // the platform factor only
  });
});

describe("the campaign progress panel (spec §15)", () => {
  it("shows the step, the bar, the four amounts, the status and the buttons; Advanced lists every step", async () => {
    const c0 = campaign();
    const onPause = vi.fn(), onCancel = vi.fn(), onResume = vi.fn();
    let c = await mount(<CampaignProgress campaign={c0} onPause={onPause} onResume={onResume} onCancel={onCancel} now={T0 + 10_000} />);
    expect(c.querySelector('[data-testid="campaign-step"]')!.textContent, "plan §98: never 1/40 unless Advanced").toBe("Executing in protected steps");
    expect(c.querySelector('[data-testid="campaign-step"]')!.getAttribute("data-step")).toBe("3");
    expect(c.querySelector('[data-testid="campaign-status"]')!.textContent).toBe("● Processing");
    expect(campaignStatus(c0)).toEqual({ mark: "●", word: "Processing" });
    const amounts = c.querySelector('[data-testid="campaign-amounts"]')!;
    expect(amounts.querySelector('[data-amount="completed"]')!.textContent).toContain("100 ETH");
    expect(amounts.querySelector('[data-amount="completed"]')!.textContent).toContain("$400K");
    expect(amounts.querySelector('[data-amount="in-flight"]')!.textContent).toContain("50 ETH");
    expect(amounts.querySelector('[data-amount="protected"]')!.textContent).toContain("2350 ETH");
    expect(amounts.querySelector('[data-amount="remaining"]')!.textContent).toContain("2350 ETH");
    const bar = c.querySelector('[data-testid="protection-bar"]')!;
    expect(bar.querySelector('[data-segment="completed"]')!.getAttribute("data-width")).toBe("4%"); // V5: an SVG bar, the widths as attributes
    expect(bar.querySelector('[data-segment="in-flight"]')!.getAttribute("data-width")).toBe("2%");
    expect(bar.querySelector('[data-segment="protected"]')!.getAttribute("data-width")).toBe("94%");
    expect(c.textContent).toContain("Privacy: Good");
    expect(c.textContent).toContain("You can safely leave this screen — keep the wallet unlocked");
    expect(c.textContent).toContain("one step at a time");
    expect(c.querySelector('[data-testid="campaign-steps"]')).toBeNull();
    await act(async () => { button(c, "Pause")!.click(); });
    expect(onPause).toHaveBeenCalledTimes(1);
    await act(async () => { button(c, "Return the rest to my private balance")!.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    c = await mount(<CampaignProgress campaign={c0} advanced onPause={onPause} onResume={onResume} onCancel={onCancel} now={T0 + 10_000} />);
    expect(c.querySelector('[data-testid="campaign-step"]')!.textContent, "Advanced: the counter").toBe("Step 3 of ~50");
    const steps = c.querySelector('[data-testid="campaign-steps"]')!;
    expect(steps.querySelectorAll("[data-tranche]")).toHaveLength(50);
    expect(steps.querySelector('[data-tranche="2"]')!.getAttribute("data-tranche-state")).toBe("executing");
    const dashboard = c.querySelector('[data-testid="exposure-dashboard"]')!;
    expect(dashboard.textContent).toContain("class R5");
    expect(dashboard.textContent).toContain("Expected loss per failure");
    // V4 (plan §110): a step whose last read failed says unknown / reconnecting, never failed
    const unknown = { ...c0, tranches: c0.tranches.map((t) => (t.index === 2 ? { ...t, lastReadFailedAt: T0 + 9000 } : t)) };
    const u = await mount(<CampaignProgress campaign={unknown} advanced onPause={onPause} onResume={onResume} onCancel={onCancel} now={T0 + 10_000} />);
    expect(u.textContent).toContain("1 unknown / reconnecting");
    expect(u.querySelector('[data-tranche="2"]')!.textContent).toContain("unknown / reconnecting");
    expect(u.textContent).not.toMatch(/\bfailed\b/);
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
    expect(d.querySelector('[data-dashboard="provider-limits"]')!.textContent, "V4: in flight per provider against its limit (I6)").toContain("thorchain: 50 ETH");
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
  it("Activity shows one row (the steps only under Advanced); its detail holds the campaign line and the global switch (V6: moved from Home)", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const c0 = campaign();
    putCampaign(c0);
    recordActivity({ id: `campaign:${c0.id}`, kind: "campaign", asset: "ETH", decimals: 18, amount: eth(2500).toString(), status: "running", ref: c0.id, note: "→ BTC" });
    for (const i of [0, 1, 2]) {
      const stored: StoredSwap = { orderId: `0x${i}`, attemptId: "0x", refundCounter: i, provider: "thorchain", policy: "privacy-execution", request: { from: ETH, to: BTC, amount: eth(50).toString(), destination: "bc1q", slippageBps: 50 }, params: { amount: eth(50).toString() }, endpoint: "0xe", createdAt: T0, state: "executing", campaign: { id: c0.id, index: i } };
      session.update((j) => { j.swaps = [...j.swaps, stored]; });
      recordActivity({ id: `swap:0x${i}`, kind: "swap", asset: "ETH", decimals: 18, amount: eth(50).toString(), status: "executing", ref: `0x${i}`, note: "→ BTC · step" });
    }
    putCampaign(c0); // the runner's update keeps the line's "→ BTC ·" (V6 Stage 6: it used to drop it, and the row its target)
    expect(session.journal().activity!.find((l) => l.id === `campaign:${c0.id}`)!.note).toMatch(/^→ BTC · /);
    const home = await mount(<MemoryRouter><Providers deployment={null}><Home /></Providers></MemoryRouter>); // V5: the Home of spec §3.3 reads the session, the deployment context and the connection store
    expect(home.querySelector('[data-testid="campaign-line"]'), "V6 §7.1: no campaign card on Home").toBeNull();
    const cards = home.querySelectorAll('[data-testid="operation-card"]');
    expect(cards, "V6 §7.1: the protected execution in flight raises one card (its steps none)").toHaveLength(1);
    expect(cards[0].textContent).toContain("Executing");
    expect(cards[0].textContent).toContain("ETH → BTC");
    expect(cards[0].textContent, "the value confirmed at its Review, as Activity shows it").toContain("$10,000,000.00");
    expect(cards[0].textContent).toContain("View progress");
    expect(home.querySelector('[data-testid="pause-large-operations"]'), "V6 §7.1: the switch is the detail's").toBeNull();
    expect(home.querySelector('[data-testid="privacy-badge"]')!.textContent, "the badge reads the privacy posture, not the protection mode").toMatch(/^(Protected|Medium protection|Low protection)$/);
    let activity = await mount(<Activity />);
    let rows = [...activity.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("ETH → BTC");
    expect(rows[0].textContent, "the value confirmed at its Review, never re-priced").toContain("$10,000,000.00");
    expect(rows[0].textContent).toContain("Executing");
    expect(rows[0].textContent).not.toContain("Remove");
    const detail = await mount(<MemoryRouter><Detail id={`campaign:${c0.id}`} onBack={() => {}} /></MemoryRouter>);
    const line = detail.querySelector('[data-testid="campaign-line"]')!;
    expect(line.textContent).toContain("● Processing");
    expect(line.textContent, "plan §98").toContain("Executing in protected steps");
    expect(line.querySelector('[data-testid="activity-campaign"]'), "the summary line is Advanced's").toBeNull();
    const sw = line.querySelector('[data-testid="pause-large-operations"]') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await act(async () => { sw.click(); });
    expect(settings.get().protection.pauseLargeOperations).toBe(true);
    expect((session.journal().settings as any).protection.pauseLargeOperations, "journaled").toBe(true);
    settings.set({ advanced: true });
    activity = await mount(<Activity />);
    rows = [...activity.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows).toHaveLength(4);
    const advancedDetail = await mount(<MemoryRouter><Detail id={`campaign:${c0.id}`} onBack={() => {}} /></MemoryRouter>);
    expect(advancedDetail.querySelector('[data-testid="activity-campaign"]')!.textContent, "plan §100").toMatch(/^Execution: .+ · Protection: \$200K max exposure · Privacy: Good · Duration: \d+[hm] /);
  });
  it("the detail's status and line read in the reader's language: a running execution's line, a returned one's status (audit round 2, n84, n93)", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const c0 = campaign();
    putCampaign(c0);
    recordActivity({ id: `campaign:${c0.id}`, kind: "campaign", asset: "ETH", decimals: 18, amount: eth(2500).toString(), status: "running", ref: c0.id, note: "→ BTC" });
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    try {
      let detail = await mount(<MemoryRouter><Detail id={`campaign:${c0.id}`} onBack={() => {}} /></MemoryRouter>);
      let line = detail.querySelector('[data-testid="campaign-line"] p')!.textContent!;
      expect(line).toContain("● 처리 중");
      expect(line).toContain("보호된 단계로 실행 중 · 완료 100 ETH · 진행 중 50 ETH · 보호됨 2350 ETH");
      expect(line, "no English word of the line").not.toMatch(/Processing|Executing|completed|in flight|protected/);
      // returned with delivered steps: the m58 words, in Korean
      putCampaign(withCampaignState(c0, "cancelled", T0 + 9000));
      detail = await mount(<MemoryRouter><Detail id={`campaign:${c0.id}`} onBack={() => {}} /></MemoryRouter>);
      line = detail.querySelector('[data-testid="campaign-line"] p')!.textContent!;
      expect(line).toContain("✓ 반환됨");
      expect(line).not.toContain("Returned");
    } finally {
      act(() => setLocale("en"));
    }
  });
  it("Settings → Protected execution: the mode, the exposure fraction inside 2–3 %, the switch, notifications, the separate device registered cross-platform", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const create = vi.fn(async () => ({ rawId: new Uint8Array([9, 9, 9]).buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get: vi.fn(), create }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const c = await mount(<Advanced deployment={null} />);
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
  it("V4 (plan §92, §128): turning protection off is a two-step with the warning; the enhanced opt-in, concentration and velocity are journaled, nonsense refused", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const c = await mount(<Advanced deployment={null} />);
    const panel = c.querySelector('[data-testid="protected-execution"]')!;
    const on = panel.querySelector('[data-testid="protection-enabled"]') as HTMLInputElement;
    expect(on.checked).toBe(true);
    await act(async () => { on.click(); });
    expect(settings.get().protection.enabled, "not off yet: the warning first").toBe(true);
    expect(panel.querySelector('[data-testid="protection-off-warning"]')!.textContent).toContain("Changing this can reduce protection");
    await act(async () => { button(panel, "I understand, turn it off")!.click(); });
    expect(settings.get().protection.enabled).toBe(false);
    expect(panel.querySelector('[data-testid="protection-off-notice"]')).toBeTruthy();
    await act(async () => { (panel.querySelector('[data-testid="protection-enabled"]') as HTMLInputElement).click(); });
    expect(settings.get().protection.enabled, "back on at once").toBe(true);
    await act(async () => { (panel.querySelector('[data-testid="protect-from-enhanced"]') as HTMLInputElement).click(); });
    expect(settings.get().protection.protectFromEnhanced).toBe(true);
    const share = panel.querySelector('[data-testid="concentration-input"]') as HTMLInputElement;
    await act(async () => { setValue(share, "25"); share.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.providerShareCapBps).toBe(2500);
    await act(async () => { setValue(share, "5"); share.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.providerShareCapBps, "below 10 %: refused").toBe(2500);
    expect(panel.textContent).toContain("stays between 10 % and 100 %");
    const velocity = panel.querySelector('[data-testid="velocity-input"]') as HTMLInputElement;
    await act(async () => { setValue(velocity, "500000"); velocity.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.velocity).toEqual({ maxUsdPer24h: 500_000 });
    await act(async () => { setValue(velocity, ""); velocity.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().protection.velocity).toBeUndefined();
    expect(panel.textContent).toContain("Changing these can reduce protection");
    expect((session.journal().settings as any).protection).toMatchObject({ enabled: true, protectFromEnhanced: true, providerShareCapBps: 2500 });
  });
  it("the trade check carries the protection plan, sanitized; no new protection module says anonymous or atomic", () => {
    const s = tradeSummary({ from: { chain: "ethereum", symbol: "ETH", decimals: 18 }, to: { chain: "bitcoin", symbol: "BTC", decimals: 8 }, amountUnits: eth(400), usd: 1_000_000, tier: "high-value", protection: protection() });
    expect(s.protection).toEqual({ riskClass: "R5", custody: "tss-vaults", bandBps: [200, 200], capBps: 200, steps: "21-100", gate: "destination-final", concurrency: "sequential", elpfUsd: "4000", concentration: "single venue", staged: false });
    expect(JSON.stringify(s)).not.toMatch(ADDRESS_LIKE);
    for (const f of ["../src/features/swap/protected/CampaignProgress.tsx", "../src/features/swap/Swap.tsx", "../src/features/swap/facts.ts", "../src/features/more/Advanced.tsx", "../../../packages/sdk/src/wallet/campaigns.ts", "../../../packages/sdk/src/wallet/campaignRunner.ts", "../../../packages/sdk/src/wallet/alerts.ts", "../../../packages/sdk/src/wallet/notifications.ts", "../../../packages/sdk/src/swapExecute.ts"]) {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), "utf8");
      expect(src, f).not.toMatch(/anonymous|atomic/i);
    }
  });
});
