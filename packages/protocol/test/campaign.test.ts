// The shared campaign core (High-Value Protection spec §3–§9): the tranche splitter, the exposure accounting
// with its invariants I1–I5 (the plan's §132 state is unreachable), the gates per class, the bounds, the pause
// detection per reason, and the reducer from every state — including the continuation after a simulated crash
// at each step (never a second funding or hand-over for one tranche).
import { describe, it, expect } from "vitest";
import {
  canPrepare, canRelease, checkWithinBounds, createCampaign, detectPause, exposure, gateFor, ledger, maximumLossModel, nextAction, planTranches, providerLimit, providerShares,
  rateE18, replan, riskierClass, settledBy, stallAfterSeconds, stricterGate, withCampaignState, withTrancheState, FINALITY_MARGIN_SECONDS, MAX_DEVIATION_BPS, MAX_TRANCHES, REFUSED_RETRY_MS, REPLAN_PAUSE, STALL_FLOOR_SECONDS, TRACK_INTERVAL_MS, TooManyTranches,
  type Campaign, type ExecutionBounds, type TranchePlan, type TrancheState,
  swappedInFull, trancheMinimum, unreturnedOf,
} from "../src/wallet/campaign";
import { bucketsFor } from "../src/wallet/amounts";

const ETH = 10n ** 18n;
const USDC = 10n ** 6n;
const seeded = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const isBucket = (x: bigint, d: number) => bucketsFor(d).includes(x);
const bucketish = (x: bigint, d: number) => isBucket(x, d) || bucketsFor(d).some((a) => bucketsFor(d).some((b) => b * 10n >= a && a + b === x));

const bounds = (over: Partial<ExecutionBounds> = {}): ExecutionBounds => ({
  orderId: "0x" + "11".repeat(32), assetIn: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, chainIn: "ethereum",
  amountInLimit: (2353n * ETH).toString(), assetOut: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, chainOut: "bitcoin",
  destination: { kind: "fresh-per-tranche" }, minimumOutput: rateE18(24_000_000n, 800n * ETH).toString(), expiry: 1_800_000, maxFeeBps: 60,
  privacyMode: "balanced", maxExternalExposure: ((2353n * ETH * 250n) / 10000n).toString(), executeWindowSeconds: 7200, ...over,
});
const plan = (over: Partial<TranchePlan> = {}): TranchePlan => ({ riskClass: "R5", bandBps: [200, 300], capBps: 250, sizing: "bucket", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 47, estimatedSeconds: 60_000, shapeNotes: false, ...over });
function campaign(pieces: bigint[], states: TrancheState[] = [], over: Partial<Campaign> = {}, p: Partial<TranchePlan> = {}): Campaign {
  const capBps = BigInt(p.capBps ?? 250); // the cap follows the plan (a real campaign's pieces are at most the cap by construction)
  const c = createCampaign({ id: "c1", now: 1_000_000, mode: "balanced", tier: "institutional", request: { from: bounds().assetIn, to: bounds().assetOut, amount: sum(pieces).toString(), preference: "balanced" }, bounds: bounds({ amountInLimit: sum(pieces).toString(), maxExternalExposure: ((sum(pieces) * capBps) / 10000n).toString() }), plan: plan(p), pieces, referenceRateE18: rateE18(24_000_000n, 800n * ETH) });
  let out = { ...c, ...over };
  states.forEach((s, i) => { out = withTrancheState(out, i, s, 1_000_100 + i); });
  return out;
}

describe("planTranches (§4)", () => {
  it("a $10M ETH order (2,353 ETH): 50 ETH pieces in bucket mode, every piece under the cap, the remainder joins the last piece", () => {
    const r = planTranches(2353n * ETH, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() });
    expect(sum(r.pieces)).toBe(2353n * ETH);
    expect(r.pieces.length).toBe(47);
    expect(r.pieces.slice(0, 46).every((p) => p === 50n * ETH)).toBe(true);
    expect(r.pieces[46]).toBe(53n * ETH);
    expect(r.exact).toBe(1);
    const cap = (2353n * ETH * 250n) / 10000n;
    expect(r.pieces.every((p) => p <= cap)).toBe(true); // I2
  });
  it("varied mode never puts two equal pieces side by side when two sizes fit the band", () => {
    const r = planTranches(2353n * ETH, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "varied", maxParallel: 1, rng: seeded(3) });
    expect(sum(r.pieces)).toBe(2353n * ETH);
    const sizes = new Set(r.pieces.slice(0, -1).map(String));
    expect(sizes.size).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.pieces.length - 1; i++) expect(r.pieces[i]).not.toBe(r.pieces[i - 1]);
    for (const p of r.pieces.slice(0, -1)) expect(bucketish(p, 18)).toBe(true);
  });
  it("$1M in ETH, $10M in USDC and $50M in ETH: common sizes, the whole order, under the cap", () => {
    const m = planTranches(235n * ETH + ETH / 4n, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() });
    expect(m.pieces.slice(0, -1).every((p) => p === 5n * ETH)).toBe(true);
    expect(sum(m.pieces)).toBe(235n * ETH + ETH / 4n);
    const u = planTranches(10_000_000n * USDC, { decimals: 6, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() });
    expect(u.pieces.length).toBe(50);
    expect(u.pieces.every((p) => p === 200_000n * USDC)).toBe(true);
    expect(u.exact).toBe(0);
    const w = planTranches(11_765n * ETH, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() });
    expect(sum(w.pieces)).toBe(11_765n * ETH);
    expect(w.pieces.slice(0, -1).every((p) => p === 250n * ETH)).toBe(true); // 200 + 50: no single bucket sits in 235–294 ETH
    const cap = (11_765n * ETH * 250n) / 10000n;
    expect(w.pieces.every((p) => p <= cap)).toBe(true);
  });
  it("a provider's instant limit or the thin-market rule caps the piece; parallel mode halves the ceiling", () => {
    const capped = planTranches(11_765n * ETH, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, maxPiece: 180n * ETH, rng: seeded() });
    expect(capped.pieces.every((p) => p <= 180n * ETH)).toBe(true);
    expect(sum(capped.pieces)).toBe(11_765n * ETH);
    const par = planTranches(2353n * ETH, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 2, rng: seeded() });
    expect(par.pieces.every((p) => p <= (2353n * ETH * 250n) / 10000n / 2n)).toBe(true);
    expect(sum(par.pieces)).toBe(2353n * ETH);
  });
  it("a zero order plans nothing; an order smaller than every bucket is one exact piece", () => {
    expect(planTranches(0n, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() }).pieces).toEqual([]);
    const tiny = planTranches(123_456n, { decimals: 18, bandBps: [200, 300], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded() });
    expect(sum(tiny.pieces)).toBe(123_456n);
  });
});

