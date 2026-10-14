// @vitest-environment happy-dom
// The Swap's V5 layer (spec §3.6–§3.9, §3.12, §11–§13): the band's checks (the strict quote, the provider's health,
// the slippage cap), the $80K staged plan of four quarters, the progress words in Simple (never a step counter), the
// recovery card (a refund or monitoring, never a retry), the Review's cross-chain sentence and protection line, the
// §3.8 notice, Compare routes, and the operation record of an order from the journal and the tracker.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { createCampaign, withCampaignState, withTrancheState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { RiskDb, RISK_DB_DIR } from "@privacy-wallet/swap-engine/risk/riskDb";
import { recommendProtection } from "@privacy-wallet/swap-engine/risk/protection";
import type { QuoteSet as EngineQuoteSet } from "@privacy-wallet/swap-engine/engine";
import { CompareRoutes } from "../src/features/swap/CompareRoutes";
import { ProtectedExecutionNotice } from "../src/features/swap/ProtectedExecutionNotice";
import { cappedSlippageBps, healthyProviders, providerHealthy, strictQuote } from "../src/features/swap/protectedChecks";
import { CampaignProgress } from "../src/features/swap/protected/CampaignProgress";
import { swapRecordId, syncSwapRecord } from "../src/features/swap/records";
import { Review } from "../src/features/review/ReviewScreen";
import { Recovery } from "../src/features/operations/RecoveryCard";
import { getOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { buildCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { controlsFor, PROTECTED_EXECUTION } from "@privacy-wallet/sdk/tiers";
import type { Protection, QuoteSet } from "@privacy-wallet/sdk/swapService";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { record } from "./helpers/operations";

afterEach(() => { cleanup(); session.forget(); resetOperationsMemory(); });

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const eth = (n: number) => BigInt(n) * 10n ** 18n;
const nowS = () => Math.floor(Date.now() / 1000);
const DEST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const quoteOf = (provider: string, amount: bigint, over: Record<string, unknown> = {}) => ({ provider, category: "A", toAmount: ((amount * 3n) / 100n / 10n ** 10n).toString(), toAmountMin: ((amount * 3n) / 100n / 10n ** 10n - 1000n).toString(), fees: [], etaSeconds: 1400, expiresAt: nowS() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now(), impactBps: 9, limits: {}, ...over });
const score = (provider: string, filtered?: string) => ({ provider, total: 90, components: { price: 90, security: 69, privacy: 80, latency: 80, liquidity: 90, reliability: 100 }, ...(filtered ? { filtered } : {}) });

describe("the band's checks (spec §3.8, §11)", () => {
  it("the strict quote: at least a minute left, the minimum within 50 bps of the estimate; the slippage request capped at 50", () => {
    expect(strictQuote({ expiresAt: nowS() + 120, toAmount: "1000000", toAmountMin: "996000" }, nowS()).ok).toBe(true);
    const short = strictQuote({ expiresAt: nowS() + 30, toAmount: "1000000", toAmountMin: "996000" }, nowS());
    expect(short).toMatchObject({ ok: false, code: "quote_ttl_short" });
    const wide = strictQuote({ expiresAt: nowS() + 600, toAmount: "1000000", toAmountMin: "990000" }, nowS());
    expect(wide).toMatchObject({ ok: false, code: "slippage_too_wide" });
    expect(cappedSlippageBps(100)).toBe(PROTECTED_EXECUTION.MAX_SLIPPAGE_BPS);
    expect(cappedSlippageBps(25)).toBe(25);
  });
  it("the provider's health: an open breaker, a security score under 60 or an incident within a day fails; a healthy route passes; the next healthy route is quoted", () => {
    const base = { security: { total: 69 }, incidents: [] as { date: string }[], breaker: { open: null } as never };
    expect(providerHealthy(base).ok).toBe(true);
    expect(providerHealthy({ ...base, breaker: { open: "three failures" } as never })).toMatchObject({ ok: false, code: "provider_unhealthy" });
    expect(providerHealthy({ ...base, security: { total: 59 } })).toMatchObject({ ok: false, code: "provider_unhealthy" });
    expect(providerHealthy({ ...base, incidents: [{ date: new Date(Date.now() - 3600_000).toISOString() }] })).toMatchObject({ ok: false, code: "provider_unhealthy" });
    expect(providerHealthy({ ...base, incidents: [{ date: new Date(Date.now() - 3 * 86_400_000).toISOString() }] }).ok).toBe(true);
    expect(providerHealthy(undefined).ok).toBe(true);
    const set = { scores: [score("thorchain"), score("chainflip"), score("mayan", "quote expired")], risk: { thorchain: { ...base, breaker: { open: "stalls" } }, chainflip: base } } as unknown as Pick<QuoteSet, "scores" | "risk">;
    expect(healthyProviders(set)).toEqual(["chainflip"]);
  });
  it("$80K at the band: the service recommends four sequential quarters and the wallet's plan cuts exactly them, sequential, under a 30-minute window", () => {
    const amount = eth(32); // $80K at $2,500
    const quotes: EngineQuoteSet = { quotes: [quoteOf("thorchain", amount) as never], errors: {}, health: { thorchain: { provider: "thorchain", reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() } } as never, scores: [score("thorchain") as never], chosen: score("thorchain") as never, links: {}, policy: "balanced", competition: [] };
    const p = recommendProtection({ set: quotes, req: { from: ETH, to: BTC, amount, destination: DEST, slippageBps: 50 } as never, amount, tier: "large-protected", mode: "balanced", usdPerUnit: 2500, db: RiskDb.load(RISK_DB_DIR), rng: () => 0.5 })!;
    expect(p).toMatchObject({ capBps: 2500, bandBps: [2500, 2500], concurrency: "sequential", estimatedTranches: 4 });
    expect(p.executeWindowSeconds).toBeLessThanOrEqual(PROTECTED_EXECUTION.MAX_EXECUTE_WINDOW_S);
    const set = { ...quotes, protection: p as unknown as Protection } as unknown as QuoteSet;
    const c = buildCampaign({ quotes: set, provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT, token: null }, to: BTC, amount, tier: "large-protected", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: 80_000, now: Date.now(), rng: () => 0.5 });
    expect(c.tranches.map((t) => BigInt(t.amount))).toEqual([eth(8), eth(8), eth(8), eth(8)]);
    expect(c.plan).toMatchObject({ capBps: 2500, concurrency: "sequential", maxParallel: 1, exact: true });
    expect(controlsFor("large-protected")).toMatchObject({ hold: true, protectedExecution: true, campaign: false });
  });
});

/** A $10M ETH → BTC campaign of fifty 50 ETH steps: two settled, one executing (the campaign-screens fixture). */
function campaign(): Campaign {
  const T0 = Date.parse("2026-10-08T12:00:00Z");
  const pieces = Array.from({ length: 50 }, () => eth(50));
  let c = createCampaign({
    id: "0x" + "c1".repeat(32), now: T0, mode: "balanced", tier: "institutional", request: { from: ETH, to: BTC, amount: eth(2500).toString(), preference: "balanced" },
    bounds: { orderId: "0x" + "c1".repeat(32), assetIn: ETH, chainIn: "ethereum", amountInLimit: eth(2500).toString(), assetOut: BTC, chainOut: "bitcoin", destination: { kind: "fresh-per-tranche" }, minimumOutput: "2985000000000000", expiry: Math.floor(T0 / 1000) + 86400 * 3, maxFeeBps: 100, maxExternalExposure: eth(50).toString(), executeWindowSeconds: 7200 },
    plan: { riskClass: "R5", bandBps: [200, 200], capBps: 200, sizing: "varied", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 50, estimatedSeconds: 150000, shapeNotes: false },
    pieces, referenceRateE18: 3_000_000_000_000_000n, riskSnapshot: { privacyScore: 72 },
  });
  c = { ...c, provider: "thorchain", policy: "privacy-execution", value: { usd: 10_000_000, at: T0 } };
  c = withCampaignState(c, "running", T0 + 1000);
  for (const i of [0, 1]) {
    c = withTrancheState(c, i, "executing", T0 + 1000 + 2000 * i, { orderId: `0x${i}`, handedOverAt: T0 + 1000 + 2000 * i, jobId: `job-${i}`, provider: "thorchain" });
    c = withTrancheState(c, i, "settled", T0 + 2000 + 2000 * i, { settledAt: T0 + 2000 + 2000 * i, outcome: { delivered: eth(50).toString() } });
  }
  return withTrancheState(c, 2, "executing", T0 + 5000, { orderId: "0x2", handedOverAt: T0 + 5000, jobId: "job-2", provider: "thorchain" });
}

describe("the words (spec §3.8, §3.9, §3.12)", () => {
  it("the progress in Simple: the headline with the value, the four amounts, the checks — never 'Tranche' or 'Step k of n'; Advanced shows the counter", () => {
    render(<CampaignProgress campaign={campaign()} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(screen.getByTestId("campaign-headline").textContent).toBe("Your $10,000,000 swap is being completed in protected steps.");
    expect(screen.getByTestId("campaign-step").textContent).toBe("Executing in protected steps");
    expect(text).not.toMatch(/Tranche|Step \d+ of/);
    expect(screen.getByTestId("campaign-checks").textContent).toContain("✓ Route healthy");
    expect(screen.getByTestId("campaign-checks").textContent).toContain("✓ Destination verified");
    expect(within(screen.getByTestId("campaign-amounts")).getByText("In progress")).toBeInTheDocument();
    expect(screen.getByTestId("protection-bar").querySelectorAll("rect")).toHaveLength(4);
    cleanup();
    render(<CampaignProgress campaign={campaign()} advanced onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("campaign-step").textContent).toBe("Step 3 of ~50");
  });
  it("the recovery card: a cross-chain order needing attention offers monitoring and the refund — never a retry; a failure before the signature offers a new quote", () => {
    const onRefund = vi.fn(), onMonitor = vi.fn();
    const swap = record({ id: "swap:1", kind: "cross-chain", state: "RECOVERY_REQUIRED", refs: { txHashes: ["0x" + "ab".repeat(32)], orderId: "0x1" }, reason: { code: "execute_failed", fundsClass: "still-protected" }, recovery: { state: "refund-offered", since: 1 } });
    render(<Recovery record={swap} onMonitor={onMonitor} onRefund={onRefund} />);
    expect(screen.getByText("Something needs attention")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-funds").textContent).toBe("Your protected funds are safe.");
    expect(screen.getByText("Recovery options:")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("recovery-refund"));
    fireEvent.click(screen.getByTestId("recovery-monitor"));
    expect(onRefund).toHaveBeenCalledTimes(1);
    expect(onMonitor).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll("button")].some((b) => /retry/i.test(b.textContent ?? "")), "never a blind Retry").toBe(false);
    expect(document.body.textContent).toContain("The same transaction is never sent twice");
    cleanup();
    const send = record({ id: "send:1", kind: "send", state: "FAILED", reason: { code: "simulation_failed", fundsClass: "not-moved" } });
    render(<Recovery record={send} onNewQuote={() => {}} onRefund={onRefund} />);
    expect(screen.getByTestId("recovery-funds").textContent).toBe("Your funds were not moved.");
    expect(screen.queryByTestId("recovery-refund"), "nothing to refund before the signature").toBeNull();
    expect(screen.getByTestId("recovery-new-quote")).toBeInTheDocument();
  });
  it("the Review on a cross-chain route states the non-atomic sentence verbatim and the protection line; a tap below the band, the hold from it", () => {
    const base = {
      moment: "commit" as const, usd: "$60,000", amount: "24 ETH", from: "Protected ETH", to: { network: "Bitcoin", asset: "BTC", address: DEST, kind: "fresh" as const }, receiveMin: "0.71 BTC",
      privacy: { level: "Good" as const }, lint: [], onAcknowledgeLint: () => {}, lines: [{ id: "price" as const, label: "Price protected", ok: true, meaning: "at least 0.71 BTC" }], crossChain: true, protectedExecution: true, onConfirm: () => {}, onCancel: () => {},
    };
    render(<Review {...base} tier="large" controls={controlsFor("large")} />);
    expect(screen.getByTestId("non-atomic").textContent).toBe("Cross-chain settlement is not atomic: your funds leave first and arrive later, and a failure in between is refunded, not reversed.");
    expect(screen.getByTestId("review-protection").textContent).toContain("✓ Private execution");
    expect(screen.getByTestId("confirm-tap").textContent).toBe("Confirm and commit");
    expect(screen.queryByTestId("hold-to-confirm")).toBeNull();
    cleanup();
    render(<Review {...base} tier="large-protected" controls={controlsFor("large-protected")} />);
    expect(screen.getByTestId("hold-to-confirm")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-tap"), "never a tap at the band").toBeNull();
    expect(document.body.textContent).toContain("Protected transfer");
  });
  it("the §3.8 notice: the four checks and Continue; a failing check is said; Compare routes lists every quote with its outcome and offers the other routes", () => {
    const onContinue = vi.fn();
    render(<ProtectedExecutionNotice checks={{ destination: true, route: false, execution: true, limits: true }} onContinue={onContinue} onBack={() => {}} />);
    expect(screen.getByText("Because this transaction is large, we're using additional execution safeguards.")).toBeInTheDocument();
    expect(screen.getByTestId("protected-execution-checks").querySelector('[data-check="route"]')!.getAttribute("data-ok")).toBe("0");
    expect(document.body.textContent).toContain("A check did not pass");
    fireEvent.click(screen.getByTestId("protected-execution-continue"));
    expect(onContinue).toHaveBeenCalled();
    cleanup();
    const amount = eth(1);
    const quotes = { quotes: [quoteOf("thorchain", amount), quoteOf("chainflip", amount, { plan: { mode: "dca", parts: 20, intervalBlocks: 2, expectedSeconds: 1200 } })], scores: [score("thorchain"), score("chainflip")], errors: {}, chosen: score("thorchain"), links: { thorchain: { public: true, evidence: "memo" } }, competition: [{ provider: "thorchain", outcome: "quoted", ms: 10 }, { provider: "chainflip", outcome: "quoted", ms: 12 }, { provider: "mayan", outcome: "refused", reason: "insufficient liquidity", ms: 9 }] } as unknown as QuoteSet;
    const onUse = vi.fn();
    render(<CompareRoutes open onClose={() => {}} quotes={quotes} to={BTC} advanced onUse={onUse} />);
    const rows = screen.getAllByTestId("route-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("thorchain · Best route");
    expect(rows[1].textContent).toContain("20 parts over");
    expect(screen.getByTestId("route-outcome").textContent).toContain("mayan: refused (insufficient liquidity)");
    fireEvent.click(screen.getByTestId("use-route"));
    expect(onUse).toHaveBeenCalledWith("chainflip");
    // the Swap screen offers the comparison under Advanced only (spec §3.6)
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features/swap/Swap.tsx"), "utf8");
    expect(src).toMatch(/\{advanced \? <CompareRoutes/);
    expect(src).toMatch(/onCompare=\{advanced \? /);
  });
  it("the operation record of an order follows the journal and the tracker: a funded cross-chain order under settlement, a failed execution needing attention, and a completed record that stays terminal", async () => {
    await session.create("a strong password"); session.acknowledgePhrase();
    const stored: StoredSwap = { orderId: "0x" + "0a".repeat(32), attemptId: "0x" + "0b".repeat(32), refundCounter: 1, provider: "thorchain", policy: "balanced", request: { from: ETH, to: BTC, amount: eth(1).toString(), destination: DEST, destinationKind: "fresh" }, params: { amount: eth(1).toString() }, endpoint: "0x" + "0c".repeat(20), createdAt: 1_000, fundedTx: "0x" + "11".repeat(32), state: "funded", tier: "large", approvedMin: "2985000" };
    let rec = syncSwapRecord(stored, { state: "DESTINATION_SUBMITTED", label: "Waiting for destination", steps: [true, true, true, false], detail: "sent", destinationTxHash: "0x" + "22".repeat(32) }, null, 2_000);
    expect(rec).toMatchObject({ v: 2, id: swapRecordId(stored.orderId), kind: "cross-chain", state: "SETTLING", phase: "settlement", tier: "large", amounts: { asset: "ETH", input: eth(1).toString(), minimumOutput: "2985000", outputAsset: "BTC" }, destination: { kind: "fresh", display: DEST, chain: "bitcoin" } });
    expect(rec.refs).toMatchObject({ orderId: stored.orderId, provider: "thorchain", txHashes: [stored.fundedTx, "0x" + "22".repeat(32)] });
    expect(getOperation(rec.id)?.state).toBe("SETTLING");
    rec = syncSwapRecord({ ...stored, jobId: "job-1" }, null, { id: "job-1", escrow: stored.endpoint as `0x${string}`, state: "execute-failed", updatedAt: 3_000, error: "ProviderCallFailed" }, 3_000);
    expect(rec).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "execute_failed", fundsClass: "still-protected" }, recovery: { state: "refund-offered" }, refs: { jobId: "job-1" } });
    expect(rec.history.map((h) => h.state)).toEqual(["SETTLING", "RECOVERY_REQUIRED"]);
    rec = syncSwapRecord(stored, { state: "COMPLETED", label: "Completed", steps: [true, true, true, true], detail: "delivered", deliveredAmount: "2990000" }, { id: "job-1", escrow: stored.endpoint as `0x${string}`, state: "completed", updatedAt: 4_000 }, 4_000);
    expect(rec).toMatchObject({ state: "COMPLETED", amounts: { delivered: "2990000" } });
    rec = syncSwapRecord(stored, { state: "PROVIDER_EXECUTING", label: "Executing", steps: [true, true, false, false], detail: "x" }, null, 5_000);
    expect(rec.state, "I-O1: a completed record never changes").toBe("COMPLETED");
  });
});
