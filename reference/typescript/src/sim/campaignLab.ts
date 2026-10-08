// Campaign lab (High-Value Protection spec §18; plan V3 §151–§155): the reducer of wallet/campaign.ts run against
// a simulated world for $1M … $50M on the five route families, fed by the measured quotes of
// benchmarks/whale/execution.json (parts and time per size, the impact, the limits — read-only data from the V2
// execution lab) — how many tranches, how long, how much gas, what pauses; then the thirteen faults of plan §152
// injected one at a time at the middle of the campaign: the maximum loss each can reach (what is in flight at that
// moment — never the order), the time it costs, and ELPF. Nothing here is live; the USD figures of gas are added by
// the runner (benchmarks/whale/run-campaign.mjs) at the price it fetched when it ran, never a constant.
// Usage: npx tsx src/sim/campaignLab.ts --execution ../../benchmarks/whale/execution.json [--json out.json] [--md out.md] [--gwei X --eth-usd Y]
import { readFileSync, writeFileSync } from "fs";
import {
  createCampaign, detectPause, exposure, nextAction, planTranches, replan, settledBy, withCampaignState, withTrancheState, FINALITY_MARGIN_SECONDS,
  type AssetRefLike, type Campaign, type ExecutionBounds, type PauseReason, type ProtectionMode, type Sizing, type TranchePlan,
} from "../wallet/campaign";
import { expectedLossPerFailure, riskModelOf } from "../wallet/riskClasses";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the world: routes from the measured quotes ------------------------------------------------------------------

