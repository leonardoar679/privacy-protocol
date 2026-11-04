// Campaigns in the wallet (High-Value Protection spec §3, §5, §7, §8, §17): a large order confirmed once becomes a
// journaled campaign of tranches, each an ordinary order of its own (sdk/swapExecute.ts) released by the runner
// (wallet/campaignRunner.ts) under the in-flight cap. This module starts a campaign from the service's
// recommendation and the user's confirmation, and takes the user's four decisions during it: pause, resume (reassess →
// requote → reroute Review), accept or decline a reroute, cancel (return the rest). Everything lives in the encrypted
// journal (`campaigns?`, optional); nothing here is sent anywhere.
import {
  createCampaign, exposure, gateFor, planTranches, rateE18, replan, riskierClass, stricterGate, withCampaignState, withTrancheState, CONGESTION_FACTOR, RATE_SCALE,
  type Campaign, type CampaignAlert, type DestinationPolicy, type ExecutionBounds, type ProtectionMode, type RiskClass, type Tranche, type TranchePlan,
} from "@privacy-wallet/protocol/wallet/campaign";
import { riskModelOf } from "@privacy-wallet/protocol/wallet/riskClasses";
import { atLeast } from "@privacy-wallet/protocol/wallet/valuation";
import type { LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import { PRIVACY_FEE_BPS, feeForWithdrawal, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { Asset } from "../assets";
import { mergeSchedule } from "./mergeSchedule";
import type { AssetRef, Policy, Preference, Protection, QuoteSet, ServiceQuote } from "../swapService";
import { MAX_ALERTS, withAlert } from "./alerts";
import { activityId, recordActivity, updateActivity } from "./activity";
import type { JournalData, StoredSwap } from "./journal";
import { noteStore } from "./notes";
import { cancelAction, scheduleAction } from "./schedule";
import { assertJournalSaved, session as defaultSession, type WalletSession } from "./session";
import { PROTECTION_DEFAULTS } from "./settings";
import { capBpsFor, type ExposureTier } from "@privacy-wallet/protocol/wallet/exposurePolicy";

/** The tier's slippage inside the price bound (§3): the confirmation quote's minimum per unit, less this. */
export const BOUNDS_SLIPPAGE_BPS = 50;
/** The tip (≤ 25 bps, V1.1) plus the relayer fee ceiling per tranche (§3). */
export const DEFAULT_MAX_FEE_BPS = 100;

/**
 * What `steps` pieces over `amount` must deliver in all (V3 §3), as the band's Review states it (the third review round, 2026-11-03;
 * before, it stated the one order's minimum and "Quote locked", which no step was held to): the per-unit floor the bounds carry — the
 * quote's minimum per unit of what the set was quoted for, less BOUNDS_SLIPPAGE_BPS — over the steps' amount (smaller than the funding:
 * each step pays its own fee note), net of each step's tip when the set names one, as the steps are committed (trancheMinimum); a unit
 * per step under the sum of the steps' own floors, so the figure is never above what the steps guarantee together. Each step's tip is
 * counted at the most it may be, the set's tip × CONGESTION_FACTOR (ExecutionBounds.maxExecutorTip; the seventh review round,
 * 2026-11-03): counted at today's tip, the figure was above what the steps guaranteed once the gas price rose under the pause.
 */
export function campaignMinimumOutput(i: { toAmountMin: bigint; quoted: bigint; amount: bigint; executorTip?: bigint | null; steps: number }): bigint {
  const slip = (rate: bigint) => (rate * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n;
  const tip = i.executorTip ?? null;
  const n = BigInt(Math.max(1, i.steps));
  let total: bigint;
  if (tip !== null && tip > 0n && tip < i.quoted) {
    const most = tip * BigInt(CONGESTION_FACTOR);
    const paid = i.amount > most * n ? i.amount - most * n : 0n;
    total = (paid * slip(rateE18(i.toAmountMin, i.quoted - tip))) / RATE_SCALE;
  } else total = (i.amount * slip(rateE18(i.toAmountMin, i.quoted))) / RATE_SCALE;
  return total > n ? total - n : 0n;
}
/** The campaign expiry: twice the estimated duration plus this margin (§3). */
export const EXPIRY_MARGIN_SECONDS = 48 * 3600;
export const TERMINAL_STATES: readonly Campaign["state"][] = ["completed", "cancelled"];

const EMPTY: Campaign[] = [];
/** The campaigns of a journal (the same empty array while there is none: a stable snapshot for the screens). */
export const campaignsOf = (j: JournalData): Campaign[] => j.campaigns ?? EMPTY;
export function campaignById(id: string, s: WalletSession = defaultSession): Campaign | null {
  return s.isUnlocked() ? campaignsOf(s.journal()).find((c) => c.id === id) ?? null : null;
}
export const activeCampaigns = (s: WalletSession = defaultSession): Campaign[] => (s.isUnlocked() ? campaignsOf(s.journal()).filter((c) => !TERMINAL_STATES.includes(c.state)) : []);
/** Journal a campaign (replacing the one with its id) and mirror its state onto its Activity line (the note keeps the
 *  "→ BTC ·" it was created with, as a swap's line does). */
export function putCampaign(c: Campaign, s: WalletSession = defaultSession): void {
  s.update((j) => { j.campaigns = [...(j.campaigns ?? []).filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt - b.createdAt); });
  updateActivity(activityId("campaign", c.id), { status: c.state, note: `→ ${c.request.to.symbol} · ${progressLine(c)}` }, s);
}
/** The session's campaigns (a stable snapshot: the same empty array while locked); apps/web/src/hooks reads it for the screens. */
export const campaignsSnapshot = (s: WalletSession = defaultSession): Campaign[] => (s.isUnlocked() ? campaignsOf(s.journal()) : EMPTY);
/** The child order of a tranche (its own StoredSwap), if committed. */
export const childOrder = (t: Tranche, s: WalletSession = defaultSession): StoredSwap | null => (t.orderId && s.isUnlocked() ? s.journal().swaps.find((x) => x.orderId.toLowerCase() === t.orderId!.toLowerCase()) ?? null : null);

const randomId = (): string => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A uniform draw in [0, 1) from the CSPRNG (the tranche sizes, the cadence). */
export function cryptoUniform(): number { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 2 ** 32; }
/** A seed for seededUniform, from the CSPRNG (V7 Stage 13). */
export function cryptoSeed(): number { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0]; }
/** A uniform source from a seed (mulberry32): the Review's dry run and the confirmed plan draw the same pieces (V7 Stage 13). */
export function seededUniform(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The largest piece still to fund; the notes must pay it with the withdrawal's inputs, or the campaign shapes them first (§4). */
export const largestPlanned = (c: Campaign): bigint => c.tranches.filter((t) => t.state === "planned" || t.state === "ready").reduce((m, t) => (BigInt(t.amount) > m ? BigInt(t.amount) : m), 0n);
/** Whether the unspent notes of the vault can pay `needed` without merges (sdk/privateTx.ts mergeSchedule). */
export function notesShapedFor(vault: string, needed: bigint): boolean {
  if (needed <= 0n) return true;
  const notes = noteStore.unspent(BigInt(vault)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
  const sched = mergeSchedule(notes, needed, 0n);
  return sched.ok && sched.pairs.length === 0;
}

/** "Executing in protected steps · completed / in flight / protected" for Activity and Home; "Step k of ~N" only under Advanced (plan §98). */
export function progressLine(c: Campaign, advanced = false): string {
  const e = exposure(c);
  const settled = c.tranches.filter((t) => t.state === "settled").length;
  const total = c.tranches.filter((t) => t.state !== "skipped").length;
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const f = (u: bigint) => { const base = 10n ** BigInt(dec); const frac = (u % base).toString().padStart(dec, "0").slice(0, 4).replace(/0+$/, ""); return `${u / base}${frac ? `.${frac}` : ""}`; };
  const head = advanced ? `Step ${Math.min(settled + 1, Math.max(total, 1))} of ~${Math.max(total, 1)}` : "Executing in protected steps";
  return `${head} · ${f(e.completed)} ${sym} completed · ${f(e.inFlight)} ${sym} in flight · ${f(e.protected)} ${sym} protected`;
}

export interface StartCampaignInput {
  quotes: QuoteSet;
  /** the provider the user confirmed (the chosen route, or the one picked under Route details) */
  provider: string;
  from: AssetRef;
  fromAsset: Asset;
  to: AssetRef;
  amount: bigint;
  /**
   * The escrow amount the quote set was asked for, when it is not `amount` (a V6 follow-up of 2026-10-17, audit c49): a
   * protected execution quotes the whole funding and runs a smaller steps amount, each step paying its own fee note
   */
  quotedAmount?: bigint;
  /**
   * What may leave the protected balance: the amount the user typed, the steps' own fee notes included (audit round 2, r18).
   * The Activity line had shown the steps' total alone beside the typed amount's value, the fees that left shown nowhere.
   */
  leaves?: bigint;
  tier: Tier;
  mode: ProtectionMode;
  preference: Preference;
  policy: Policy;
  destination: DestinationPolicy;
  usd: number | null;
  lint?: LintItem[] | null;
  /** the user's exposure fraction from Settings (bps); clamped by what the risk engine permits (§14; contract §2.2) */
  capBps?: number;
  /** V4: the user's concentration setting (bps of the order per provider), applied when two or more venues quote the size */
  providerShareCapBps?: number;
  /** the Chainlink cross-rate at confirmation (destination base units per source base unit, 1e18), when both feeds exist */
  crossRateE18?: bigint | null;
  gasPriceWei?: string | null;
  confirmations?: Partial<Campaign["confirmations"]>;
  /** institutional (V2 §24): the first step is not released before the review hold passes */
  reviewHoldUntil?: number;
  /** V7 (spec v3.0 §3): the relayer's terms at the Review — F bounds every piece's funding (the Review's `F × n`) */
  terms?: FeeTerms | null;
  now?: number;
  rng?: () => number;
  session?: WalletSession;
}

/**
 * The fee a piece's funding may pay at most (V7 Stage 12): the one fee note for delivering the piece to its escrow under the
 * Review's terms — exact output, as the funding itself prices it: p(W + f) + F (`feeForWithdrawal`), with the relayer's F of
 * the Review (`maxRelayerFee`) and its basis points (`relayerFeeBps`; the product's 100 when a campaign recorded none) — the
 * stored swap's `reviewedFee`, which the funding never exceeds; undefined for a campaign from before. The first full local
 * run after Stage 12 found the earlier bound, the piece's privacy share p(W) plus F, below what the relayer's rule asks for
 * delivering W: every step's funding was refused as a moved fee, and the campaign sat "committed" in the scheduler's backoff.
 */
export function stepReviewedFee(bounds: Pick<ExecutionBounds, "maxRelayerFee" | "relayerFeeBps">, amount: bigint): bigint | undefined {
  if (bounds.maxRelayerFee === undefined || !/^\d+$/.test(bounds.maxRelayerFee)) return undefined;
  return feeForWithdrawal(amount, { minimum: BigInt(bounds.maxRelayerFee), feePercentBps: bounds.relayerFeeBps ?? PRIVACY_FEE_BPS });
}

const CLASSES = new Set(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
const GATES = new Set(["source", "destination-submitted", "destination-final"]);
const num = (x: unknown, lo: number, hi: number): boolean => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const pair = (x: unknown, lo: number, hi: number): boolean => Array.isArray(x) && x.length === 2 && num(x[0], lo, hi) && num(x[1], lo, hi) && (x[0] as number) <= (x[1] as number);

/**
 * The service's protection plan when its shape is sound, else null (the seventh review round, 2026-11-03): the answer is advice read
 * without a runtime check (api/client.ts), and its gate, concurrency and cadence had been taken verbatim into the plan.
 */
export function protectionOf(x: unknown): Protection | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Protection;
  if (typeof p.provider !== "string" || !CLASSES.has(p.riskClass) || !GATES.has(p.gate)) return null;
  if (!pair(p.bandBps, 0, 10_000) || !num(p.capBps, 1, 10_000) || !num(p.providerShareCapBps, 0, 10_000)) return null;
  if ((p.concurrency !== "sequential" && p.concurrency !== "parallel") || !num(p.maxParallel, 1, 16) || !Number.isInteger(p.maxParallel)) return null;
  if (!pair(p.cadenceSeconds, 0, 30 * 86_400) || !num(p.executeWindowSeconds, 60, 7 * 86_400) || !num(p.estimatedSeconds, 0, 365 * 86_400)) return null;
  if (p.sizing !== undefined && p.sizing !== "bucket" && p.sizing !== "varied") return null;
  if (p.maxPieceUnits !== null && p.maxPieceUnits !== undefined && !(typeof p.maxPieceUnits === "string" && /^[1-9]\d{0,77}$/.test(p.maxPieceUnits))) return null;
  if (!p.concentration || typeof p.concentration.singleVenue !== "boolean") return null;
  if (!p.elpf || (p.elpf.perCampaignUsd !== null && !num(p.elpf.perCampaignUsd, 0, Number.MAX_SAFE_INTEGER))) return null;
  if (p.exposureTier !== undefined && !["R0", "R1", "R2", "R3", "R4"].includes(p.exposureTier)) return null;
  return p;
}

/**
 * A route's rules for the plan (the seventh review round, 2026-11-03): the class and the gate are the riskier and the stricter of the
 * wallet's own model of the route (riskModelOf, the shared core) and the service's recommendation; R5 and R6 routes, Maximum safety,
 * the $50K band and the institutional tiers run one step at a time, as the service's own rule says (two at most otherwise); the cadence
 * is never below the mode's. The answer had set all of them verbatim: a gate of "source" with no cadence released a bridge's next step
 * the moment the last one was mined, and the in-flight cap counted nothing that was still streaming.
 */
export function routeRules(i: { provider: string; quote?: ServiceQuote; from: { symbol: string }; to: { symbol: string }; mode: ProtectionMode; tier: Tier; protection: Protection | null }): Pick<TranchePlan, "riskClass" | "gate" | "concurrency" | "maxParallel" | "cadenceSeconds"> {
  const own = riskModelOf(i.provider, { plan: i.quote?.plan ?? null, sourceSwap: (i.quote?.hops?.length ?? 0) > 1, nativeAssets: i.quote?.nativeAssets }, i.from, i.to, i.mode);
  const p = i.protection;
  const riskClass = p ? riskierClass(own.class, p.riskClass as RiskClass) : own.class;
  const gate = stricterGate(gateFor(riskClass, i.mode), p ? p.gate : own.gate);
  const sequential = !p || p.concurrency === "sequential" || i.mode === "max-safety" || i.tier === "large-protected" || atLeast(i.tier, "institutional") || riskClass === "R5" || riskClass === "R6";
  const maxParallel = sequential ? 1 : Math.min(2, Math.max(1, Math.floor(p!.maxParallel)));
  const floor = PROTECTION_DEFAULTS[i.mode].cadenceSeconds;
  const asked = p ? p.cadenceSeconds : floor;
  const lo = Math.max(asked[0], floor[0]);
  return { riskClass, gate, concurrency: maxParallel > 1 ? "parallel" : "sequential", maxParallel, cadenceSeconds: [lo, Math.max(asked[1], floor[1], lo)] };
}

/** The planned steps sized again under the campaign's own plan (a route change): only planned steps change; the first keeps its wait. */
function resizePlanned(c: Campaign, now: number, rng: () => number): Campaign {
  const planned = c.tranches.filter((t) => t.state === "planned");
  const sum = planned.reduce((a, t) => a + BigInt(t.amount), 0n);
  if (sum <= 0n) return c;
  const split = planTranches(sum, { decimals: c.request.from.decimals, bandBps: c.plan.bandBps, capBps: c.plan.capBps, sizing: c.plan.sizing, maxParallel: c.plan.maxParallel, rng, reference: BigInt(c.request.amount), exact: c.plan.exact, ...(c.plan.maxPiece ? { maxPiece: BigInt(c.plan.maxPiece) } : {}) });
  let out = replan(c, split.pieces, now);
  const wait = planned[0].notBefore;
  const first = out.tranches.find((t) => t.state === "planned");
  if (wait !== undefined && first) out = withTrancheState(out, first.index, "planned", now, { notBefore: wait });
  return out;
}

/**
 * A campaign on a new route (the seventh review round, 2026-11-03): an accepted reroute, or a route adopted automatically at a requote
 * or at a step's commit. The plan's class, gate, concurrency and cadence become the new route's (routeRules); the in-flight cap may only
 * go down; the piece ceiling is the new route's; the planned steps are sized again when one no longer fits. Only `provider` had
 * changed: after a change from an R2 route, R5 steps ran two at a time and settled at "destination submitted".
 */
export function withRoute(c: Campaign, provider: string, protection: unknown, quote: ServiceQuote | undefined, now: number, rng: () => number = cryptoUniform): Campaign {
  const p = protectionOf(protection);
  const rules = routeRules({ provider, quote, from: c.request.from, to: c.request.to, mode: c.mode, tier: c.tier, protection: p });
  const total = BigInt(c.request.amount);
  let capBps = c.plan.capBps;
  if (p) {
    const exposureTier = (p.exposureTier ?? "R3") as ExposureTier;
    const core = capBpsFor({ tier: c.tier, mode: c.mode, exposureTier, userCapBps: c.plan.capBps });
    capBps = Math.min(capBps, exposureTier === "R0" || exposureTier === "R1" ? core.capBps : Math.min(core.capBps, p.capBps));
  }
  const band = p ? p.bandBps : c.plan.bandBps;
  const maxPiece = p ? (p.maxPieceUnits ?? undefined) : c.plan.maxPiece;
  const rest: TranchePlan = { ...c.plan };
  delete rest.maxPiece;
  const plan: TranchePlan = { ...rest, ...rules, capBps, bandBps: [Math.min(band[0], capBps), Math.min(band[1], capBps)], ...(maxPiece !== undefined ? { maxPiece } : {}) };
  const capNow = BigInt(c.bounds.maxExternalExposure);
  const cap = (total * BigInt(capBps)) / 10000n;
  return fitPlanned({ ...c, provider, plan, bounds: { ...c.bounds, maxExternalExposure: (cap < capNow ? cap : capNow).toString() } }, now, rng);
}

/** The largest piece the plan allows: the in-flight cap, or the route's piece ceiling when lower (the seventh review round). */
export function pieceCeiling(c: Campaign): bigint {
  const cap = BigInt(c.bounds.maxExternalExposure);
  return c.plan.maxPiece !== undefined && BigInt(c.plan.maxPiece) < cap ? BigInt(c.plan.maxPiece) : cap;
}

/** The planned steps sized again when one no longer fits the in-flight cap or the route's piece ceiling (a route change; the seventh review round). */
export function fitPlanned(c: Campaign, now: number, rng: () => number = cryptoUniform): Campaign {
  const ceiling = pieceCeiling(c);
  return c.tranches.some((t) => t.state === "planned" && BigInt(t.amount) > ceiling) ? resizePlanned(c, now, rng) : c;
}

/** The plan and the bounds from the recommendation and the confirmation (pure); the campaign is not journaled here. */
export function buildCampaign(i: StartCampaignInput): Campaign {
  const now = i.now ?? Date.now();
  if (!i.quotes.protection) throw new Error("the swap service gave no protection plan for this order; a protected execution needs one");
  const p = protectionOf(i.quotes.protection);
  if (!p) throw new Error("the swap service's protection plan for this order is malformed; a protected execution needs a sound one");
  const quote: ServiceQuote | undefined = i.quotes.quotes.find((q) => q.provider === i.provider);
  if (!quote) throw new Error(`no quote from ${i.provider}`);
  const defaults = PROTECTION_DEFAULTS[i.mode];
  // the cap (contract §2.2): the band's default, the route's exposure tier, the mode and the user's fraction clipped to the band's range — above the service's recommendation only on an R0 / R1 route
  const exposureTier = (p.exposureTier ?? "R3") as ExposureTier;
  const core = capBpsFor({ tier: i.tier, mode: i.mode, exposureTier, userCapBps: i.capBps });
  const capBps = exposureTier === "R0" || exposureTier === "R1" ? core.capBps : Math.min(core.capBps, p.capBps);
  const band: [number, number] = [Math.min(p.bandBps[0], capBps), Math.min(p.bandBps[1], capBps)];
  const sizing = p.sizing ?? defaults.sizing;
  // the route's rules: the wallet's own model of the route and the service's advice, whichever is stricter (the seventh review round)
  const rules = routeRules({ provider: i.provider, quote, from: i.from, to: i.to, mode: i.mode, tier: i.tier, protection: p });
  const maxParallel = rules.maxParallel;
  const rng = i.rng ?? cryptoUniform;
  // V7 Stage 13 (spec v3.0 §4): the $50K band's steps are the planner's varied pieces too — the V5 exact quarters are withdrawn
  const split = planTranches(i.amount, { decimals: i.from.decimals, bandBps: band, capBps, sizing, maxParallel, maxPiece: p.maxPieceUnits ? BigInt(p.maxPieceUnits) : undefined, rng });
  const cap = (i.amount * BigInt(capBps)) / 10000n;
  // the rate per unit of what the set was asked for (c49): over the smaller steps amount, the whole order's minimum
  // overstated it, and every step paused at commit; and per unit paid to the provider when the set names the executor tip
  // it is net of (c55): each step pays its own
  const quoted = i.quotedAmount ?? i.amount;
  const slip = (rate: bigint) => (rate * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n;
  const minimumOutput = slip(rateE18(BigInt(quote.toAmountMin), quoted));
  const setTip = i.quotes.executorTip !== undefined ? BigInt(i.quotes.executorTip) : null;
  const minimumOutputNet = setTip !== null && setTip < quoted ? slip(rateE18(BigInt(quote.toAmountMin), quoted - setTip)) : null;
  const estimated = Math.max(p.estimatedSeconds, 3600);
  const bounds: ExecutionBounds = {
    orderId: randomId(), assetIn: i.from, chainIn: i.from.chain, amountInLimit: i.amount.toString(), assetOut: i.to, chainOut: i.to.chain, destination: i.destination,
    minimumOutput: minimumOutput.toString(), ...(minimumOutputNet !== null ? { minimumOutputNet: minimumOutputNet.toString() } : {}), expiry: Math.floor(now / 1000) + 2 * estimated + EXPIRY_MARGIN_SECONDS, maxFeeBps: DEFAULT_MAX_FEE_BPS, privacyMode: i.mode,
    maxExternalExposure: cap.toString(), executeWindowSeconds: p.executeWindowSeconds,
    ...(i.terms ? { maxRelayerFee: i.terms.minimum.toString(), relayerFeeBps: i.terms.feePercentBps } : {}),
    // each step's tip at most the set's × CONGESTION_FACTOR: the stated Minimum counts every step at that (the seventh review round, B2)
    ...(setTip !== null && setTip > 0n ? { maxExecutorTip: (setTip * BigInt(CONGESTION_FACTOR)).toString() } : {}),
  };
  const plan: TranchePlan = {
    riskClass: rules.riskClass, bandBps: band, capBps, sizing, concurrency: rules.concurrency, maxParallel, gate: rules.gate, cadenceSeconds: rules.cadenceSeconds,
    providerShareCapBps: p.concentration.singleVenue ? 10000 : Math.min(p.providerShareCapBps || 10000, i.providerShareCapBps ?? 10000), executeWindowSeconds: p.executeWindowSeconds, estimatedTranches: split.pieces.length, estimatedSeconds: p.estimatedSeconds,
    shapeNotes: !notesShapedFor(i.fromAsset.vault, split.pieces.reduce((m, x) => (x > m ? x : m), 0n)), ...(p.maxPieceUnits ? { maxPiece: p.maxPieceUnits } : {}), ...(p.elpf.perCampaignUsd !== null ? { elpfUsd: p.elpf.perCampaignUsd } : {}),
  };
  // the reference rate (§3): the Chainlink cross-rate when both feeds exist, else the quote's expected rate (then the deviation check compares like with like only approximately)
  const referenceRateE18 = i.crossRateE18 && i.crossRateE18 > 0n ? i.crossRateE18 : rateE18(BigInt(quote.toAmount), quoted);
  const c = createCampaign({
    id: bounds.orderId, now, mode: i.mode, tier: i.tier, request: { from: i.from, to: i.to, amount: i.amount.toString(), preference: i.preference }, bounds, plan, pieces: split.pieces, referenceRateE18,
    riskSnapshot: { protection: p, risk: i.quotes.risk ?? null, competition: i.quotes.competition ?? null, quote, usd: i.usd, privacyScore: i.quotes.scores.find((x) => x.provider === i.provider)?.components.privacy ?? null }, confirmations: i.confirmations,
  });
  if (i.reviewHoldUntil !== undefined && c.tranches.length) c.tranches[0] = { ...c.tranches[0], notBefore: i.reviewHoldUntil };
  // the hold journaled on the campaign itself (the seventh review round, D1): no step is committed before it, whatever a requote draws
  return { ...c, provider: i.provider, policy: i.policy, ...(i.reviewHoldUntil !== undefined ? { holdUntil: i.reviewHoldUntil } : {}), ...(i.gasPriceWei ? { gasPriceAtConfirmationWei: i.gasPriceWei } : {}), ...(i.lint ? { lint: { items: i.lint, at: now } } : {}), ...(i.usd !== null ? { value: { usd: i.usd, at: now } } : {}) };
}

/** The confirmation (§7): journal the campaign, its Activity line and the first tick (now). */
export function startCampaign(i: StartCampaignInput): Campaign {
  const s = i.session ?? defaultSession;
  assertJournalSaved(s); // its record would be lost at the next lock (audit round 2, r47)
  const c = buildCampaign(i);
  s.update((j) => { j.campaigns = [...(j.campaigns ?? []), c]; });
  recordActivity({ id: activityId("campaign", c.id), kind: "campaign", asset: i.from.symbol, decimals: i.from.decimals, amount: (i.leaves ?? i.amount).toString(), status: c.state, ref: c.id, note: `→ ${i.to.symbol} · ${progressLine(c)}` }, s);
  scheduleTick(c.id, i.now ?? Date.now(), s);
  return c;
}

/** The runner's next tick, under the campaign's own action id (re-scheduling replaces it; the scheduler keeps a re-scheduled action pending). */
export function scheduleTick(campaignId: string, dueAt: number, s: WalletSession = defaultSession): void {
  const current = s.isUnlocked() ? s.journal().schedule.find((a) => a.id === `campaign-tick:${campaignId}`) : undefined;
  const at = current && !current.done && dueAt <= current.dueAt && current.dueAt > Date.now() ? dueAt : Math.max(dueAt, (current?.dueAt ?? 0) + 1);
  scheduleAction({ kind: "campaign-tick", orderId: campaignId, dueAt: at }, s);
}

/** Pause (the campaign's own button): releases stop; in-flight steps are still tracked (§8). */
export function pauseCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || TERMINAL_STATES.includes(c.state) || c.state === "paused") return c;
  const paused = withAlert(withCampaignState(c, "paused", now, "paused by you", { pause: { reason: "user", detail: "Paused by you. Steps already handed over continue and are tracked.", at: now }, decidedAt: now }), "paused", "Paused by you.", now);
  putCampaign(paused, s);
  scheduleTick(id, now, s);
  return paused;
}

/** Resume: reassess (fresh facts) → requote → a new Review when the route changed (§8). The runner does the work; this records the decision. */
export function resumeCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || (c.state !== "paused" && c.state !== "rerouting")) return c;
  const resumed = withAlert(withCampaignState(c, "reassessing", now, "resumed by you", { pause: undefined, pendingReroute: undefined, decidedAt: now }), "resumed", "Resumed: the facts are checked, then the remaining amount is quoted again.", now);
  putCampaign(resumed, s);
  scheduleTick(id, now, s);
  return resumed;
}

/** The reroute Review's answer (§8): adopt the new route and continue, or return the rest. */
export function acceptReroute(id: string, accept: boolean, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || c.state !== "rerouting" || !c.pendingReroute) return c;
  const next = accept
    ? withAlert(withCampaignState(withRoute(c, c.pendingReroute.provider, c.pendingReroute.protection, undefined, now), "running", now, `route changed to ${c.pendingReroute.provider}, confirmed by you`, { pendingReroute: undefined, pause: undefined, decidedAt: now }), "route-changed", `The route changed to ${c.pendingReroute.provider}; you confirmed it.`, now)
    : withCampaignState(c, "winding-down", now, "the new route was declined: the rest returns", { pendingReroute: undefined, decidedAt: now });
  putCampaign(next, s);
  scheduleTick(id, now, s);
  return next;
}