describe("exposure (§5)", () => {
  const T = 250_000n * USDC;
  it("completed, in flight, prepared and remaining are separate (I5); only unsettled counts; the §132 state cannot happen", () => {
    const c = campaign([T, T, T, T], ["settled", "executing", "funded", "planned"], {}, { capBps: 2500 }); // a cap of exactly one piece
    const e = exposure(c);
    expect(e.cap).toBe((4n * T * 2500n) / 10000n);
    expect(e.completed).toBe(T);
    expect(e.inFlight).toBe(T);
    expect(e.prepared).toBe(T);
    expect(e.remaining).toBe(T);
    expect(e.protected).toBe(4n * T - T - e.cap);
    expect(canRelease(c, T)).toMatchObject({ ok: false }); // I1: 250K in flight already fills a 250K cap
    const settled = withTrancheState(c, 1, "settled", 2);
    expect(canRelease(settled, T)).toEqual({ ok: true });
    // §132: a 263K piece under a 250K cap is refused by I2 whatever the state of the others
    expect(canRelease(settled, 263_000n * USDC)).toMatchObject({ ok: false, reason: expect.stringContaining("I2") });
    // and the splitter never produces one
    const r = planTranches(10_000_000n * USDC, { decimals: 6, bandBps: [200, 300], capBps: 250, sizing: "varied", maxParallel: 1, rng: seeded(11) });
    expect(r.pieces.every((p) => p <= 250_000n * USDC)).toBe(true);
  });
  it("a partial fill counts its delivered share as completed and the rest as in flight; a refund returns to remaining", () => {
    let c = campaign([T, T, T], ["settled", "executing", "planned"]);
    c = withTrancheState(c, 1, "partial", 3, { outcome: { delivered: (100_000n * USDC).toString(), refunded: (150_000n * USDC).toString() } });
    let e = exposure(c);
    expect(e.completed).toBe(T + 100_000n * USDC);
    expect(e.inFlight).toBe(150_000n * USDC);
    c = withTrancheState(c, 1, "refunded", 4, { outcome: { refunded: T.toString() } }); // what came back: the whole tranche
    e = exposure(c);
    expect(e.completed).toBe(T);
    expect(e.inFlight).toBe(0n);
    expect(e.remaining).toBe(2n * T);
    // the seventh review round: a refund that came back short (its tip, the provider's fees) returns what came back; the rest is spent
    c = withTrancheState(c, 1, "refunded", 5, { outcome: { refunded: (T - 10n * USDC).toString() } });
    e = exposure(c);
    expect(e.ended).toBe(10n * USDC);
    expect(e.remaining).toBe(2n * T - 10n * USDC);
  });
  it("the first tranche settles alone, then parallel mode admits two pieces under the cap; sequential admits one", () => {
    const half = 100_000n * USDC;
    const par = campaign([half, half, half, half, half, half], ["executing", "planned", "planned", "planned", "planned", "planned"], {}, { concurrency: "parallel", maxParallel: 2, capBps: 4000 });
    expect(canRelease(par, half)).toMatchObject({ ok: false, reason: expect.stringContaining("first tranche") });
    const after = withTrancheState(withTrancheState(par, 0, "settled", 2), 1, "executing", 3);
    expect(canRelease(after, half)).toEqual({ ok: true }); // 100K + 100K ≤ 240K
    const seq = campaign([half, half, half], ["settled", "executing", "planned"], {}, { concurrency: "sequential", maxParallel: 1, capBps: 10000 }); // a cap wide enough that only the mode refuses
    expect(canRelease(seq, half)).toMatchObject({ ok: false, reason: expect.stringContaining("sequential") });
    expect(canPrepare(seq)).toMatchObject({ ok: false }); // I4
  });
  it("V4 (contract §3.5): the ledger per provider — the plan's §25 example is admitted under the cap, equal full pieces are refused by I1, a provider above its share by I6", () => {
    const K = 1_000n * USDC;
    // a $10M order, cap $250K (2.5 %), three venues quoting: THORChain $100K + Chainflip $80K + Mayan $70K in flight = $250K
    const pieces = [100n * K, 80n * K, 70n * K, 250n * K, ...Array.from({ length: 38 }, () => 250n * K)];
    const total = sum(pieces);
    let c = campaign(pieces, ["settled", "executing", "executing", "planned"], {}, { capBps: 250, concurrency: "parallel", maxParallel: 3, providerShareCapBps: 3000 });
    c = { ...c, tranches: c.tranches.map((t, i) => (i === 0 ? { ...t, state: "settled" as TrancheState, provider: "thorchain" } : i === 1 ? { ...t, provider: "chainflip" } : i === 2 ? { ...t, provider: "mayan" } : t)) };
    c = withTrancheState(c, 0, "executing", 5, { provider: "thorchain" }); // the first piece flies too: $100K + $80K + $70K
    const e = exposure(c);
    expect(e.inFlight).toBe(250n * K);
    expect(e.byProvider).toEqual({ thorchain: 100n * K, chainflip: 80n * K, mayan: 70n * K });
    const l = ledger(c);
    expect(l).toMatchObject({ orderId: "c1", totalOrderValue: total.toString(), maxExternalExposure: ((total * 250n) / 10000n).toString(), inFlight: (250n * K).toString(), pending: "0", completed: "0" });
    expect(l.byProvider.thorchain).toEqual({ inFlight: (100n * K).toString(), limit: ((total * 3000n) / 10000n).toString() });
    expect(BigInt(l.remaining)).toBe(total - 250n * K);
    // I1: nothing more fits while $250K is unsettled; $250K each from three providers is the plan's §25 counter-example
    expect(canRelease(c, 250n * K, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I1") });
    // I6: with a 30 % share cap a provider that already carries its share is refused even under the global cap
    const share = campaign([250n * K, 250n * K, 250n * K, 250n * K], ["settled", "settled", "settled", "planned"], {}, { capBps: 10000, concurrency: "parallel", maxParallel: 2, providerShareCapBps: 3000 }); // a cap as wide as the order: only I6 and the modes refuse
    const carried = { ...share, tranches: share.tranches.map((t, i) => (i < 3 ? { ...t, provider: "thorchain" } : t)) };
    const flying = withTrancheState(withTrancheState(carried, 0, "executing", 6), 1, "destination-confirmed", 7); // $500K of $1M in flight with THORChain > 30 %
    expect(exposure(flying).inFlight).toBe(500n * K); // destination-confirmed counts as in flight (I3 until the gate)
    // a step coming back counts until its refund lands (the audit round of 2026-10-16, c53): it had counted nowhere
    expect(exposure(withTrancheState(flying, 1, "refunding", 8)).inFlight).toBe(500n * K);
    expect(providerLimit(carried)).toBe(300n * K);
    expect(canRelease(flying, 250n * K, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I6") });
    expect(canRelease(flying, 250n * K, "chainflip")).toMatchObject({ ok: false, reason: expect.stringContaining("first tranche") }); // under the cap and its share, but the first piece is unsettled
    const one = withTrancheState(carried, 0, "executing", 6);
    expect(canRelease(one, 250n * K, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I6") }); // $250K + $250K > $300K: I6 before the first-tranche rule
    expect(canRelease(one, 250n * K, "chainflip")).toMatchObject({ ok: false, reason: expect.stringContaining("first tranche") });
    const after = withTrancheState(withTrancheState(carried, 0, "settled", 6), 1, "executing", 7);
    expect(canRelease(after, 250n * K, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I6") }); // $250K + $250K > $300K
    expect(canRelease(after, 250n * K, "chainflip")).toEqual({ ok: true });
    expect(canRelease(after, 250n * K)).toEqual({ ok: true }); // no provider known yet: the global invariants alone
    // a single venue (share cap 10000) is never refused by I6
    const single = campaign([250n * K, 250n * K, 250n * K, 250n * K], ["settled", "executing", "planned", "planned"], {}, { capBps: 5000, concurrency: "parallel", maxParallel: 2, providerShareCapBps: 10000 });
    expect(canRelease({ ...single, tranches: single.tranches.map((t) => ({ ...t, provider: "thorchain" })) }, 250n * K, "thorchain")).toEqual({ ok: true });
  });
  it("the maximum-loss model and the provider shares", () => {
    const c = campaign([T, T, T, T], ["settled", "executing", "planned", "planned"]);
    const m = maximumLossModel(c);
    expect(m.order).toBe(4n * T);
    expect(m.maxExposure).toBe(m.cap);
    expect(m.protected).toBe(4n * T - m.cap);
    const withProviders = { ...c, tranches: c.tranches.map((t, i) => ({ ...t, provider: i < 2 ? "thorchain" : undefined })) };
    expect(providerShares(withProviders)).toEqual({ thorchain: 2n * T });
  });
});

describe("gates (§6)", () => {
  it("the gate follows the class and Maximum Safety raises every gate", () => {
    expect(gateFor("R5", "balanced")).toBe("destination-final");
    expect(gateFor("R2", "balanced")).toBe("destination-submitted");
    expect(gateFor("R4", "max-privacy")).toBe("destination-submitted");
    expect(gateFor("R1", "balanced")).toBe("source");
    expect(gateFor("R2", "max-safety")).toBe("destination-final");
  });
  it("settledBy: the source gate at source final, the submitted gate at the outbound, the final gate after the chain's margin; an unknown state never settles (I3)", () => {
    const now = 10_000_000;
    expect(settledBy("source", { state: "SOURCE_FINAL", chain: "bitcoin" }, now)).toBe(true);
    expect(settledBy("source", { state: "SOURCE_SUBMITTED", chain: "bitcoin" }, now)).toBe(false);
    expect(settledBy("destination-submitted", { state: "DESTINATION_SUBMITTED", chain: "bitcoin" }, now)).toBe(true);
    expect(settledBy("destination-submitted", { state: "PROVIDER_EXECUTING", chain: "bitcoin" }, now)).toBe(false);
    const seen = now - FINALITY_MARGIN_SECONDS.bitcoin * 1000;
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", chain: "bitcoin", deliveredSince: seen + 1000 }, now)).toBe(false);
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", chain: "bitcoin", deliveredSince: seen }, now)).toBe(true);
    expect(settledBy("destination-final", { state: "COMPLETED", chain: "solana", deliveredSince: now - 60_000 }, now)).toBe(true);
    expect(settledBy("destination-final", { state: "COMPLETED", chain: "base", deliveredSince: now - 60_000 }, now)).toBe(false); // EVM margin 15 min
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", chain: "bitcoin" }, now)).toBe(false); // no delivered time yet
    expect(settledBy("destination-final", { state: "FAILED", chain: "bitcoin", deliveredSince: 0 }, now)).toBe(false);
    expect(settledBy("destination-submitted", { state: "", chain: "bitcoin" }, now)).toBe(false);
  });
});

describe("the bounds (§3)", () => {
  const b = bounds();
  const ok = { amount: 50n * ETH, toAmountMin: 1_500_000n, quoteExpiresAt: 1_700_000, feeBps: 40, destination: "bc1qfresh", fundedBefore: 0n, now: 1_600_000 };
  it("inside the bounds; each bound refuses with its reason", () => {
    expect(checkWithinBounds(b, ok)).toEqual({ ok: true });
    expect(checkWithinBounds(b, { ...ok, fundedBefore: 2353n * ETH - 49n * ETH })).toMatchObject({ ok: false, reason: expect.stringContaining("amount limit") });
    expect(checkWithinBounds(b, { ...ok, now: 1_800_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    expect(checkWithinBounds(b, { ...ok, quoteExpiresAt: 1_900_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("outlives") });
    expect(checkWithinBounds(b, { ...ok, toAmountMin: 1_400_000n })).toMatchObject({ ok: false, reason: expect.stringContaining("minimum you approved") });
    expect(checkWithinBounds(b, { ...ok, feeBps: 61 })).toMatchObject({ ok: false, reason: expect.stringContaining("fee") });
    const entered = bounds({ destination: { kind: "entered", address: "bc1qentered" } });
    expect(checkWithinBounds(entered, { ...ok, destination: "bc1qother" })).toMatchObject({ ok: false, reason: expect.stringContaining("destination") });
    expect(checkWithinBounds(entered, { ...ok, destination: "BC1QENTERED" })).toEqual({ ok: true });
  });

  it("per unit paid to the provider when the confirmation knew its tip: a step's own tip is no worse price (the audit round of 2026-10-16, c55)", () => {
    // the order: 800 ETH quoted at a 24M sat minimum, net of a 0.5 ETH tip; a 50 ETH step pays its own 0.5 ETH tip
    const net = rateE18(24_000_000n, 800n * ETH - ETH / 2n);
    const b = bounds({ minimumOutputNet: net.toString() });
    const min = trancheMinimum(b, 50n * ETH, ETH / 2n);
    expect(min).toBe(((50n * ETH - ETH / 2n) * net) / 10n ** 18n);
    const step = { ...ok, toAmountMin: min + 1n, executorTip: ETH / 2n };
    expect(rateE18(step.toAmountMin, step.amount) < BigInt(b.minimumOutput), "per unit of the escrow it reads below the order's rate").toBe(true);
    expect(checkWithinBounds(b, step)).toEqual({ ok: true });
    expect(checkWithinBounds(b, { ...step, toAmountMin: min - 1n })).toMatchObject({ ok: false, reason: expect.stringContaining("minimum you approved") });
    // a campaign from before (no minimumOutputNet), or a tranche whose tip is not known: per unit of the tranche, as before
    expect(trancheMinimum(bounds(), 50n * ETH, ETH / 2n)).toBe((50n * ETH * BigInt(bounds().minimumOutput)) / 10n ** 18n);
    expect(checkWithinBounds(bounds(), step)).toMatchObject({ ok: false });
    expect(checkWithinBounds(b, { ...step, executorTip: undefined })).toMatchObject({ ok: false });
  });
});

describe("detectPause (§8)", () => {
  const c = campaign([50n * ETH, 50n * ETH], ["executing", "planned"]);
  const healthy = { now: 2_000_000, walletPaused: false, crossRateE18: c.referenceRateE18, liveQuotes: 2, providerHealth: { reliability: 90 } };
  it("V4: the velocity limit pauses with its own reason, after the facts that outrank it", () => {
    const c = campaign([1n * ETH, 1n * ETH], ["settled", "planned"]);
    expect(detectPause(c, { now: 1, walletPaused: false, velocityExceeded: true })).toMatchObject({ reason: "velocity" });
    expect(detectPause(c, { now: 1, walletPaused: true, velocityExceeded: true })).toMatchObject({ reason: "wallet-pause" });
    expect(detectPause(c, { now: 1, walletPaused: false, velocityExceeded: true, boundsViolation: "x" })).toMatchObject({ reason: "velocity" });
  });
  it("null when healthy; each reason in its order of severity", () => {
    expect(detectPause(c, healthy)).toBeNull();
    expect(detectPause(c, { ...healthy, walletPaused: true })?.reason).toBe("wallet-pause");
    expect(detectPause(c, { ...healthy, reconcileNeeded: true })?.reason).toBe("reconcile");
    expect(detectPause(c, { ...healthy, receiverMismatch: true })?.reason).toBe("unexpected-destination");
    expect(detectPause(c, { ...healthy, incidentDates: [c.createdAt + 1] })?.reason).toBe("security-incident");
    expect(detectPause(c, { ...healthy, incidentDates: [c.createdAt - 1] })).toBeNull(); // an old incident is in the score, not a pause
    expect(detectPause(c, { ...healthy, jobState: "execute-failed" })?.reason).toBe("provider-error");
    expect(detectPause(c, { ...healthy, providerHealth: { breakerOpen: true } })?.reason).toBe("provider-error");
    expect(detectPause(c, { ...healthy, delivered: "241000", guaranteedMin: "250000" })?.reason).toBe("anomaly");
    expect(detectPause(c, { ...healthy, delivered: "250000", guaranteedMin: "250000" })).toBeNull();
    expect(detectPause(c, { ...healthy, trackState: "PARTIAL" })?.reason).toBe("anomaly");
    expect(detectPause(c, { ...healthy, settlementAgeSeconds: 10_000, expectedSeconds: 3_000 })?.reason).toBe("anomaly");
    expect(detectPause(c, { ...healthy, hardQuoteRateE18: (BigInt(c.bounds.minimumOutput) - 1n).toString() })?.reason).toBe("price-deviation");
    const ref = BigInt(c.referenceRateE18);
    expect(detectPause(c, { ...healthy, crossRateE18: ((ref * BigInt(10000 - MAX_DEVIATION_BPS - 1)) / 10000n).toString() })?.reason).toBe("price-deviation");
    expect(detectPause(c, { ...healthy, crossRateE18: ((ref * 9950n) / 10000n).toString() })).toBeNull();
    expect(detectPause(c, { ...healthy, providerHealth: { reliability: 59 } })?.reason).toBe("route-degraded");
    expect(detectPause(c, { ...healthy, liveQuotes: 0 })?.reason).toBe("route-degraded");
    expect(detectPause(c, { ...healthy, gasPriceWei: "31", gasPriceAtConfirmationWei: "10" })?.reason).toBe("chain-congestion");
    expect(detectPause(c, { ...healthy, gasPriceWei: "30", gasPriceAtConfirmationWei: "10" })).toBeNull();
    expect(detectPause(c, { ...healthy, boundsViolation: "the fee is above the maximum you approved" })?.reason).toBe("bounds");
  });
});

describe("the reducer (§7): one action per tick, the continuation after a crash, never a duplicate", () => {
  const facts = { now: 1_500_000, pause: null, notesShaped: true };
  const p = 50n * ETH;
  it("starts with the first commit (after shaping when the plan asks), then walks one tranche: fund → sign → hand-over → track", () => {
    const c = campaign([p, p, p], [], {}, { capBps: 4000 }); // three pieces: a cap of one piece and a bit
    expect(nextAction(c, facts)).toEqual({ kind: "commit", index: 0 });
    const shaped = campaign([p, p, p], [], {}, { shapeNotes: true, capBps: 4000 });
    expect(nextAction(shaped, { ...facts, notesShaped: false })).toEqual({ kind: "shape-notes" });
    expect(nextAction(withCampaignState(shaped, "preparing-notes", 1), { ...facts, notesShaped: true })).toEqual({ kind: "commit", index: 0 });
    let r = withCampaignState(c, "running", 1);
    r = withTrancheState(r, 0, "committed", 2);
    expect(nextAction(r, facts)).toEqual({ kind: "fund", index: 0 }); // a crash after the commit resumes here: no second commit
    r = withTrancheState(r, 0, "funded", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "sign", index: 0 }); // never a second funding
    r = withTrancheState(r, 0, "signed", 4);
    expect(nextAction(r, facts)).toEqual({ kind: "hand-over", index: 0 });
    r = withTrancheState(r, 0, "executing", 5);
    expect(nextAction(r, facts)).toEqual({ kind: "track", indexes: [0] }); // never a second hand-over
    r = withTrancheState(r, 0, "destination-submitted", 6);
    expect(nextAction(r, facts)).toEqual({ kind: "track", indexes: [0] }); // sequential: the next waits for the gate
  });
  it("releases the next tranche only after the previous settled and its random delay passed; replans after a refund; completes at the end", () => {
    let r = withCampaignState(campaign([p, p], [], {}, { capBps: 5000 }), "running", 1);
    r = withTrancheState(r, 0, "settled", 2);
    r = withTrancheState(r, 1, "planned", 2, { notBefore: facts.now + 60_000 });
    expect(nextAction(r, facts)).toEqual({ kind: "wait", until: facts.now + 60_000, why: expect.stringContaining("random delay") });
    r = withTrancheState(r, 1, "planned", 2, { notBefore: facts.now - 1 });
    expect(nextAction(r, facts)).toEqual({ kind: "commit", index: 1 });
    r = withTrancheState(r, 1, "refunded", 3);
    // the seventh review round (B1): swapping a returned step again pays its fees again — the user's word first, then the re-plan
    const ask = nextAction(r, facts);
    expect(ask).toMatchObject({ kind: "pause", reason: "bounds", detail: expect.stringContaining(REPLAN_PAUSE) });
    expect(ask).toMatchObject({ replan: true });
    r = withCampaignState(withCampaignState({ ...withCampaignState(r, "paused", 4, (ask as { detail: string }).detail), replanAskedAt: 4 }, "reassessing", 5), "running", 6);
    expect(nextAction(r, facts)).toEqual({ kind: "replan" });
    // a step that comes back later is asked about again: a resume from another pause, before the question, is not the answer
    let later = withTrancheState(replan(r, [p], 7), 2, "refunded", 8);
    later = withCampaignState(withCampaignState(withCampaignState(later, "paused", 9), "reassessing", 10), "running", 11);
    expect(nextAction(later, facts)).toMatchObject({ kind: "pause", replan: true });
    const again = replan(r, [p], 4);
    expect(again.tranches).toHaveLength(3);
    expect(again.tranches[2]).toMatchObject({ index: 2, state: "planned", amount: p.toString() });
    expect(nextAction(withTrancheState(again, 2, "settled", 5), facts)).toEqual({ kind: "complete" });
  });
  it("a pause condition pauses; paused tracks what flies; reassess requotes once the guards clear; rerouting waits for the user; a failed step pauses", () => {
    let r = withCampaignState(campaign([p, p], [], {}, { capBps: 5000 }), "running", 1);
    r = withTrancheState(r, 0, "executing", 2);
    const pause = { reason: "price-deviation" as const, detail: "moved" };
    expect(nextAction(r, { ...facts, pause })).toEqual({ kind: "pause", reason: "price-deviation", detail: "moved" });
    const paused = withCampaignState(r, "paused", 3);
    expect(nextAction(paused, facts)).toEqual({ kind: "track", indexes: [0] });
    expect(nextAction(withTrancheState(paused, 0, "settled", 4), facts)).toMatchObject({ kind: "wait", why: "paused" });
    expect(nextAction(withCampaignState(r, "reassessing", 5), { ...facts, pause })).toMatchObject({ kind: "pause" });
    expect(nextAction(withCampaignState(r, "reassessing", 5), facts)).toEqual({ kind: "requote" });
    expect(nextAction(withCampaignState(r, "requoting", 5), facts)).toEqual({ kind: "requote" });
    expect(nextAction(withCampaignState(withTrancheState(r, 0, "settled", 6), "rerouting", 7), facts)).toEqual({ kind: "none" });
    const failed = withTrancheState(r, 0, "failed", 8);
    expect(nextAction(failed, facts)).toMatchObject({ kind: "pause", reason: "provider-error", index: 0 });
  });
  it("winding down: funded steps get a refund-only job, flying ones are tracked, then the campaign completes; terminal states do nothing", () => {
    let r = withCampaignState(campaign([p, p, p], [], {}, { capBps: 4000 }), "winding-down", 1);
    r = withTrancheState(r, 0, "executing", 2);
    r = withTrancheState(r, 1, "funded", 3);
    r = withTrancheState(r, 2, "skipped", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "wind-down", index: 1 });
    r = withTrancheState(r, 1, "refunding", 4);
    expect(nextAction(r, facts)).toEqual({ kind: "track", indexes: [0, 1] });
    r = withTrancheState(withTrancheState(r, 0, "settled", 5), 1, "refunded", 6);
    expect(nextAction(r, facts)).toEqual({ kind: "complete" });
    expect(nextAction(withCampaignState(r, "completed", 7), facts)).toEqual({ kind: "none" });
    expect(nextAction(withCampaignState(r, "cancelled", 7), facts)).toEqual({ kind: "none" });
  });
  it("V6 Stage 13: winding down with a step committed but never funded gives that step up — the campaign never waits forever", () => {
    let r = withCampaignState(campaign([p, p, p], [], {}, { capBps: 4000 }), "winding-down", 1);
    r = withTrancheState(r, 0, "settled", 2);
    r = withTrancheState(r, 1, "committed", 3);
    r = withTrancheState(r, 2, "skipped", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "abandon", index: 1 });
    expect(nextAction(withTrancheState(r, 1, "funded", 4), facts), "a funded one gets its refund-only job first").toEqual({ kind: "wind-down", index: 1 });
    expect(nextAction(withTrancheState(r, 1, "skipped", 4), facts)).toEqual({ kind: "complete" });
  });
  it("winding down past a step whose return a relayer refused: the held step behind it first, a committed one given up, the returning one tracked, then the refused one asked again once REFUSED_RETRY_MS passed (the twelfth review round, XI's critique)", () => {
    const refusedAt = facts.now - 60_000;
    let r = withCampaignState(campaign([p, p, p, p], [], {}, { capBps: 4000 }), "winding-down", 1);
    r = withTrancheState(r, 0, "failed", 2, { refundRefusedAt: refusedAt });
    r = withTrancheState(r, 1, "funded", 3);
    r = withTrancheState(r, 2, "committed", 3);
    r = withTrancheState(r, 3, "skipped", 3);
    expect(nextAction(r, facts), "the step behind the refused one").toEqual({ kind: "wind-down", index: 1 });
    r = withTrancheState(r, 1, "refunding", 4);
    expect(nextAction(r, facts), "a committed one given up meanwhile").toEqual({ kind: "abandon", index: 2 });
    r = withTrancheState(r, 2, "skipped", 5);
    expect(nextAction(r, facts), "the returning one tracked").toEqual({ kind: "track", indexes: [1] });
    r = withTrancheState(r, 1, "refunded", 6);
    expect(nextAction(r, facts), "then a wait for the refused one's retry").toMatchObject({ kind: "wait", until: refusedAt + REFUSED_RETRY_MS });
    expect(nextAction(r, { ...facts, now: refusedAt + REFUSED_RETRY_MS }), "asked again once its wait is over").toEqual({ kind: "wind-down", index: 0 });
    expect(nextAction(withTrancheState(r, 0, "failed", 7, { refundRefusedAt: undefined }), facts), "a step no relayer refused: asked at once").toEqual({ kind: "wind-down", index: 0 });
  });
  it("two refused steps while the rest returns: the wait ends at the earliest retry, and the step whose wait ended first is asked first (the twelfth review round, XJ's critique)", () => {
    const early = facts.now - 120_000, late = facts.now - 60_000;
    let r = withCampaignState(campaign([p, p, p], [], {}, { capBps: 4000 }), "winding-down", 1);
    r = withTrancheState(r, 0, "failed", 2, { refundRefusedAt: early });
    r = withTrancheState(r, 1, "funded", 3, { refundRefusedAt: late });
    r = withTrancheState(r, 2, "skipped", 3);
    expect(nextAction(r, facts)).toMatchObject({ kind: "wait", until: early + REFUSED_RETRY_MS });
    expect(nextAction(r, { ...facts, now: early + REFUSED_RETRY_MS }), "the step refused first").toEqual({ kind: "wind-down", index: 0 });
    let q = withTrancheState(r, 0, "failed", 4, { refundRefusedAt: late });
    q = withTrancheState(q, 1, "funded", 5, { refundRefusedAt: early });
    expect(nextAction(q, facts), "the later step refused first: the wait still ends at the earliest").toMatchObject({ kind: "wait", until: early + REFUSED_RETRY_MS });
    expect(nextAction(q, { ...facts, now: early + REFUSED_RETRY_MS }), "the step whose wait ended first").toEqual({ kind: "wind-down", index: 1 });
  });
  it("a committed tranche is funded and signed before any new one is committed, in every mode", () => {
    const half = 20n * ETH;
    let r = withCampaignState(campaign([half, half, half, half], [], {}, { concurrency: "parallel", maxParallel: 2, capBps: 5000 }), "running", 1);
    r = withTrancheState(r, 0, "settled", 2);
    r = withTrancheState(r, 1, "executing", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "commit", index: 2 });
    r = withTrancheState(r, 2, "committed", 4);
    expect(nextAction(r, facts)).toEqual({ kind: "fund", index: 2 }); // never a commit of tranche 3 while 2 waits for its funding
    r = withTrancheState(r, 2, "funded", 5);
    expect(nextAction(r, facts)).toEqual({ kind: "sign", index: 2 });
    r = withTrancheState(r, 2, "signed", 6);
    expect(nextAction(r, facts)).toEqual({ kind: "hand-over", index: 2 });
  });
  it("a re-plan sizes its pieces against the order, not the remainder", () => {
    const order = 2353n * ETH;
    const r = planTranches(53n * ETH, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded(), reference: order });
    expect(r.pieces).toEqual([53n * ETH]); // one piece under the order's cap (58.8 ETH), never fifty-three 1 ETH pieces
    const two = planTranches(120n * ETH, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded(), reference: order });
    expect(two.pieces.every((p) => p <= (order * 250n) / 10000n)).toBe(true);
    expect(sum(two.pieces)).toBe(120n * ETH);
  });
  it("parallel mode releases a second tranche while one flies, within the cap and the limit", () => {
    const half = 20n * ETH;
    let r = withCampaignState(campaign([half, half, half, half, half, half, half, half, half, half, half, half], [], {}, { concurrency: "parallel", maxParallel: 2, capBps: 2000 }), "running", 1);
    r = withTrancheState(r, 0, "settled", 2);
    r = withTrancheState(r, 1, "executing", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "commit", index: 2 }); // 20 + 20 ≤ 48 ETH cap, 2 in flight allowed
    r = withTrancheState(r, 2, "executing", 4);
    expect(nextAction(r, facts)).toEqual({ kind: "track", indexes: [1, 2] });
    const seqWait = nextAction(withCampaignState(campaign([half, half], ["executing", "planned"], {}, { concurrency: "sequential", maxParallel: 1, capBps: 5000 }), "running", 1), facts);
    expect(seqWait).toEqual({ kind: "track", indexes: [0] });
    expect(TRACK_INTERVAL_MS).toBe(15_000);
  });
});

describe("the seventh review round (2026-11-03): what ended undelivered, what is kept, the hold, a failed step's refund, the re-plan's consent", () => {
  const p = 50n * ETH;
  const facts = { now: 2_000_000, pause: null, notesShaped: true };
  it("exposure: an undelivered step, a short refund and a partial fill whose rest never came back are ended — never completed, never remaining; a kept remainder is neither", () => {
    let c = campaign([p, p, p, p, p], ["undelivered", "refunded", "settled", "skipped", "planned"]);
    c = withTrancheState(c, 1, "refunded", 2, { outcome: { refunded: (p - ETH / 100n).toString() } }); // the tip stayed behind
    c = withTrancheState(c, 2, "settled", 3, { amount: (30n * ETH).toString(), funded: p.toString(), outcome: { refunded: "0" } }); // 30 delivered, nothing back
    c = withTrancheState(c, 3, "skipped", 4, { outcome: { kept: true } });
    const e = exposure(c);
    expect(e.completed).toBe(30n * ETH);
    expect(e.ended).toBe(p + ETH / 100n + 20n * ETH);
    expect(e.kept).toBe(p);
    expect(e.remaining).toBe(p + p - ETH / 100n); // the planned step and what came back
    const l = ledger(c);
    expect(BigInt(l.completed) + BigInt(l.inFlight) + BigInt(l.pending) + BigInt(l.remaining) + BigInt(l.ended) + BigInt(l.kept)).toBe(BigInt(l.totalOrderValue));
    // a partial fill settled for what was not returned (n19) ends nothing
    const n19 = withTrancheState(campaign([p, p], ["executing", "planned"]), 0, "settled", 5, { amount: (35n * ETH).toString(), funded: p.toString(), outcome: { refunded: (15n * ETH).toString() } });
    expect(exposure(n19)).toMatchObject({ completed: 35n * ETH, ended: 0n, remaining: p + 15n * ETH }); // the planned step and the 15 that came back
  });
  it("the eleventh review round's critique of E11-1: what did not arrive as asked (notDelivered) apart from what returned steps lost to their fees (returnCosts) — ended is both", () => {
    let c = campaign([p, p, p, p], ["undelivered", "refunded", "settled", "planned"]);
    c = withTrancheState(c, 1, "refunded", 2, { outcome: { refunded: (p - ETH / 100n).toString() } }); // the tip stayed behind
    c = withTrancheState(c, 2, "settled", 3, { amount: (30n * ETH).toString(), funded: p.toString(), outcome: { refunded: "0" } }); // 30 delivered, nothing back
    const e = exposure(c);
    expect(e.notDelivered, "the undelivered step and the partial fill's rest").toBe(p + 20n * ETH);
    expect(e.returnCosts, "the returned step's tip").toBe(ETH / 100n);
    expect(e.ended).toBe(e.notDelivered + e.returnCosts);
    expect(unreturnedOf(c.tranches[2])).toBe(20n * ETH);
    expect(unreturnedOf(c.tranches[0]), "only a settled step has an unreturned rest").toBe(0n);
    // a step returned less its tip, and nothing else: its fees alone, not one unit "not delivered"
    const back = withTrancheState(campaign([p, p], ["refunded", "planned"]), 0, "refunded", 2, { outcome: { refunded: (p - ETH / 500n).toString() } });
    expect(exposure(back)).toMatchObject({ notDelivered: 0n, returnCosts: ETH / 500n, ended: ETH / 500n });
    // a partial fill whose rest came back: its cost is in what it settled for
    const n19 = withTrancheState(campaign([p, p], ["executing", "planned"]), 0, "settled", 5, { amount: (35n * ETH).toString(), funded: p.toString(), outcome: { refunded: (15n * ETH).toString() } });
    expect(exposure(n19)).toMatchObject({ notDelivered: 0n, returnCosts: 0n });
    expect(unreturnedOf(n19.tranches[0])).toBe(0n);
  });
  it("swappedInFull (the eleventh review round's fourth critique of slice 4): nothing short of what was asked, and what settled, what stays and the returned steps' fees cover the total", () => {
    const settle = (c: Campaign, i: number) => withTrancheState(c, i, "settled", 10 + i);
    expect(swappedInFull(exposure(campaign([p, p], ["settled", "settled"]))), "every step settled").toBe(true);
    // a step returned less its tip, the rest planned again and settled: the tip is the step's cost, the swap in full
    let back = withTrancheState(campaign([p, p], ["refunded", "planned"]), 0, "refunded", 2, { outcome: { refunded: (p - ETH / 500n).toString() } });
    back = settle(settle(replan(back, [p, p - ETH / 500n], 3), 1), 2);
    expect(exposure(back)).toMatchObject({ returnCosts: ETH / 500n, notDelivered: 0n, completed: 2n * p - ETH / 500n });
    expect(swappedInFull(exposure(back))).toBe(true);
    // a last remainder kept in the private balance, too small to swap on its own
    const kept = withTrancheState(campaign([p, ETH / 1000n], ["settled", "planned"]), 1, "skipped", 4, { outcome: { kept: true } });
    expect(exposure(kept).kept).toBe(ETH / 1000n);
    expect(swappedInFull(exposure(kept))).toBe(true);
    // a step never started, given up when the rest returned: part of it was not swapped
    expect(swappedInFull(exposure(campaign([p, p], ["settled", "skipped"])))).toBe(false);
    // a step returned and not planned again
    expect(swappedInFull(exposure(withTrancheState(campaign([p, p], ["settled", "refunded"]), 1, "refunded", 3, { outcome: { refunded: p.toString() } })))).toBe(false);
    // a step not delivered as asked
    expect(swappedInFull(exposure(campaign([p, p], ["settled", "undelivered"])))).toBe(false);
  });
  it("an undelivered first step never passes the first-step health test", () => {
    const c = campaign([p, p, p], ["undelivered", "executing", "planned"], {}, { concurrency: "parallel", maxParallel: 2, capBps: 10000 });
    expect(canRelease(c, p)).toMatchObject({ ok: false, reason: expect.stringContaining("first tranche") });
  });
  it("detectPause: a step ended undelivered pauses as a provider error with its words; a velocity limit without a price pauses", () => {
    const c = withCampaignState(campaign([p, p]), "running", 1);
    expect(detectPause(c, { now: 2, walletPaused: false, stepUndelivered: "Step 1: another token." })).toEqual({ reason: "provider-error", detail: "Step 1: another token." });
    expect(detectPause(c, { now: 2, walletPaused: false, velocityUnknown: true })).toMatchObject({ reason: "velocity", detail: expect.stringContaining("no price") });
  });
  it("the campaign's hold: no commit before it, first step or later, whatever a step's own notBefore says", () => {
    const held = { ...campaign([p, p, p], [], {}, { capBps: 10000 }), holdUntil: facts.now + 86_400_000 };
    expect(nextAction(held, facts)).toEqual({ kind: "wait", until: facts.now + 86_400_000, why: expect.stringContaining("hold") });
    let r = withCampaignState(held, "running", 1);
    r = withTrancheState(r, 0, "planned", 2, { notBefore: facts.now - 1 }); // a requote's draw in the past
    expect(nextAction(r, facts)).toMatchObject({ kind: "wait", until: facts.now + 86_400_000 });
    expect(nextAction(r, { ...facts, now: facts.now + 86_400_001 })).toEqual({ kind: "commit", index: 0 });
  });
  it("a failed step pauses; once the user resumed after it failed, it returns through its own refund — never a pause at every Resume", () => {
    let r = withCampaignState(campaign([p, p]), "running", 1);
    r = withTrancheState(r, 0, "failed", 10);
    expect(nextAction(r, facts)).toMatchObject({ kind: "pause", reason: "provider-error", index: 0 });
    const before = withCampaignState(withCampaignState(withCampaignState(r, "paused", 5), "reassessing", 6), "running", 7); // a resume before it failed
    expect(nextAction({ ...r, history: before.history }, facts)).toMatchObject({ kind: "pause" });
    r = withCampaignState(withCampaignState(withCampaignState(r, "paused", 11), "reassessing", 12), "running", 13);
    expect(nextAction(r, facts)).toEqual({ kind: "refund", index: 0 });
  });
  it("a remainder whose steps were never funded (expired) is planned again without asking: no fee was paid for it", () => {
    let r = withCampaignState(campaign([p, p]), "running", 1);
    r = withTrancheState(withTrancheState(r, 0, "settled", 2), 1, "skipped", 3);
    expect(nextAction(r, facts)).toEqual({ kind: "replan" });
  });
  it("the bounds: a step's executor tip above the Review's × CONGESTION_FACTOR is refused", () => {
    const b = bounds({ maxExecutorTip: "3000" });
    const x = { amount: p, toAmountMin: rateE18(24_000_000n, 800n * ETH) * p / 10n ** 18n + 1n, quoteExpiresAt: 1_000, feeBps: 1, destination: "bc1q", fundedBefore: 0n, now: 1 };
    expect(checkWithinBounds(b, { ...x, executorTip: 3000n })).toEqual({ ok: true });
    expect(checkWithinBounds(b, { ...x, executorTip: 3001n })).toMatchObject({ ok: false, reason: expect.stringContaining("executor tip") });
  });
  it("the riskier class and the stricter gate", () => {
    expect(riskierClass("R2", "R5")).toBe("R5");
    expect(riskierClass("R6", "R5")).toBe("R6");
    expect(riskierClass("R4", "R1")).toBe("R4");
    expect(stricterGate("source", "destination-final")).toBe("destination-final");
    expect(stricterGate("destination-submitted", "source")).toBe("destination-submitted");
  });
});

describe("the eighth review round (2026-11-03): the planner's bound and the stall floor (A-M3 / D-M3, D-L2)", () => {
  it("a dust piece ceiling is refused at MAX_TRANCHES steps within milliseconds — in bucket, varied and exact sizing alike", () => {
    for (const o of [{ sizing: "bucket" as const }, { sizing: "varied" as const }, { sizing: "bucket" as const, exact: true }]) {
      const t0 = Date.now();
      expect(() => planTranches(1250n * ETH, { decimals: 18, bandBps: [100, 250], capBps: 250, maxParallel: 1, maxPiece: 1n, rng: seeded(), ...o }), JSON.stringify(o)).toThrow(TooManyTranches);
      expect(Date.now() - t0, JSON.stringify(o)).toBeLessThan(1_000);
    }
    // the honest plans never meet it
    expect(planTranches(2353n * ETH, { decimals: 18, bandBps: [100, 250], capBps: 250, sizing: "varied", maxParallel: 1, rng: seeded() }).pieces.length).toBeLessThan(MAX_TRANCHES);
  });
  it("a step of seconds reads as stalled only past the floor", () => {
    const c = campaign([50n * ETH, 50n * ETH], ["executing", "planned"]);
    const healthy = { now: 2_000_000, walletPaused: false, crossRateE18: c.referenceRateE18, liveQuotes: 2, providerHealth: { reliability: 90 } };
    expect(stallAfterSeconds(8)).toBe(STALL_FLOOR_SECONDS);
    expect(stallAfterSeconds(3_000)).toBe(9_000);
    expect(detectPause(c, { ...healthy, settlementAgeSeconds: 27, expectedSeconds: 8 }), "a poll and a block").toBeNull();
    expect(detectPause(c, { ...healthy, settlementAgeSeconds: STALL_FLOOR_SECONDS + 1, expectedSeconds: 8 })?.reason).toBe("anomaly");
  });
});