export interface MeasuredPoint { usd: number; etaSeconds: number; parts?: number; impactBps?: number }
export interface RouteSpec {
  family: "EVM→BTC" | "EVM→SOL" | "EVM→EVM" | "BTC→EVM" | "SOL→EVM";
  pair: string;
  from: AssetRefLike;
  to: AssetRefLike;
  provider: string;
  planMode: "streaming" | "dca" | "single" | "auction" | "intent";
  /** the provider's quotes by size (execution.json); the time of a tranche is interpolated between them */
  measured: MeasuredPoint[];
  /** the provider refuses above this (per external execution), USD */
  maxUsd?: number;
  /** above this a fill waits for liquidity (Across's instant limit), USD */
  instantLimitUsd?: number;
  /** the rows are an assumption, not a measurement (SOL sources could not be quoted) */
  assumed?: boolean;
}
const ETH: AssetRefLike = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRefLike = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL: AssetRefLike = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const USDC: AssetRefLike = { chain: "ethereum", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC" };
const ETH_BASE: AssetRefLike = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_BASE: AssetRefLike = { chain: "base", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" };

interface ExecutionRow { pair: string; usd: number; provider: string; variant: string; ok: boolean; etaSeconds?: number; parts?: number; impactBps?: number; limits?: Record<string, string> }
interface ExecutionJson { feeds: { symbol: string; usd: number }[]; rows: ExecutionRow[] }

/** The routes the lab runs, from the execution lab's rows: one provider per family (the one that serves the tranche sizes), the measured points per size. */
export function routesFromExecution(j: ExecutionJson): RouteSpec[] {
  const points = (pair: string, provider: string, variants: string[]): MeasuredPoint[] =>
    j.rows.filter((r) => r.pair === pair && r.provider === provider && r.ok && variants.includes(r.variant) && r.etaSeconds !== undefined)
      .map((r) => ({ usd: r.usd, etaSeconds: r.etaSeconds!, parts: r.parts, impactBps: r.impactBps })).sort((a, b) => a.usd - b.usd);
  const ethUsd = j.feeds.find((f) => f.symbol === "ETH")?.usd ?? 0;
  const across = j.rows.find((r) => r.pair === "ETH>ETH(Base)" && r.provider === "uniswap-across" && r.ok && r.limits);
  const instant = across?.limits?.maxDepositInstant ? (Number(BigInt(across.limits.maxDepositInstant) / 10n ** 12n) / 1e6) * ethUsd : undefined;
  const maxAcross = across?.limits?.maxDeposit ? (Number(BigInt(across.limits.maxDeposit) / 10n ** 12n) / 1e6) * ethUsd : undefined;
  const routes: RouteSpec[] = [
    { family: "EVM→BTC", pair: "ETH>BTC", from: ETH, to: BTC, provider: "thorchain", planMode: "streaming", measured: points("ETH>BTC", "thorchain", ["streaming"]) },
    { family: "EVM→BTC", pair: "ETH>BTC", from: ETH, to: BTC, provider: "chainflip", planMode: "dca", measured: points("ETH>BTC", "chainflip", ["dca"]), maxUsd: 2_000_000 },
    { family: "EVM→SOL", pair: "ETH>SOL", from: ETH, to: SOL, provider: "mayan", planMode: "single", measured: points("ETH>SOL", "mayan", ["single"]), maxUsd: 10_000_000 },
    { family: "EVM→EVM", pair: "ETH>ETH(Base)", from: ETH, to: ETH_BASE, provider: "uniswap-across", planMode: "single", measured: points("ETH>ETH(Base)", "uniswap-across", ["single"]), maxUsd: maxAcross, instantLimitUsd: instant },
    { family: "EVM→EVM", pair: "ETH>USDC(Base)", from: ETH, to: USDC_BASE, provider: "mayan", planMode: "single", measured: points("ETH>USDC(Base)", "mayan", ["single"]), maxUsd: 10_000_000 },
    { family: "BTC→EVM", pair: "BTC>ETH", from: BTC, to: ETH, provider: "thorchain", planMode: "streaming", measured: points("BTC>ETH", "thorchain", ["streaming"]) },
    { family: "EVM→BTC", pair: "USDC>BTC", from: USDC, to: BTC, provider: "chainflip", planMode: "dca", measured: points("USDC>BTC", "chainflip", ["dca"]), maxUsd: 10_000_000 },
    // SOL sources could not be quoted by the execution lab (no Solana refund placeholder at the time): an assumption, marked as such
    { family: "SOL→EVM", pair: "SOL>ETH", from: SOL, to: ETH, provider: "mayan", planMode: "auction", measured: [{ usd: 100_000, etaSeconds: 60 }, { usd: 1_000_000, etaSeconds: 90 }], maxUsd: 10_000_000, assumed: true },
  ];
  return routes.filter((r) => r.measured.length > 0);
}

/** The execution time of one tranche of `usd` on the route: piecewise linear between the measured sizes, flat outside. */
export function etaFor(route: RouteSpec, usd: number): number {
  const m = route.measured;
  if (!m.length) return 600;
  if (usd <= m[0].usd) return m[0].etaSeconds;
  for (let i = 1; i < m.length; i++) if (usd <= m[i].usd) { const a = m[i - 1], b = m[i]; return a.etaSeconds + ((usd - a.usd) / (b.usd - a.usd)) * (b.etaSeconds - a.etaSeconds); }
  return m[m.length - 1].etaSeconds;
}
export function impactFor(route: RouteSpec, usd: number): number {
  const m = route.measured.filter((p) => p.impactBps !== undefined);
  if (!m.length) return 0;
  const above = m.find((p) => p.usd >= usd) ?? m[m.length - 1];
  return Math.max(0, above.impactBps ?? 0);
}

// ---- the plan per size and mode (spec §2, §4, §14) -----------------------------------------------------------------

export const CADENCE: Record<ProtectionMode, [number, number]> = { balanced: [600, 5400], "max-privacy": [1800, 21600], "max-safety": [600, 3600] }; // lab-calibrated
export const EXECUTE_WINDOW_SECONDS = 7200;
export const QUOTE_TTL_SECONDS = 600;
export const GAS_PER_FUNDING = 1_790_000; // transact (benchmarks/gas/measurements.json)
export const GAS_PER_EXECUTE = 1_850_000; // deployAndExecute (the local-stack run: 1.83M–1.86M)
export const SEC = { quote: 8, fund: 25, sign: 10, handOver: 15, delivered: 60, resume: 600 };
/** the wallet's stall factor (campaign.ts STALL_FACTOR): a step older than this many times its expected time is an anomaly */
export const STALL_FACTOR_LAB = 3;

export function planFor(sizeUsd: number, mode: ProtectionMode, route: RouteSpec, sizing: Sizing, priceUsd: number): TranchePlan {
  const model = riskModelOf(route.provider, { plan: { mode: route.planMode } }, route.from, route.to, mode);
  const capBps = mode === "max-safety" || sizeUsd >= 5_000_000 ? 200 : 250;
  let band: [number, number] = sizeUsd >= 10_000_000 ? [200, 250] : model.bandBps;
  band = [Math.min(band[0], capBps), Math.min(band[1], capBps)];
  // sequential safety mode for the highest-risk routes (plan §19): a bridge / MPC / counterparty route never runs two pieces at once
  const sequential = mode === "max-safety" || sizeUsd >= 10_000_000 || model.class === "R5" || model.class === "R6";
  return {
    riskClass: model.class, bandBps: band, capBps, sizing, concurrency: sequential ? "sequential" : "parallel", maxParallel: sequential ? 1 : 2,
    gate: model.gate, cadenceSeconds: CADENCE[mode], providerShareCapBps: 10000, executeWindowSeconds: EXECUTE_WINDOW_SECONDS, estimatedTranches: 0, estimatedSeconds: 0, shapeNotes: false,
  };
}

// ---- faults (plan §152) --------------------------------------------------------------------------------------------

export type FaultKind = "provider-outage" | "quote-mismatch" | "price-spike" | "chain-congestion" | "rpc-failure" | "destination-error" | "wrong-chain" | "wrong-token" | "reorg" | "bridge-timeout" | "solver-failure" | "app-crash" | "network-disconnect";
export const FAULTS: FaultKind[] = ["provider-outage", "quote-mismatch", "price-spike", "chain-congestion", "rpc-failure", "destination-error", "wrong-chain", "wrong-token", "reorg", "bridge-timeout", "solver-failure", "app-crash", "network-disconnect"];
/** the faults a user can only cancel out of (the destination or the asset is wrong): the campaign winds down */
const PERMANENT: FaultKind[] = ["destination-error", "wrong-chain", "wrong-token"];
const FAULT_SECONDS: Partial<Record<FaultKind, number>> = { "provider-outage": 1800, "price-spike": 3600, "chain-congestion": 1800, "rpc-failure": 300, "network-disconnect": 300 };

export interface SimOptions {
  sizeUsd: number;
  route: RouteSpec;
  mode: ProtectionMode;
  sizing: Sizing;
  /** USD per unit of the source asset */
  priceUsd: number;
  seed: number;
  fault?: FaultKind;
  /** the tranche the fault hits (default: the middle one) */
  faultAt?: number;
}
export interface PauseRecord { reason: PauseReason; atHours: number; minutes: number; tranche?: number }
export interface SimRow {
  sizeUsd: number; family: string; pair: string; provider: string; mode: ProtectionMode; sizing: Sizing; riskClass: string; gate: string; concurrency: string;
  tranches: number; trancheUsd: [number, number]; capUsd: number; wallHours: number; executionHours: number; pauses: PauseRecord[];
  gasUnits: number; fundings: number; handOvers: number; maxInFlightUsd: number; maxPreparedUsd: number; invariantsHeld: boolean; completed: boolean; cancelled: boolean;
  elpfTrancheUsd: number; elpfCampaignUsd: number; pFailPrior: number;
  fault?: { kind: FaultKind; atTranche: number; exposedUsd: number; maxLossUsd: number; outcome: string; extraHours: number };
  assumed?: boolean;
}

interface Flight { handedOverAt: number; outboundAt: number | null; deliveredAt: number | null; refundAt: number; failed?: boolean; /** the stall of this step was paused on once (§8: never twice for the same fact) */ stallNoted?: boolean; expectedSeconds: number }

/** One campaign, start to end, against the simulated world. */
export function simulateCampaign(o: SimOptions): SimRow {
  const rng = mulberry32(o.seed);
  const r = o.route;
  const decimals = r.from.decimals;
  const total = BigInt(Math.round((o.sizeUsd / o.priceUsd) * 1e6)) * 10n ** BigInt(decimals - 6);
  const unitsToUsd = (u: bigint) => (Number(u / 10n ** BigInt(decimals - 6)) / 1e6) * o.priceUsd;
  const plan = planFor(o.sizeUsd, o.mode, r, o.sizing, o.priceUsd);
  // the thin-market rule and the instant limit cap the piece
  const capUsd = (o.sizeUsd * plan.capBps) / 10000;
  let maxPieceUsd = Math.min(capUsd, r.instantLimitUsd ?? Infinity, r.maxUsd ?? Infinity);
  while (maxPieceUsd > 1000 && impactFor(r, maxPieceUsd) > 50) maxPieceUsd /= 2;
  const maxPiece = BigInt(Math.round((maxPieceUsd / o.priceUsd) * 1e6)) * 10n ** BigInt(decimals - 6);
  const split = planTranches(total, { decimals, bandBps: plan.bandBps, capBps: plan.capBps, sizing: plan.sizing, maxParallel: plan.maxParallel, maxPiece, rng });
  const model = riskModelOf(r.provider, { plan: { mode: r.planMode } }, r.from, r.to, o.mode);
  const bounds: ExecutionBounds = {
    orderId: "lab", assetIn: r.from, chainIn: r.from.chain, amountInLimit: total.toString(), assetOut: r.to, chainOut: r.to.chain, destination: { kind: "fresh-per-tranche" },
    minimumOutput: "1000000000000000000", expiry: 365 * 86400, maxFeeBps: 100, privacyMode: o.mode, maxExternalExposure: ((total * BigInt(plan.capBps)) / 10000n).toString(), executeWindowSeconds: EXECUTE_WINDOW_SECONDS,
  };
  let c: Campaign = createCampaign({ id: "lab", now: 0, mode: o.mode, tier: o.sizeUsd >= 10_000_000 ? "institutional" : o.sizeUsd >= 5_000_000 ? "high-value-secondary" : "high-value", request: { from: r.from, to: r.to, amount: total.toString(), preference: "balanced" }, bounds, plan, pieces: split.pieces, referenceRateE18: 10n ** 18n });
  const pieces = split.pieces;
  const faultAt = o.faultAt ?? Math.floor(pieces.length / 2);
  let t = 0; // seconds
  const flights = new Map<number, Flight>();
  const fundings = new Map<number, number>(), handOvers = new Map<number, number>();
  let gas = 0, maxInFlight = 0n, maxPrepared = 0n, executionSeconds = 0;
  const pauses: PauseRecord[] = [];
  let invariantsHeld = true;
  let faultArmed = o.fault !== undefined, faultFiredAt = -1, faultUntil = -1, faultExposed = 0n, reorgPending = false, crashed = false, outcome = "";
  const margins = FINALITY_MARGIN_SECONDS;
  const stepUsd = (i: number) => unitsToUsd(BigInt(c.tranches[i].amount));
  const refundAfter = (handedOverAt: number) => handedOverAt + QUOTE_TTL_SECONDS + EXECUTE_WINDOW_SECONDS;

  const faultActive = () => faultFiredAt >= 0 && faultUntil > t;
  const facts = (): Parameters<typeof detectPause>[1] => {
    const f: Parameters<typeof detectPause>[1] = { now: t * 1000, walletPaused: false, crossRateE18: c.referenceRateE18, liveQuotes: 2, providerHealth: { reliability: 90 } };
    // a settlement far older than its expected time is an anomaly (§8): the oldest unsettled step not yet paused on
    for (const [i, fl] of flights) {
      const st = c.tranches[i].state;
      if (!fl.stallNoted && (st === "executing" || st === "source-confirmed") && t - fl.handedOverAt > STALL_FACTOR_LAB * fl.expectedSeconds) { f.settlementAgeSeconds = t - fl.handedOverAt; f.expectedSeconds = fl.expectedSeconds; fl.stallNoted = true; break; }
    }
    if (!faultActive()) return f;
    switch (o.fault) {
      case "provider-outage": f.liveQuotes = 0; break;
      case "price-spike": f.crossRateE18 = ((BigInt(c.referenceRateE18) * 9700n) / 10000n).toString(); break;
      case "chain-congestion": f.gasPriceWei = "50"; f.gasPriceAtConfirmationWei = "10"; break;
      case "rpc-failure": case "network-disconnect": f.reconcileNeeded = true; break;
      default: break;
    }
    return f;
  };
  const fire = (exposed: bigint, seconds: number) => { faultArmed = false; faultFiredAt = t; faultUntil = t + seconds; faultExposed = exposed; };
  const track = () => {
    // the world's clock: in-flight tranches progress with time; the campaign only reads it
    for (const [i, fl] of flights) {
      const tr = c.tranches[i];
      if (tr.state === "executing" && t >= fl.handedOverAt + SEC.handOver) {
        if (fl.failed) { c = withTrancheState(c, i, "failed", t * 1000, {}, "execute-failed"); continue; }
        c = withTrancheState(c, i, "source-confirmed", t * 1000);
      }
      if (tr.state === "source-confirmed" && fl.outboundAt !== null && t >= fl.outboundAt) c = withTrancheState(c, i, "destination-submitted", t * 1000);
      if ((tr.state === "destination-submitted" || tr.state === "source-confirmed") && fl.deliveredAt !== null && t >= fl.deliveredAt && !c.tranches[i].deliveredSince) c = withTrancheState(c, i, c.tranches[i].state, t * 1000, { deliveredSince: fl.deliveredAt * 1000 });
      const cur = c.tranches[i];
      const state = cur.deliveredSince ? "DESTINATION_FINAL" : cur.state === "destination-submitted" ? "DESTINATION_SUBMITTED" : cur.state === "source-confirmed" ? "SOURCE_FINAL" : "PROVIDER_EXECUTING";
      if (["executing", "source-confirmed", "destination-submitted"].includes(cur.state) && settledBy(cur.gate ?? plan.gate, { state, deliveredSince: cur.deliveredSince, chain: r.to.chain }, t * 1000, margins)) {
        c = withTrancheState(c, i, "settled", t * 1000, { settledAt: t * 1000 });
        executionSeconds += t - fl.handedOverAt;
        flights.delete(i);
        // the cadence (spec §4): the next planned piece is released only after a random delay inside the mode's window
        const nextPlanned = c.tranches.find((x) => x.state === "planned");
        if (nextPlanned) { const [lo, hi] = plan.cadenceSeconds; c = withTrancheState(c, nextPlanned.index, "planned", t * 1000, { notBefore: (t + lo + rng() * (hi - lo)) * 1000 }); }
      }
      // a stall (bridge-timeout) ends in the provider's refund at refundAfter: the executor re-shields it
      if ((cur.state === "executing" || cur.state === "source-confirmed") && fl.outboundAt === null && t >= fl.refundAt) { c = withTrancheState(c, i, "refunded", t * 1000, {}, "refunded after the window"); flights.delete(i); }
      if (cur.state === "refunding" && t >= fl.refundAt) { c = withTrancheState(c, i, "refunded", t * 1000); flights.delete(i); }
    }
  };
  const nextEvent = (): number => {
    let next = Infinity;
    for (const [i, fl] of flights) {
      const tr = c.tranches[i];
      for (const x of [fl.handedOverAt + SEC.handOver, fl.outboundAt, fl.deliveredAt, fl.deliveredAt !== null ? fl.deliveredAt + (margins[r.to.chain] ?? margins.default) : null, tr.state === "refunding" || fl.outboundAt === null ? fl.refundAt : null]) if (x !== null && x > t && x < next) next = x;
    }
    if (faultUntil > t && faultUntil < next) next = faultUntil;
    return next;
  };

  const DAYS = 60 * 86400;
  let resumeAt = -1;
  for (let guard = 0; guard < 200_000 && t < DAYS; guard++) {
    track();
    if (c.state === "paused" && resumeAt >= 0 && t >= resumeAt) {
      const permanent = o.fault && PERMANENT.includes(o.fault) && c.pause?.reason !== "wallet-pause";
      if (permanent) { c = withCampaignState(c, "winding-down", t * 1000, "cancelled by the user"); outcome = "cancelled: the rest returns to the private balance"; }
      else { c = withCampaignState(c, "reassessing", t * 1000); if (o.fault === "price-spike") c = { ...c, referenceRateE18: facts().crossRateE18 ?? c.referenceRateE18 }; }
      resumeAt = -1;
    }
    const e = exposure(c);
    if (e.inFlight > maxInFlight) maxInFlight = e.inFlight;
    if (e.prepared > maxPrepared) maxPrepared = e.prepared;
    if (e.inFlight > e.cap) invariantsHeld = false;
    const a = nextAction(c, { now: t * 1000, pause: c.state === "running" ? detectPause(c, facts()) : null, notesShaped: true });
    switch (a.kind) {
      case "none": t = Math.min(nextEvent(), t + 60); if (c.state === "rerouting") c = withCampaignState(c, "running", t * 1000); break;
      case "wait": { const until = Math.max(t + 1, Math.floor(a.until / 1000)); t = Math.min(until, nextEvent()); break; }
      case "track": t = Math.min(nextEvent(), t + 15); if (!Number.isFinite(t)) t += 15; break;
      case "shape-notes": c = withCampaignState(c, "preparing-notes", t * 1000); break;
      case "commit": {
        if (c.state !== "running") c = withCampaignState(c, "running", t * 1000);
        const i = a.index;
        t += SEC.quote;
        if (faultArmed && i === faultAt && (o.fault === "quote-mismatch" || o.fault === "wrong-chain" || o.fault === "wrong-token" || o.fault === "provider-outage")) {
          fire(e.inFlight, FAULT_SECONDS[o.fault!] ?? 0);
          if (o.fault === "quote-mismatch") { c = withCampaignState(c, "paused", t * 1000, "price-deviation", { pause: { reason: "price-deviation", detail: "the hard quote was below the bound", at: t * 1000, trancheIndex: i } }); pauses.push({ reason: "price-deviation", atHours: t / 3600, minutes: SEC.resume / 60, tranche: i }); resumeAt = t + SEC.resume; break; }
          if (o.fault === "wrong-chain" || o.fault === "wrong-token") { c = withCampaignState(c, "paused", t * 1000, "bounds", { pause: { reason: "bounds", detail: o.fault === "wrong-chain" ? "the destination belongs to another chain" : "the quote names another token", at: t * 1000, trancheIndex: i } }); pauses.push({ reason: "bounds", atHours: t / 3600, minutes: SEC.resume / 60, tranche: i }); resumeAt = t + SEC.resume; break; }
          // an outage: the next tick's facts pause it (route-degraded)
          break;
        }
        c = withTrancheState(c, i, "committed", t * 1000, { attempt: c.tranches[i].attempt + 1, provider: r.provider, riskClass: plan.riskClass, gate: plan.gate, orderId: `lab-${i}-${c.tranches[i].attempt + 1}` });
        break;
      }
      case "fund": {
        const i = a.index;
        t += SEC.fund; gas += GAS_PER_FUNDING;
        if (faultArmed && i === faultAt && o.fault === "reorg" && !reorgPending) { fire(e.inFlight, 0); reorgPending = true; c = withTrancheState(c, i, "committed", t * 1000, {}, "the funding was reorged out: nothing is on the canonical chain"); break; }
        fundings.set(i, (fundings.get(i) ?? 0) + 1);
        c = withTrancheState(c, i, "funded", t * 1000);
        break;
      }
      case "sign": {
        const i = a.index;
        t += SEC.sign;
        if (faultArmed && i === faultAt && o.fault === "destination-error") { fire(e.inFlight, 0); c = withCampaignState(c, "paused", t * 1000, "unexpected-destination", { pause: { reason: "unexpected-destination", detail: "the provider call pays another destination", at: t * 1000, trancheIndex: i } }); pauses.push({ reason: "unexpected-destination", atHours: t / 3600, minutes: SEC.resume / 60, tranche: i }); resumeAt = t + SEC.resume; break; }
        c = withTrancheState(c, i, "signed", t * 1000);
        break;
      }
      case "hand-over": {
        const i = a.index;
        t += SEC.handOver; gas += GAS_PER_EXECUTE;
        handOvers.set(i, (handOvers.get(i) ?? 0) + 1);
        const usd = stepUsd(i);
        const eta = etaFor(r, usd);
        const fl: Flight = { handedOverAt: t, outboundAt: t + eta, deliveredAt: t + eta + SEC.delivered, refundAt: refundAfter(t), expectedSeconds: eta + SEC.delivered + (margins[r.to.chain] ?? margins.default) };
        if (faultArmed && i === faultAt && (o.fault === "bridge-timeout" || o.fault === "solver-failure")) {
          fire(BigInt(c.tranches[i].amount) + e.inFlight, 0);
          // a bridge timeout: no outbound, and the provider's refund reaches the escrow only hours later (after the stall pause)
          if (o.fault === "bridge-timeout") { fl.outboundAt = null; fl.deliveredAt = null; fl.refundAt = t + 6 * 3600; }
          else fl.failed = true;
        }
        if (faultArmed && i === faultAt && (o.fault === "app-crash" || o.fault === "network-disconnect" || o.fault === "rpc-failure" || o.fault === "price-spike" || o.fault === "chain-congestion")) fire(BigInt(c.tranches[i].amount) + e.inFlight, FAULT_SECONDS[o.fault!] ?? 0);
        if (o.fault === "app-crash" && faultFiredAt === t) crashed = true; // the journal is the state: the next tick continues from it
        flights.set(i, fl);
        c = withTrancheState(c, i, "executing", t * 1000, { handedOverAt: t * 1000, expected: { minOut: "0", rateE18: c.referenceRateE18, etaSeconds: eta } });
        break;
      }
      case "pause": {
        c = withCampaignState(c, "paused", t * 1000, a.reason, { pause: { reason: a.reason, detail: a.detail, at: t * 1000, trancheIndex: a.index } });
        const wait = Math.max(SEC.resume, faultUntil - t);
        pauses.push({ reason: a.reason, atHours: t / 3600, minutes: wait / 60, tranche: a.index });
        resumeAt = t + wait;
        if (a.reason === "provider-error" && a.index !== undefined) {
          // a failed step: its funds sit in its escrow until the window, then come back (a refund-only job)
          const fl = flights.get(a.index);
          c = withTrancheState(c, a.index, "refunding", t * 1000, {}, "refund-only job");
          if (fl) flights.set(a.index, { ...fl, outboundAt: null, deliveredAt: null }); else flights.set(a.index, { handedOverAt: t, outboundAt: null, deliveredAt: null, refundAt: refundAfter(t), expectedSeconds: 0 });
        }
        break;
      }
      case "requote": t += SEC.quote; c = withCampaignState(c, "running", t * 1000, "requoted: same route"); break;
      case "replan": {
        const rem = exposure(c).remaining;
        const more = planTranches(rem, { decimals, bandBps: plan.bandBps, capBps: plan.capBps, sizing: plan.sizing, maxParallel: plan.maxParallel, maxPiece, rng, reference: total });
        c = replan(c, more.pieces, t * 1000);
        break;
      }
      case "wind-down": {
        for (const tr of c.tranches) if (tr.state === "planned") c = withTrancheState(c, tr.index, "skipped", t * 1000);
        for (const tr of c.tranches) if (tr.state === "funded" || tr.state === "signed" || tr.state === "failed") { c = withTrancheState(c, tr.index, "refunding", t * 1000, {}, "refund-only job"); flights.set(tr.index, { handedOverAt: t, outboundAt: null, deliveredAt: null, refundAt: refundAfter(t), expectedSeconds: 0 }); }
        break;
      }
      case "complete": c = withCampaignState(c, c.state === "winding-down" ? "cancelled" : "completed", t * 1000); break;
    }
    if (c.state === "completed" || c.state === "cancelled") break;
  }
  const done = c.state === "completed";
  const e = exposure(c);
  const fundedOnce = [...fundings.values()].every((n) => n === 1) && [...handOvers.values()].every((n) => n === 1);
  const trancheUsd = pieces.map((p) => unitsToUsd(p));
  const elpfTranche = expectedLossPerFailure({ pFailPrior: model.pFailPrior, exposed: Math.max(...trancheUsd) });
  const elpfCampaign = expectedLossPerFailure({ pFailPrior: model.pFailPrior, exposed: capUsd });
  const baseline = o.fault ? undefined : null;
  return {
    sizeUsd: o.sizeUsd, family: r.family, pair: r.pair, provider: r.provider, mode: o.mode, sizing: o.sizing, riskClass: plan.riskClass, gate: plan.gate, concurrency: plan.concurrency,
    tranches: pieces.length, trancheUsd: [Math.min(...trancheUsd), Math.max(...trancheUsd)], capUsd, wallHours: t / 3600, executionHours: executionSeconds / 3600, pauses,
    gasUnits: gas, fundings: [...fundings.values()].reduce((s, x) => s + x, 0), handOvers: [...handOvers.values()].reduce((s, x) => s + x, 0),
    maxInFlightUsd: unitsToUsd(maxInFlight), maxPreparedUsd: unitsToUsd(maxPrepared), invariantsHeld: invariantsHeld && fundedOnce && !(crashed && !fundedOnce), completed: done, cancelled: c.state === "cancelled",
    elpfTrancheUsd: elpfTranche.expectedLoss, elpfCampaignUsd: elpfCampaign.expectedLoss, pFailPrior: model.pFailPrior,
    ...(o.fault ? { fault: { kind: o.fault, atTranche: faultAt, exposedUsd: unitsToUsd(faultExposed), maxLossUsd: unitsToUsd(faultExposed), outcome: outcome || (done ? (pauses.length ? "completed after the pause" : "completed; nothing paused (reconciled from the journal and the chain)") : c.state), extraHours: 0 } } : {}),
    ...(r.assumed ? { assumed: true } : {}),
    ...(baseline === null ? {} : {}),
  };
}

export const SIZES_USD = [1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000];
export const MODES: ProtectionMode[] = ["balanced", "max-privacy", "max-safety"];

export function runAll(routes: RouteSpec[], prices: Record<string, number>, seed = 4242): { rows: SimRow[]; faults: SimRow[] } {
  const rows: SimRow[] = [];
  const faults: SimRow[] = [];
  let s = seed;
  for (const route of routes) for (const sizeUsd of SIZES_USD) {
    if (route.maxUsd !== undefined && route.maxUsd < 250_000) continue;
    for (const mode of MODES) for (const sizing of (mode === "balanced" ? ["bucket", "varied"] : [mode === "max-privacy" ? "bucket" : "varied"]) as Sizing[]) rows.push(simulateCampaign({ sizeUsd, route, mode, sizing, priceUsd: prices[route.from.symbol], seed: s++ }));
  }
  // the faults: the $10M ETH → BTC campaign (THORChain, balanced, bucket), one fault at a time at the middle tranche
  const ref = routes.find((r) => r.pair === "ETH>BTC" && r.provider === "thorchain") ?? routes[0];
  for (const fault of FAULTS) faults.push(simulateCampaign({ sizeUsd: 10_000_000, route: ref, mode: "balanced", sizing: "bucket", priceUsd: prices[ref.from.symbol], seed: s++, fault }));
  // the same faults at $1M (enhanced controls still apply above $100K; the tranche is $25K there)
  for (const fault of FAULTS) faults.push(simulateCampaign({ sizeUsd: 1_000_000, route: ref, mode: "balanced", sizing: "bucket", priceUsd: prices[ref.from.symbol], seed: s++, fault }));
  const baseline = simulateCampaign({ sizeUsd: 10_000_000, route: ref, mode: "balanced", sizing: "bucket", priceUsd: prices[ref.from.symbol], seed: seed + 1 });
  for (const f of faults) if (f.fault && f.sizeUsd === 10_000_000) f.fault.extraHours = Math.max(0, f.wallHours - baseline.wallHours);
  return { rows, faults };
}

// ---- CLI ----
const isMain = process.argv[1] && /campaignLab\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
  const executionPath = opt("execution") ?? "../../benchmarks/whale/execution.json";
  const j = JSON.parse(readFileSync(executionPath, "utf8")) as ExecutionJson;
  const prices: Record<string, number> = Object.fromEntries(j.feeds.map((f) => [f.symbol, f.usd]));
  const routes = routesFromExecution(j);
  const { rows, faults } = runAll(routes, prices, Number(opt("seed") ?? 4242));
  const gwei = opt("gwei") ? Number(opt("gwei")) : null, ethUsd = opt("eth-usd") ? Number(opt("eth-usd")) : null;
  const gasUsd = (units: number) => (gwei !== null && ethUsd !== null ? (units * gwei * 1e-9 * ethUsd) : null);
  const f = (x: number, d = 1) => x.toFixed(d);
  const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
  const lines: string[] = [];
  lines.push(`# Campaign lab — tranches, time, gas and faults (High-Value Protection spec §18)`, ``);
  lines.push(`Measured quotes: \`benchmarks/whale/execution.json\` (${j.feeds.map((x) => `${x.symbol} $${x.usd.toFixed(0)}`).join(", ")}); the reducer of \`reference/typescript/src/wallet/campaign.ts\` against a simulated clock; gates per class with the finality margins (BTC 60 min, SOL 1 min, EVM 15 min); the user reassesses a pause after 10 min; a failed step comes back at its refund window (quote TTL 10 min + the 2 h execution window).${gwei !== null ? ` Gas in USD at the price fetched when this ran: ${f(gwei, 3)} gwei, ETH $${f(ethUsd!, 0)} (never a constant).` : ""}`, ``);
  lines.push(`## Campaigns`, ``, `| size | route | provider | mode | sizing | class | gate | tranches | tranche USD | cap | wall time | gas (M)${gwei !== null ? " | gas USD" : ""} | pauses | invariants |`, `|---|---|---|---|---|---|---|---|---|---|---|---|${gwei !== null ? "---|" : ""}---|---|`);
  for (const r of rows) lines.push(`| ${money(r.sizeUsd)} | ${r.pair}${r.assumed ? " (assumed)" : ""} | ${r.provider} | ${r.mode} | ${r.sizing} | ${r.riskClass} | ${r.gate} | ${r.tranches} | ${money(r.trancheUsd[0])}–${money(r.trancheUsd[1])} | ${money(r.capUsd)} | ${f(r.wallHours)} h | ${f(r.gasUnits / 1e6, 0)}${gwei !== null ? ` | ${money(gasUsd(r.gasUnits)!)}` : ""} | ${r.pauses.length} | ${r.invariantsHeld && r.completed ? "held" : r.invariantsHeld ? `held (${r.cancelled ? "cancelled" : "open"})` : "BROKEN"} |`);
  lines.push(``, `## Faults (plan §152–§153): the $10M ETH → BTC campaign (THORChain streaming, balanced, bucket sizing), one fault at its middle tranche`, ``, `| fault | exposed at the fault | maximum loss | outcome | extra time | invariants |`, `|---|---|---|---|---|---|`);
  for (const r of faults.filter((x) => x.sizeUsd === 10_000_000)) lines.push(`| ${r.fault!.kind} | ${money(r.fault!.exposedUsd)} | ${money(r.fault!.maxLossUsd)} (cap ${money(r.capUsd)}) | ${r.fault!.outcome} | ${f(r.fault!.extraHours)} h | ${r.invariantsHeld ? "held" : "BROKEN"} |`);
  lines.push(``, `The same faults at $1M (tranche ≈ $25K): maximum loss ${money(Math.max(...faults.filter((x) => x.sizeUsd === 1_000_000).map((x) => x.fault!.maxLossUsd)))} at most, every invariant held: ${faults.filter((x) => x.sizeUsd === 1_000_000).every((x) => x.invariantsHeld) ? "yes" : "NO"}.`, ``);
  lines.push(`## ELPF (§10): expected loss per failure = P(failure) × exposed, with the class priors (assumed until settlement history exists)`, ``, `| route | class | prior | per tranche ($10M balanced) | per campaign (the cap) |`, `|---|---|---|---|---|`);
  for (const r of rows.filter((x) => x.sizeUsd === 10_000_000 && x.mode === "balanced" && x.sizing === "bucket")) lines.push(`| ${r.pair} / ${r.provider} | ${r.riskClass} | ${r.pFailPrior} | ${money(r.elpfTrancheUsd)} | ${money(r.elpfCampaignUsd)} |`);
  const md = lines.join("\n") + "\n";
  const jsonOut = opt("json"), mdOut = opt("md");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), execution: executionPath, prices, gwei, ethUsd, rows, faults }, null, 2) + "\n");
  if (mdOut) writeFileSync(mdOut, md);
  if (!jsonOut && !mdOut) console.log(md);
  const broken = [...rows, ...faults].filter((r) => !r.invariantsHeld);
  console.log(`${rows.length} campaigns, ${faults.length} fault runs; invariants broken in ${broken.length}`);
  if (broken.length) process.exit(1);
}