/** Cancel ("Return the rest to my private balance"): planned tranches are skipped, funded ones refunded, in-flight ones finish (§8). */
export function cancelCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || TERMINAL_STATES.includes(c.state)) return c;
  let next = withCampaignState(c, "winding-down", now, "cancelled by you: the rest returns to the private balance", { pendingReroute: undefined, decidedAt: now });
  for (const t of next.tranches) if (t.state === "planned" || t.state === "ready") next = withTrancheState(next, t.index, "skipped", now, {}, "cancelled before it started");
  next = withAlert(next, "cancelled", "Returning the rest to your private balance; steps already handed over finish first.", now);
  putCampaign(next, s);
  scheduleTick(id, now, s);
  return next;
}

/**
 * A tick's campaign about to be journaled over the journal's own (the audit round of 2026-10-16, c36): an answer the user
 * gave while the tick ran — pause, resume, a reroute's answer, return the rest — is kept. The tick wrote what it had read
 * before the answer, so the answer was lost and the campaign kept executing. `base` is the campaign the tick started
 * from, `latest` the journal's now. The tick's own facts stay (its steps, what it sent); the answer's campaign-level fields
 * come from the journal, its history and alerts are added, and "return the rest" skips what is still planned. A campaign
 * the tick finished stays finished.
 */
