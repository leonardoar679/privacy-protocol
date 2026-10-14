// The shared campaign core (High-Value Protection spec §3–§9): the tranche splitter, the exposure accounting
// with its invariants I1–I5 (the plan's §132 state is unreachable), the gates per class, the bounds, the pause
// detection per reason, and the reducer from every state — including the continuation after a simulated crash
// at each step (never a second funding or hand-over for one tranche).
import { describe, it, expect } from "vitest";
import {
  canPrepare, canRelease, checkWithinBounds, createCampaign, detectPause, exposure, gateFor, ledger, maximumLossModel, nextAction, planTranches, providerLimit, providerShares,
  rateE18, replan, settledBy, withCampaignState, withTrancheState, FINALITY_MARGIN_SECONDS, MAX_DEVIATION_BPS, TRACK_INTERVAL_MS,
  type Campaign, type ExecutionBounds, type TranchePlan, type TrancheState,
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
    c = withTrancheState(c, 1, "refunded", 4);
    e = exposure(c);
    expect(e.completed).toBe(T);
    expect(e.inFlight).toBe(0n);
    expect(e.remaining).toBe(2n * T);
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
    expect(nextAction(r, facts)).toEqual({ kind: "replan" });
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
    expect(nextAction(r, facts)).toEqual({ kind: "wind-down" });
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
    expect(nextAction(withTrancheState(r, 1, "funded", 4), facts), "a funded one gets its refund-only job first").toEqual({ kind: "wind-down" });
    expect(nextAction(withTrancheState(r, 1, "skipped", 4), facts)).toEqual({ kind: "complete" });
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