export function keepDecisions(base: Campaign, latest: Campaign, tick: Campaign): Campaign {
  if (latest.decidedAt === undefined || Object.is(latest.decidedAt, base.decidedAt) || TERMINAL_STATES.includes(tick.state)) return tick;
  // what the answer added, by identity (audit round 2, n16): by length, the answer's own alert was lost once the alerts were
  // full (the cap drops the oldest, so the slice past the base's count was empty), and the entries this tick had journaled
  // before the answer came back twice
  const historyKey = (h: Campaign["history"][number]) => `${h.at}|${h.state}|${h.note ?? ""}`;
  const alertKey = (a: CampaignAlert) => `${a.at}|${a.kind}|${a.text}|${a.trancheIndex ?? ""}`;
  const tickHistory = new Set(tick.history.map(historyKey));
  const history = [...tick.history, ...latest.history.filter((h) => !tickHistory.has(historyKey(h)))].sort((a, b) => a.at - b.at);
  const tickAlerts = new Set((tick.alerts ?? []).map(alertKey));
  const alerts = [...(tick.alerts ?? []), ...(latest.alerts ?? []).filter((a) => !tickAlerts.has(alertKey(a)))].sort((a, b) => a.at - b.at).slice(-MAX_ALERTS);
  let merged: Campaign = {
    ...tick,
    state: latest.state,
    pause: latest.pause,
    pendingReroute: latest.pendingReroute,
    provider: latest.provider,
    decidedAt: latest.decidedAt,
    history,
    ...(alerts.length ? { alerts } : {}),
  };
  if (merged.state === "winding-down")
    for (const t of merged.tranches) if (t.state === "planned" || t.state === "ready") merged = withTrancheState(merged, t.index, "skipped", latest.decidedAt, {}, "cancelled before it started");
  return merged;
}

/** Re-plan the unfunded remainder of a campaign (after a refund) with the campaign's own plan and the CSPRNG. */
export function replanRemainder(c: Campaign, now: number, rng: () => number = cryptoUniform): Campaign {
  const e = exposure(c);
  if (e.remaining <= 0n) return c;
  // with the route's piece ceiling (the thin-market rule, an instant limit): a re-plan had gone back to the band's full size (the seventh review round)
  const split = planTranches(e.remaining, { decimals: c.request.from.decimals, bandBps: c.plan.bandBps, capBps: c.plan.capBps, sizing: c.plan.sizing, maxParallel: c.plan.maxParallel, rng, reference: e.total, exact: c.plan.exact, ...(c.plan.maxPiece ? { maxPiece: BigInt(c.plan.maxPiece) } : {}) });
  return replan(c, split.pieces, now);
}

/** Forget a finished campaign's tick (nothing else is removed: the audit trail stays in the journal). */
export function forgetCampaignTick(id: string, s: WalletSession = defaultSession): void { cancelAction(`campaign-tick:${id}`, s); }

/** The destination amount a source amount is expected to bring at the tranche's rate (destination base units). */
export const expectedOut = (amountIn: bigint, rate: bigint): bigint => (amountIn * rate) / RATE_SCALE;
/** The source-unit equivalent of a delivered destination amount at the tranche's expected rate (for the accounting of §5). */
export const sourceEquivalent = (deliveredOut: bigint, rate: bigint): bigint => (rate > 0n ? (deliveredOut * RATE_SCALE) / rate : 0n);
