// @vitest-environment happy-dom
// The campaign runner (High-Value Protection spec §5–§9, Stage 4) against a scripted world: a $10M ETH → BTC order
// confirmed as a campaign is journaled with its bounds and its pieces in band; the scheduler's ticks take tranche 1
// through commit → fund → sign → hand-over one action each, track it, apply the destination-final gate with the
// Bitcoin margin, draw the cadence and only then commit tranche 2 (sequential: never two in flight); a funding or a
// hand-over whose outcome is unknown pauses with `reconcile` and the next tick continues from the facts without a
// second withdrawal or hand-over; an open breaker and the global switch pause; a resume whose fresh competition
// chose another provider waits for the reroute Review; cancel returns the funded tranche through a refund-only job;
// the tick survives a lock. The scheduler keeps a re-scheduled action pending.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { exposure, type Campaign, type Tranche } from "@privacy-wallet/protocol/wallet/campaign";
import { WalletSession, session as defaultSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { emptyJournal, type ScheduledAction, type StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings, healSettings, healProtection, DEFAULT_PROTECTION, PROTECTION_DEFAULTS } from "@privacy-wallet/sdk/wallet/settings";
import { pendingActions, scheduleAction, schedulerStatus } from "@privacy-wallet/sdk/wallet/schedule";
import { trancheMinimum } from "@privacy-wallet/protocol/wallet/campaign";
import { acceptReroute, buildCampaign, campaignById, cancelCampaign, pauseCampaign, resumeCampaign, startCampaign, BOUNDS_SLIPPAGE_BPS } from "@privacy-wallet/sdk/wallet/campaigns";
import { runCampaignTick, resetRunnerMemory, type CampaignIo } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { activityOf, activityStatusLabel, KIND_LABELS, isFinished } from "@privacy-wallet/sdk/wallet/activity";
import type { WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import type { Signed } from "@privacy-wallet/sdk/swapExecute";
import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import type { SwapJob } from "@privacy-wallet/sdk/relayer";
import { ProviderCallUnverified } from "@privacy-wallet/sdk/providerCall";
import { OrderOutdated, type FundingFate } from "@privacy-wallet/sdk/swapFunding";
import type { AssetRef, Protection, QuoteSet, RiskView, ServiceOrder, ServiceQuote } from "@privacy-wallet/sdk/swapService";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { useScheduler } from "../src/hooks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const KDF = { N: 1 << 12, r: 8, p: 1 };
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY };
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
const AMOUNT = eth(2500); // $10M at $4,000
const OUT = 100n * 10n ** 8n; // 100 BTC
const OUT_MIN = OUT - OUT / 200n; // 0.5 % tolerance in the quote
const T0 = Date.parse("2026-10-08T12:00:00Z");
const quote = (provider = "thorchain", amount = AMOUNT): ServiceQuote => ({ provider, category: "A", toAmount: ((OUT * amount) / AMOUNT).toString(), toAmountMin: ((OUT_MIN * amount) / AMOUNT).toString(), fees: [], etaSeconds: 1400, expiresAt: Math.floor(T0 / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], plan: { mode: "streaming", parts: 205, intervalBlocks: 1, expectedSeconds: 1400 }, impactBps: 9 });
const protection = (provider = "thorchain"): Protection => ({ provider, riskClass: "R5", flags: [], custody: "tss-vaults", bandBps: [200, 200], capBps: 200, sizing: "varied", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 50, estimatedSeconds: 250_000, trancheUsd: [200_000, 200_000], capUsd: 200_000, trancheImpactBps: 0.18, thinMarket: false, maxPieceUnits: null, concentration: { providers: [{ id: provider, shareBps: 10000 }], singleVenue: true, capBps: 10000 }, elpf: { prior: 0.02, pFailure: 0.02, perTrancheUsd: 4000, perCampaignUsd: 4000 }, staged: false, reasons: [] });
const score = (provider: string) => ({ provider, total: 80, components: { price: 80, security: 69, privacy: 70, latency: 60, liquidity: 80, reliability: 100 } });
const quoteSet = (provider = "thorchain", amount = AMOUNT): QuoteSet => ({ quotes: [quote(provider, amount)], scores: [score(provider)], errors: {}, chosen: score(provider), links: {}, tier: "institutional", policy: "privacy-execution", competition: [{ provider, outcome: "quoted", ms: 100 }], protection: protection(provider) });

/** A scripted world behind the runner's I/O interface: every call is counted; the facts are what the test sets. */
class World implements CampaignIo {
  calls: string[] = [];
  n = 0;
  escrow = new Map<string, bigint>();
  jobs = new Map<string, SwapJob>();
  tracked = new Map<string, Tracked["state"]>();
  delivered = new Map<string, string>();
  refundsBack = new Set<string>();
  fundThrowsAfterSend = false;
  /** thrown once by the next funding before anything is sent */
  fundThrows: Error | null = null;
  /** the funding is sent and journaled (as fundEscrow does) but has not landed; its answer is lost */
  fundPendingAfterSend = false;
  /** what the runner learns of a journaled funding */
  fate: FundingFate = "unknown";
  /** awaited by the next commit, so a test can answer while a tick runs */
  gate: Promise<void> | null = null;
  handOverThrows = false;
  /** thrown once by the next hand-over, before the executor took anything */
  handOverRefusal: Error | null = null;
  /** the next signature fails with this (then signs normally) */
  signThrows: Error | null = null;
  /** the settlement read fails (the service or the network is down) */
  trackThrows = false;
  moved = false;
  /** what a fresh hard quote guarantees at signing, when the market moved since the step's commit */
  minOutAtSign: bigint | null = null;
  /** the least each signing was told to accept */
  acceptMins: (bigint | undefined)[] = [];
  /** the API's price guard refuses the hard quote (another route beats it by more than the band) */
  guardRefuses = false;
  breakerOpen = false;
  /** providers whose breaker alone is open */
  brokenProviders = new Set<string>();
  incidents: string[] = [];
  chosen = "thorchain";
  /** the provider the competition at a step's size chooses (the campaign's when null) */
  sizeChosen: string | null = null;
  noQuote = false;
  gas: string | null = null;
  crossRate: bigint | null = null;
  shaped = true;
  /** what the last tracker read reported for the service's stall count */
  lastStall: { since: number; expected: number } | undefined;
  constructor(readonly s: WalletSession, readonly now: () => number) {}
  private stored(orderId: string): StoredSwap { return this.s.journal().swaps.find((x) => x.orderId === orderId)!; }
  async commit(c: Campaign, t: Tranche, destination: string) {
    this.calls.push(`commit:${t.index}:${c.provider}`);
    if (this.gate) await this.gate;
    const orderId = ("0x" + (++this.n).toString(16).padStart(64, "0")) as `0x${string}`;
    const q = quote(this.sizeChosen ?? c.provider ?? "thorchain", BigInt(t.amount));
    const nowS = Math.floor(this.now() / 1000);
    const params = { orderId, assetType: 0, asset: "0x0000000000000000000000000000000000000000" as `0x${string}`, amount: t.amount, orderSigner: "0x00000000000000000000000000000000000000a1" as `0x${string}`, executeDeadline: q.expiresAt + 7200, refundAfter: q.expiresAt + 14400, refundVault: ETH_VAULT, refundOwnerCommitment: "1", refundNoteSecret: "2", refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}`, executorTip: (BigInt(t.amount) / 400n).toString() };
    const stored: StoredSwap = { orderId, attemptId: "0x" + "22".repeat(32), refundCounter: this.n, provider: q.provider, policy: "privacy-execution", request: { from: c.request.from, to: c.request.to, amount: t.amount, destination, slippageBps: 50 }, params, endpoint: "0x00000000000000000000000000000000000000e5", quote: q, approvedMin: q.toAmountMin, createdAt: nowS * 1000, state: "committed", refundNoteData: "0x01" + "00".repeat(168), campaign: { id: c.id, index: t.index }, tier: c.tier };
    this.s.update((j) => { j.swaps = [...j.swaps, stored]; });
    const order: ServiceOrder = { orderId, endpoint: stored.endpoint as `0x${string}`, state: "QUOTED", quote: q, params, privacy: { delaySeconds: [0, 0], score: 80 } };
    return { stored, order };
  }
  async fund(stored: StoredSwap, onStatus: (l: string) => void) {
    this.calls.push(`fund:${stored.campaign!.index}`);
    if (this.fundThrows) { const e = this.fundThrows; this.fundThrows = null; throw e; }
    if (this.fundPendingAfterSend) {
      onStatus("Proof ready in 1.0 s; handing it to the relayer (your address never touches the chain)…");
      this.s.update((j) => { const x = j.swaps.find((y) => y.orderId === stored.orderId)!; x.fundingAttempt = { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: this.now() }; });
      throw new Error("relayer unreachable");
    }
    if (this.fundThrowsAfterSend) {
      onStatus("Proof ready in 1.0 s; handing it to the relayer (your address never touches the chain)…");
      this.escrow.set(stored.orderId, BigInt((stored.params as { amount: string }).amount)); // the withdrawal landed although the answer was lost
      throw new Error("relayer unreachable");
    }
    this.escrow.set(stored.orderId, BigInt((stored.params as { amount: string }).amount));
    this.s.update((j) => { const x = j.swaps.find((y) => y.orderId === stored.orderId)!; x.fundedTx = "0x" + "33".repeat(32); x.state = "funded"; });
    return { txHash: "0x" + "33".repeat(32) };
  }
  async escrowBalance(stored: StoredSwap) { this.calls.push(`balance:${stored.campaign!.index}`); return this.escrow.get(stored.orderId) ?? 0n; }
  async fundingFate(): Promise<FundingFate> { return this.fate; }
  async sign(stored: StoredSwap, acceptMin?: bigint): Promise<Signed | { moved: any }> {
    this.calls.push(`sign:${stored.campaign!.index}`);
    if (this.signThrows) { const e = this.signThrows; this.signThrows = null; throw e; }
    this.acceptMins.push(acceptMin);
    if (this.moved) return { moved: { minOut: 1n, approved: 2n } };
    if (this.minOutAtSign !== null) {
      const floor = acceptMin ?? BigInt(stored.approvedMin ?? "0");
      if (this.minOutAtSign < floor) return { moved: { minOut: this.minOutAtSign, approved: floor } };
    }
    if (this.guardRefuses) throw new Error("price_guard: this route is 80 bps below the best alternative");
    const q = stored.quote as ServiceQuote;
    return { prepared: { digest: "0x" + "44".repeat(32), provider: "0x00000000000000000000000000000000000000ad", value: (stored.params as { amount: string }).amount, calldata: "0x", deadline: q.expiresAt } as Signed["prepared"], params: stored.params as Signed["params"], call: { minOut: BigInt(q.toAmountMin), refundTo: "escrow", provider: "thorchain", facts: [] } as unknown as Signed["call"], signature: ("0x" + "55".repeat(65)) as `0x${string}`, sim: { ok: true, gas: 210_000n, endpoints: 1, preview: false }, label: "valid until later" };
  }
  async handOver(stored: StoredSwap) {
    this.calls.push(`handover:${stored.campaign!.index}`);
    if (this.handOverRefusal) { const e = this.handOverRefusal; this.handOverRefusal = null; throw e; }
    const job: SwapJob = { id: stored.orderId, escrow: stored.endpoint as `0x${string}`, state: "executing", updatedAt: this.now() };
    this.jobs.set(stored.orderId, job);
    if (this.handOverThrows) throw new Error("socket hang up"); // the executor took the job, the answer was lost
    this.s.update((j) => { const x = j.swaps.find((y) => y.orderId === stored.orderId)!; x.jobId = job.id; x.state = job.state; });
    return { job };
  }
  async job(stored: StoredSwap) { this.calls.push(`job:${stored.campaign!.index}`); return this.jobs.get(stored.orderId) ?? null; }
  async track(stored: StoredSwap, stall?: { since: number; expected: number }) {
    this.calls.push(`track:${stored.campaign!.index}`);
    this.lastStall = stall;
    if (this.trackThrows) throw new Error("ECONNRESET");
    const job = this.jobs.get(stored.orderId) ?? null;
    const state = this.tracked.get(stored.orderId) ?? (job?.state === "refund-only" ? "REFUND_PENDING" : job ? "PROVIDER_EXECUTING" : "SOURCE_FINAL");
    if (this.refundsBack.has(stored.orderId)) this.s.update((j) => { const x = j.swaps.find((y) => y.orderId === stored.orderId)!; x.refunds = [{ leafIndex: 9, vault: ETH_VAULT, amount: "1" }]; });
    const tracked: Tracked = { state, label: "Executing", steps: [true, true, false, false], detail: `state ${state}`, ...(this.delivered.has(stored.orderId) ? { deliveredAmount: "the tracker's words, never units", deliveredUnits: this.delivered.get(stored.orderId) } : {}) }; // as orderTracker reports them (a V6 follow-up of 2026-10-16: the runner had parsed the words, which read 0)
    return { tracked, job };
  }
  async refund(stored: StoredSwap) {
    this.calls.push(`refund:${stored.campaign!.index}`);
    const job: SwapJob = { id: stored.orderId, escrow: stored.endpoint as `0x${string}`, state: "refund-only", updatedAt: this.now() };
    this.jobs.set(stored.orderId, job);
    this.s.update((j) => { const x = j.swaps.find((y) => y.orderId === stored.orderId)!; x.jobId = job.id; x.state = job.state; });
    return job;
  }
  async quote(_c: Campaign, amount: bigint) { this.calls.push(`quote:${amount / 10n ** 18n}`); if (this.noQuote) return { ...quoteSet(this.chosen, amount), quotes: [], scores: [], chosen: undefined }; return quoteSet(this.chosen, amount); }
  async risk(provider: string): Promise<RiskView> { return { provider, model: { class: "R5", flags: [], custody: "tss-vaults", gate: "destination-final", pFailPrior: 0.02, bandBps: [100, 250] }, security: { total: 69, baseline: 84, incidents: -15, incidentList: this.incidents.map((date) => ({ provider, date, title: "t", lossUsd: 0, class: "api", halfLifeDays: 30, source: "s" })) }, breaker: { open: this.breakerOpen || this.brokenProviders.has(provider) ? "skipped after 3 consecutive failures" : null, failures: { consecutive: 0, windowCount: 0 }, stalls: 0, divergences: 0, probe: false, lastIncidentAt: null }, record: null, routes: [] }; }
  async gasPriceWei() { return this.gas; }
  crossRateE18() { return this.crossRate; }
  async shape() { this.calls.push("shape"); this.shaped = true; }
  notesShaped() { return this.shaped; }
  freshDestination() { return { address: `bc1qfresh${this.n}`, index: this.n }; }
}

let session: WalletSession;
let seed: Uint8Array;
let world: World;
let clock = T0;
let notes: WalletNotification[] = [];
const notify = (n: { kind: WalletNotification["kind"]; title: string; body: string; campaignId?: string }) => { const full = { id: String(notes.length), at: clock, ...n }; notes.push(full); return full; };
const action = (c: Campaign): ScheduledAction => session.journal().schedule.find((a) => a.id === `campaign-tick:${c.id}`) ?? { id: `campaign-tick:${c.id}`, kind: "campaign-tick", orderId: c.id, dueAt: clock };
const tick = (c: Campaign) => runCampaignTick(action(c), { masterSeed: seed, deployment, session, io: world, now: () => clock, settings: () => settings.get(), notify: notify as never, rng: () => 0.5 });
const current = (c: Campaign): Campaign => campaignById(c.id, session)!;
const states = (c: Campaign) => current(c).tranches.map((t) => t.state);

async function fresh(): Promise<Campaign> {
  const c = startCampaign({ quotes: quoteSet(), provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "institutional", mode: "balanced", preference: "balanced", policy: "privacy-execution", destination: { kind: "fresh-per-tranche" }, usd: 10_000_000, confirmations: { secondFactor: T0, secondDevice: T0 }, now: clock, rng: () => 0.5, session, gasPriceWei: "20000000000" });
  return c;
}
/** Tranche 1 from planned to in flight: four ticks (commit, fund, sign, hand-over). */
async function toInFlight(c: Campaign): Promise<void> {
  for (const expected of ["commit", "fund", "sign", "hand-over"]) { const r = await tick(c); expect(r?.action.kind, expected).toBe(expected); clock += 2000; }
}

beforeEach(async () => {
  clock = T0; notes = [];
  settings.reset();
  noteStore.clear();
  session = new WalletSession(memoryStorage(), KDF);
  seed = new Uint8Array(32).fill(7);
  await session.create("a strong password", seed);
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: eth(3000), ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  world = new World(session, () => clock);
  resetRunnerMemory();
  schedulerStatus.reset();
});
afterEach(() => { session.forget(); });

describe("starting a campaign (spec §3, §4, §17)", () => {
  it("journals the campaign with its bounds, pieces in band and the first tick; the empty journal and a V2 journal are untouched", async () => {
    const c = await fresh();
    const j = session.journal();
    expect(j.campaigns).toHaveLength(1);
    expect(c.state).toBe("user-confirmed");
    expect(c.tranches).toHaveLength(50);
    for (const t of c.tranches) expect(BigInt(t.amount)).toBe(eth(50)); // 2 % of 2,500 ETH: a bucket of the alphabet
    expect(c.bounds).toMatchObject({ amountInLimit: AMOUNT.toString(), maxExternalExposure: eth(50).toString(), executeWindowSeconds: 7200, privacyMode: "balanced", destination: { kind: "fresh-per-tranche" } });
    expect(BigInt(c.bounds.minimumOutput)).toBe((((OUT_MIN * 10n ** 18n) / AMOUNT) * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n);
    expect(c.bounds.expiry).toBeGreaterThan(Math.floor(T0 / 1000) + 2 * 250_000);
    expect(c.plan).toMatchObject({ riskClass: "R5", capBps: 200, concurrency: "sequential", maxParallel: 1, gate: "destination-final", shapeNotes: false, elpfUsd: 4000 });
    expect(c).toMatchObject({ provider: "thorchain", policy: "privacy-execution", gasPriceAtConfirmationWei: "20000000000", tier: "institutional" });
    expect(c.confirmations).toMatchObject({ commit: T0, secondFactor: T0, secondDevice: T0 });
    expect(pendingActions(session).map((a) => a.id)).toEqual([`campaign-tick:${c.id}`]);
    expect(activityOf(j).find((r) => r.kind === "campaign")).toMatchObject({ status: "user-confirmed", amount: AMOUNT.toString(), asset: "ETH" });
    expect(KIND_LABELS.campaign).toBe("Protected swap");
    expect(activityStatusLabel({ kind: "campaign", status: "running" })).toBe("In progress");
    expect(isFinished({ kind: "campaign", status: "running" })).toBe(false);
    expect(isFinished({ kind: "campaign", status: "completed" })).toBe(true);
    // the user's cap (V4, contract §2.2): inside the band's range, never above the service's recommendation, and above the band's default only on an R0 / R1 exposure tier
    expect(buildCampaign({ quotes: quoteSet(), provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "high-value", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: null, capBps: 300, now: clock, rng: () => 0.5, session }).plan.capBps).toBe(200);
    const r3 = { ...quoteSet("near-intents"), protection: { ...protection("near-intents"), riskClass: "R2", bandBps: [200, 300] as [number, number], capBps: 250, concurrency: "parallel" as const, maxParallel: 2, gate: "destination-submitted" as const } };
    expect(buildCampaign({ quotes: r3, provider: "near-intents", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "high-value", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: null, capBps: 300, now: clock, rng: () => 0.5, session }).plan, "a solver route without a signed hard quote is exposure tier R3: the default holds").toMatchObject({ capBps: 250, concurrency: "parallel", maxParallel: 2 });
    const r1 = { ...r3, protection: { ...r3.protection, exposureTier: "R1" as const, capBps: 250 } };
    expect(buildCampaign({ quotes: r1, provider: "near-intents", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "high-value", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: null, capBps: 300, now: clock, rng: () => 0.5, session }).plan.capBps, "a signed hard quote (R1): the user may raise the cap to 3 %").toBe(300);
    expect(buildCampaign({ quotes: r1, provider: "near-intents", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "high-value", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: null, capBps: 120, now: clock, rng: () => 0.5, session }).plan.capBps, "and lower it anywhere").toBe(120);
    expect(buildCampaign({ quotes: { ...r1, protection: { ...r1.protection, exposureTier: "R4", capBps: 100 } }, provider: "near-intents", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: AMOUNT, tier: "high-value", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: null, capBps: 300, now: clock, rng: () => 0.5, session }).plan.capBps, "an unknown / high-risk route: 1 % whatever the user chose").toBe(100);
    // the journal formats: nothing new in an empty journal; a V2 journal round-trips byte for byte
    expect(Object.keys(emptyJournal()).sort()).toEqual(["chainIndexes", "noteCounter", "notes", "schedule", "swaps", "v"]);
    const v2 = JSON.stringify({ ...emptyJournal(), swaps: [{ orderId: "0x1", attemptId: "0x2", refundCounter: 0, provider: "thorchain", policy: "balanced", request: {}, params: {}, endpoint: "0x3", createdAt: 1, state: "committed" }], activity: [{ id: "swap:0x1", kind: "swap", at: 1, asset: "ETH", decimals: 18, amount: "1", status: "committed", ref: "0x1" }] });
    expect(JSON.stringify(JSON.parse(v2))).toBe(v2);
  });
  it("settings: the protection block heals from a V2 journal and from nonsense", () => {
    expect(healSettings({}).protection).toEqual(DEFAULT_PROTECTION);
    expect(healSettings({ protection: { mode: "nope", capBps: 999, pauseLargeOperations: "yes", notifications: { system: true } } as never }).protection).toEqual({ ...DEFAULT_PROTECTION, notifications: { inApp: true, system: true, generic: true } });
    expect(healProtection({ mode: "max-safety", capBps: 250, autoReroute: true, secondDevice: { enabled: true, credentialId: "abc" } })).toEqual({ mode: "max-safety", capBps: 250, pauseLargeOperations: false, autoReroute: true, notifications: DEFAULT_PROTECTION.notifications, secondDevice: { enabled: true, credentialId: "abc" }, enabled: true, protectFromEnhanced: false });
    expect(healProtection({ capBps: 150 }).capBps, "V4: the fraction may go down to 1 %").toBe(150);
    expect(healProtection({ capBps: 50 }).capBps).toBeUndefined();
    expect(healProtection({ capBps: 600 }).capBps).toBeUndefined();
    expect(PROTECTION_DEFAULTS["max-safety"].capBps, "plan §90 (V4): Maximum Safety is 1 %").toBe(100);
    // V4: the opt-out, the enhanced opt-in, concentration and velocity heal to sane values
    expect(healProtection({ enabled: false, protectFromEnhanced: true, providerShareCapBps: 2500, velocity: { maxUsdPer24h: 500_000 }, introSeenAt: 123 } as never)).toMatchObject({ enabled: false, protectFromEnhanced: true, providerShareCapBps: 2500, velocity: { maxUsdPer24h: 500_000 }, introSeenAt: 123 });
    expect(healProtection({ providerShareCapBps: 500, velocity: { maxUsdPer24h: -1 }, introSeenAt: "x" } as never)).toMatchObject({ enabled: true, protectFromEnhanced: false });
    expect(healProtection({ providerShareCapBps: 500 } as never).providerShareCapBps).toBeUndefined();
    expect(healProtection({ velocity: { maxUsdPer24h: -1 } } as never).velocity).toBeUndefined();
    expect(PROTECTION_DEFAULTS["max-privacy"].sizing).toBe("bucket");
  });
});

describe("the runner: one action per tick (spec §6, §7)", () => {
  it("takes tranche 1 through commit → fund → sign → hand-over, tracks it, settles it at destination final after the Bitcoin margin, then waits for the cadence before tranche 2", async () => {
    const c = await fresh();
    await toInFlight(c);
    let cur = current(c);
    expect(cur.state).toBe("running");
    expect(cur.tranches[0]).toMatchObject({ state: "executing", provider: "thorchain", destination: "bc1qfresh0", jobId: expect.any(String) });
    expect(cur.tranches[0].expected).toMatchObject({ minOut: ((OUT_MIN * eth(50)) / AMOUNT).toString(), etaSeconds: 1400 });
    const child = session.journal().swaps.find((x) => x.orderId === cur.tranches[0].orderId)!;
    expect(child.campaign).toEqual({ id: c.id, index: 0 });
    expect(session.journal().schedule.filter((a) => a.kind === "fund-escrow"), "a tranche is never funded by a fund-escrow action").toHaveLength(0);
    expect(world.calls.filter((x) => x.startsWith("commit:"))).toEqual(["commit:0:thorchain"]);
    expect(world.calls.filter((x) => x.startsWith("fund:"))).toEqual(["fund:0"]);
    // in flight: tracked every tick, nothing else committed (sequential, the first tranche alone); the read reports the hand-over time and the plan's seconds so the service can count a stall (§10)
    let r = await tick(c);
    expect(r?.action.kind).toBe("track");
    expect(world.lastStall).toEqual({ since: Math.floor(cur.tranches[0].handedOverAt! / 1000), expected: 1400 });
    expect(states(c).filter((x) => x !== "planned"), "the tracker says the provider is executing: source final").toEqual(["source-confirmed"]);
    expect(exposure(current(c))).toMatchObject({ inFlight: eth(50), prepared: 0n, completed: 0n, maxLoss: eth(50) });
    world.tracked.set(child.orderId, "DESTINATION_FINAL");
    world.delivered.set(child.orderId, ((OUT * eth(50)) / AMOUNT).toString());
    clock += 15_000;
    r = await tick(c);
    cur = current(c);
    expect(cur.tranches[0].state, "delivered: the finality margin still runs (V4: DESTINATION_CONFIRMED, not merely submitted)").toBe("destination-confirmed");
    expect(cur.tranches[0].deliveredSince).toBe(clock);
    expect(cur.tranches[0].outcome).toMatchObject({ deliveredOut: ((OUT * eth(50)) / AMOUNT).toString(), delivered: eth(50).toString() });
    clock += 3600_000 - 1000;
    await tick(c);
    expect(current(c).tranches[0].state, "one second short of the margin").toBe("destination-confirmed");
    clock += 2000;
    r = await tick(c);
    cur = current(c);
    expect(cur.tranches[0]).toMatchObject({ state: "settled", settledAt: clock });
    expect(exposure(cur)).toMatchObject({ completed: eth(50), inFlight: 0n });
    expect(cur.alerts?.map((a) => a.kind)).toEqual(["step-settled"]);
    // the cadence: a random delay drawn at settlement (rng 0.5 → 600 + 2400 s); the runner waits for it
    expect(cur.tranches[1].notBefore).toBe(clock + 3_000_000);
    expect(r?.action).toMatchObject({ kind: "wait", until: clock + 3_000_000 });
    expect(pendingActions(session).find((a) => a.id === `campaign-tick:${c.id}`)?.dueAt).toBe(clock + 3_000_000);
    clock += 3_000_000;
    r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "commit", index: 1 });
    expect(current(c).tranches[1]).toMatchObject({ state: "committed", destination: "bc1qfresh1" });
    expect(notes).toHaveLength(0);
  });

  it("a funding sent and not yet landed is never sent again, even after Resume; a dead one is replaced once (2026-10-14)", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    world.fundPendingAfterSend = true;
    let r = await tick(c);
    expect(r?.action.kind).toBe("fund");
    expect(current(c).pause).toMatchObject({ reason: "reconcile", trancheIndex: 0 });
    world.fundPendingAfterSend = false;
    // the user resumes at once: the funding may still land, so nothing is sent again and the step pauses once more
    world.fate = "pending";
    resumeCampaign(c.id, session, clock);
    r = await tick(c); expect(r?.action.kind).toBe("requote"); clock += 2000;
    r = await tick(c); expect(r?.action.kind).toBe("fund"); clock += 2000;
    expect(world.calls.filter((x) => x.startsWith("fund:")), "no second withdrawal").toEqual(["fund:0"]);
    expect(current(c)).toMatchObject({ state: "paused", pause: { reason: "reconcile", trancheIndex: 0 } });
    // the funding is dead: the next Resume funds the step once more
    world.fate = "dead";
    resumeCampaign(c.id, session, clock);
    r = await tick(c); expect(r?.action.kind).toBe("requote"); clock += 2000;
    r = await tick(c); expect(r?.action.kind).toBe("fund");
    expect(world.calls.filter((x) => x.startsWith("fund:"))).toEqual(["fund:0", "fund:0"]);
    expect(current(c).tranches[0].state).toBe("funded");
  });

  it("a reload during a step's funding: a dead funding is never replaced on its own; the user's Resume funds the step once (2026-10-14)", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    // the funding was sent and journaled, then the tab reloaded before any answer: the campaign is still running
    const orderId = current(c).tranches[0].orderId!;
    session.update((j) => { const x = j.swaps.find((y) => y.orderId === orderId)!; x.fundingAttempt = { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: clock - 1_000 }; });
    world.fate = "dead";
    let r = await tick(c);
    expect(r?.action.kind).toBe("fund");
    expect(world.calls.filter((x) => x.startsWith("fund:")), "never sent again on its own").toEqual([]);
    expect(current(c)).toMatchObject({ state: "paused", pause: { reason: "reconcile", trancheIndex: 0 } });
    expect(current(c).pause!.detail).toMatch(/never landed; nothing moved\. Resume to fund it again/);
    resumeCampaign(c.id, session, clock);
    r = await tick(c); expect(r?.action.kind).toBe("requote"); clock += 2000;
    r = await tick(c); expect(r?.action.kind).toBe("fund");
    expect(world.calls.filter((x) => x.startsWith("fund:"))).toEqual(["fund:0"]);
    expect(current(c).tranches[0].state).toBe("funded");
  });

  it("THORNode gateways that do not answer at a step's signing: tried again at the next tick, never an unexpected destination (2026-10-14)", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    let r = await tick(c); expect(r?.action.kind).toBe("fund"); clock += 2000;
    world.signThrows = new ProviderCallUnverified("thorchain", "only 1 of 3 THORNode gateways answered for ETH; 2 must agree");
    await expect(tick(c)).rejects.toBeInstanceOf(ProviderCallUnverified);
    expect(current(c).state, "no pause: an outage").toBe("running");
    expect(current(c).pause).toBeUndefined();
    clock += 60_000;
    r = await tick(c); expect(r?.action.kind).toBe("sign");
    expect(current(c).tranches[0].state).toBe("signed");
  });

  // 2026-10-14: a step whose window closed was funded anyway, or retried its signature on the scheduler's backoff for good
  it("a step whose order's execution window has closed is never funded (planned again) and, funded, returns through its refund", async () => {
    // every order the scripted world commits ends its execution window at T0 + 600 s + 7200 s
    const END = (Math.floor(T0 / 1000) + 600 + 7200) * 1000;
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    clock = END - 4 * 60_000; // the funding comes four minutes before the window closes
    let r = await tick(c); expect(r?.action.kind).toBe("fund");
    expect(world.calls.filter((x) => x.startsWith("fund:")), "nothing sent").toEqual([]);
    expect(current(c).tranches[0].state).toBe("planned");
    expect(current(c).tranches[0].orderId, "its order abandoned").toBeUndefined();
    expect(JSON.stringify(current(c).tranches[0].history)).toContain("execution window closed before it was funded");
    // a second campaign whose first step is funded, then signed only after its window
    clock = T0; world = new World(session, () => clock);
    const d = await fresh();
    await tick(d); clock += 2000; // commit
    r = await tick(d); expect(r?.action.kind).toBe("fund"); clock += 2000;
    clock = END + 60_000;
    r = await tick(d); expect(r?.action.kind).toBe("sign");
    expect(world.calls.filter((x) => x.startsWith("sign:")), "no signature that cannot execute").toEqual([]);
    expect(world.calls.filter((x) => x.startsWith("refund:"))).toEqual(["refund:0"]);
    expect(current(d).tranches[0].state).toBe("refunding");
    expect(JSON.stringify(current(d).tranches[0].history)).toContain("its execution window closed before it was signed: the funded step returns through its refund and is planned again");
  });

  it("a step whose order an older build committed under the privacy address's owner commitment is never funded: abandoned and planned again (audit c18)", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    const first = current(c).tranches[0].orderId!;
    world.fundThrows = new OrderOutdated();
    const r = await tick(c); expect(r?.action.kind).toBe("fund");
    expect(world.calls.filter((x) => x.startsWith("fund:")), "asked once; nothing was sent").toEqual(["fund:0"]);
    expect(current(c).tranches[0].state).toBe("planned");
    expect(current(c).tranches[0].orderId, "its order abandoned").toBeUndefined();
    expect(session.journal().swaps.find((x) => x.orderId === first)!.state).toBe("abandoned");
    expect(JSON.stringify(current(c).tranches[0].history)).toContain("set up by an older version of the wallet");
    expect(current(c).state, "no pause: the step is committed again under its own owner commitments").toBe("running");
  });

  it("never funds or hands over twice: an unknown outcome pauses with reconcile and the next tick continues from the facts", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    world.fundThrowsAfterSend = true;
    let r = await tick(c);
    expect(r?.action.kind).toBe("fund");
    let cur = current(c);
    expect(cur.state).toBe("paused");
    expect(cur.pause).toMatchObject({ reason: "reconcile", trancheIndex: 0 });
    expect(cur.tranches[0].state).toBe("committed");
    expect(notes.map((n) => n.kind)).toEqual(["paused"]);
    world.fundThrowsAfterSend = false;
    // paused: every open step is reconciled and tracked, nothing is funded — the escrow holds the amount, so the tranche is funded from that fact alone
    clock += 60_000;
    r = await tick(c);
    expect(r?.action.kind).toBe("wait");
    expect(world.calls.filter((x) => x.startsWith("fund:")), "no second withdrawal").toEqual(["fund:0"]);
    expect(current(c).tranches[0].state).toBe("funded");
    expect(current(c).tranches[0].history.some((h) => /reconciled from the escrow/.test(h.note ?? ""))).toBe(true);
    // resume → reassess → requote (the same provider) → running → the next step is the signature
    resumeCampaign(c.id, session, clock);
    r = await tick(c); expect(r?.action.kind).toBe("requote"); clock += 2000;
    expect(current(c).state).toBe("running");
    r = await tick(c); expect(r?.action.kind).toBe("sign"); clock += 2000;
    expect(world.calls.filter((x) => x.startsWith("fund:"))).toEqual(["fund:0"]);
    world.handOverThrows = true;
    r = await tick(c);
    expect(r?.action.kind).toBe("hand-over");
    cur = current(c);
    expect(cur.state).toBe("paused");
    expect(cur.pause?.reason).toBe("reconcile");
    world.handOverThrows = false;
    resumeCampaign(c.id, session, clock);
    clock += 2000;
    r = await tick(c); // reassess: the executor's job is found first (the tranche is executing, then tracked to source final), then the requote
    cur = current(c);
    expect(cur.tranches[0].state).toBe("source-confirmed");
    expect(world.calls.filter((x) => x.startsWith("handover:")), "no second hand-over").toEqual(["handover:0"]);
    expect(cur.tranches[0].history.map((h) => h.note).some((n) => /reconciled from the executor/.test(n ?? ""))).toBe(true);
  });

  it("a step whose signed call came too close to its deadline before the hand-over is signed afresh, never paused (audit round 2, r02)", async () => {
    const c = await fresh();
    for (const expected of ["commit", "fund", "sign"]) { const r = await tick(c); expect(r?.action.kind, expected).toBe(expected); clock += 2000; }
    world.handOverRefusal = Object.assign(new Error("relayer: the call's deadline is less than 36 s away (deadline_too_close)"), { code: "deadline_too_close" });
    let r = await tick(c);
    expect(r?.action.kind).toBe("hand-over");
    expect(current(c).state, "no pause for the user").toBe("running");
    expect(current(c).tranches[0].state).toBe("funded");
    clock += 2000;
    r = await tick(c); expect(r?.action.kind).toBe("sign"); clock += 2000;
    r = await tick(c); expect(r?.action.kind).toBe("hand-over");
    expect(current(c).tranches[0].state).toBe("executing");
    expect(world.calls.filter((x) => x.startsWith("sign:")), "a fresh call").toEqual(["sign:0", "sign:0"]);
    expect(world.calls.filter((x) => x.startsWith("fund:")), "never funded twice").toEqual(["fund:0"]);
  });

  it("pauses on an open breaker, on the global switch and on a price deviation; alerts are journaled and notified", async () => {
    const c = await fresh();
    world.breakerOpen = true;
    let r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "pause", reason: "provider-error" });
    expect(current(c).alerts?.at(-1)).toMatchObject({ kind: "provider-degraded" });
    expect(notes.at(-1)).toMatchObject({ kind: "provider-degraded", title: "Protected swap paused" });
    expect(world.calls.filter((x) => x.startsWith("commit:"))).toHaveLength(0);
    world.breakerOpen = false;
    const d = await fresh();
    settings.set({ protection: { ...settings.get().protection, pauseLargeOperations: true } });
    r = await tick(d);
    expect(r?.action).toMatchObject({ kind: "pause", reason: "wallet-pause" });
    settings.set({ protection: { ...settings.get().protection, pauseLargeOperations: false } });
    r = await tick(d);
    expect(r?.action.kind, "the switch off: the campaign stays paused until resumed").toBe("wait");
    resumeCampaign(d.id, session, clock);
    world.crossRate = (BigInt(d.referenceRateE18) * 98n) / 100n; // the market moved 2 % against the operation
    r = await tick(d);
    expect(r?.action).toMatchObject({ kind: "pause", reason: "price-deviation" });
    expect(current(d).alerts?.at(-1)).toMatchObject({ kind: "price-changed" });
    world.crossRate = null;
    // a hard quote below the approved minimum at signing is a campaign-level pause, never a per-tranche tap
    const e = await fresh();
    await tick(e); clock += 2000; await tick(e); clock += 2000;
    world.moved = true;
    r = await tick(e);
    expect(r?.action.kind).toBe("sign");
    expect(current(e).pause).toMatchObject({ reason: "price-deviation", trancheIndex: 0 });
    expect(current(e).tranches[0].state).toBe("funded");
    world.moved = false;
  });

  it("V4 (plan §110): a failed settlement read keeps the step where it is and marks it unknown / reconnecting; the next successful read clears the mark", async () => {
    const c = await fresh();
    await toInFlight(c);
    world.trackThrows = true;
    let r = await tick(c);
    expect(r?.action.kind).toBe("track");
    expect(current(c).tranches[0]).toMatchObject({ state: "executing", lastReadFailedAt: clock });
    expect(exposure(current(c)).inFlight, "unknown stays in flight (I3)").toBe(eth(50));
    clock += 15_000;
    await tick(c);
    expect(current(c).tranches[0].lastReadFailedAt, "the first failure's time is kept").toBe(clock - 15_000);
    world.trackThrows = false;
    clock += 15_000;
    await tick(c);
    expect(current(c).tranches[0].lastReadFailedAt).toBeUndefined();
    expect(current(c).tranches[0].state).toBe("source-confirmed");
    expect(world.calls.filter((x) => x.startsWith("handover:")), "never a second hand-over").toEqual(["handover:0"]);
  });

  it("V4 (plan §111): a funding seen in the escrow and then gone pauses with reconcile naming a possible reorganization; the step is never funded twice", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // commit
    await tick(c); clock += 2000; // fund: the escrow holds the amount
    let r = await tick(c); clock += 2000; // sign: the reconcile pass saw the funding first
    expect(r?.action.kind).toBe("sign");
    expect(current(c).tranches[0]).toMatchObject({ state: "signed", fundedSeenAt: clock - 2000 });
    const orderId = current(c).tranches[0].orderId!;
    world.escrow.set(orderId, 0n); // the quorum no longer sees the funding
    r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "pause", reason: "reconcile", detail: expect.stringMatching(/reorganization/) });
    expect(current(c).state).toBe("paused");
    expect(current(c).tranches[0].state, "the tranche keeps its state and its fundedTx").toBe("signed");
    expect(world.calls.filter((x) => x.startsWith("fund:")), "no second withdrawal").toEqual(["fund:0"]);
    expect(world.calls.filter((x) => x.startsWith("handover:"))).toHaveLength(0);
    // the funding is seen again (the other fork won after all): resume continues without a new send
    world.escrow.set(orderId, eth(50));
    resumeCampaign(c.id, session, clock);
    r = await tick(c);
    expect(r?.action.kind).toBe("requote");
    r = await tick(c);
    expect(r?.action.kind).toBe("hand-over");
    expect(world.calls.filter((x) => x.startsWith("fund:"))).toEqual(["fund:0"]);
  });

  it("V4 (plan §62): a velocity limit below the next step pauses before the hand-over; raising it lets the step through", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; await tick(c); clock += 2000; await tick(c); clock += 2000; // commit, fund, sign
    settings.set({ protection: { ...settings.get().protection, velocity: { maxUsdPer24h: 150_000 } } }); // one $200K piece would exceed it
    let r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "pause", reason: "velocity" });
    expect(world.calls.filter((x) => x.startsWith("handover:"))).toHaveLength(0);
    settings.set({ protection: { ...settings.get().protection, velocity: { maxUsdPer24h: 1_000_000 } } });
    resumeCampaign(c.id, session, clock);
    r = await tick(c); // reassess → requote
    expect(r?.action.kind).toBe("requote");
    r = await tick(c);
    expect(r?.action.kind).toBe("hand-over");
    expect(current(c).tranches[0].state).toBe("executing");
  });

  it("a resume whose fresh competition chose another provider waits for the reroute Review; accepting adopts it, the next tranche is committed there", async () => {
    const c = await fresh();
    pauseCampaign(c.id, session, clock);
    expect(current(c)).toMatchObject({ state: "paused", pause: { reason: "user" } });
    world.chosen = "chainflip";
    resumeCampaign(c.id, session, clock);
    let r = await tick(c);
    expect(r?.action.kind).toBe("requote");
    expect(world.calls.at(-1), "the requote runs at the next step's size").toBe("quote:50");
    let cur = current(c);
    expect(cur.state).toBe("rerouting");
    expect(cur.pendingReroute).toMatchObject({ provider: "chainflip" });
    expect(notes.at(-1)).toMatchObject({ kind: "route-changed", title: "Route changed — review" });
    clock += 2000;
    r = await tick(c);
    expect(r?.action.kind, "waiting for the user: nothing in flight to track").toBe("none");
    acceptReroute(c.id, true, session, clock);
    cur = current(c);
    expect(cur).toMatchObject({ state: "running", provider: "chainflip" });
    clock += cur.tranches[0].notBefore! - clock + 1000;
    r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "commit", index: 0 });
    expect(world.calls.at(-1)).toBe("commit:0:chainflip");
    // below the second-confirmation tier with autoReroute on, the route is adopted without a Review
    const d = startCampaign({ quotes: quoteSet("thorchain", eth(250)), provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: eth(250), tier: "high-value", mode: "balanced", preference: "balanced", policy: "privacy-execution", destination: { kind: "fresh-per-tranche" }, usd: 1_000_000, now: clock, rng: () => 0.5, session });
    settings.set({ protection: { ...settings.get().protection, autoReroute: true } });
    pauseCampaign(d.id, session, clock); resumeCampaign(d.id, session, clock);
    world.chosen = "near-intents";
    r = await tick(d);
    expect(current(d)).toMatchObject({ state: "running", provider: "near-intents" });
    expect(current(d).alerts?.at(-1)).toMatchObject({ kind: "route-changed" });
    // declining a reroute winds the campaign down
    world.chosen = "chainflip";
    const e = await fresh();
    pauseCampaign(e.id, session, clock); resumeCampaign(e.id, session, clock);
    await tick(e);
    acceptReroute(e.id, false, session, clock);
    expect(current(e).state).toBe("winding-down");
    r = await tick(e);
    expect(r?.action.kind).toBe("complete");
    expect(current(e).state).toBe("cancelled");
    expect(current(e).tranches.every((t) => t.state === "skipped" || t.state === "planned")).toBe(true);
  });

  it("the competition at a step's size chose another provider: a Review at institutional (the unfunded order abandoned), adopted below the second-confirmation tier; a funded step of the old provider finishes on its own route (audit gap 44)", async () => {
    const c = await fresh();
    world.sizeChosen = "chainflip";
    let r = await tick(c);
    expect(r?.action.kind).toBe("commit");
    let cur = current(c);
    expect(cur).toMatchObject({ state: "rerouting", pendingReroute: { provider: "chainflip" } });
    expect(cur.tranches[0]).toMatchObject({ state: "planned", orderId: undefined });
    expect(session.journal().swaps.find((x) => x.campaign?.index === 0)?.state, "the order of the other provider was abandoned unfunded").toBe("abandoned");
    expect(notes.at(-1)).toMatchObject({ kind: "route-changed", title: "Route changed — review" });
    acceptReroute(c.id, true, session, clock);
    expect(current(c).provider).toBe("chainflip");
    clock += current(c).tranches[0].notBefore! - clock + 1000;
    r = await tick(c);
    expect(r?.action.kind).toBe("commit");
    expect(current(c).tranches[0]).toMatchObject({ state: "committed", provider: "chainflip" });
    // below the second-confirmation tier with autoReroute on, the step's route is adopted and the order kept
    settings.set({ protection: { ...settings.get().protection, autoReroute: true } });
    const d = startCampaign({ quotes: quoteSet("thorchain", eth(250)), provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: eth(250), tier: "high-value", mode: "balanced", preference: "balanced", policy: "privacy-execution", destination: { kind: "fresh-per-tranche" }, usd: 1_000_000, now: clock, rng: () => 0.5, session });
    r = await tick(d);
    expect(r?.action.kind).toBe("commit");
    expect(current(d)).toMatchObject({ state: "running", provider: "chainflip" });
    expect(current(d).tranches[0]).toMatchObject({ state: "committed", provider: "chainflip" });
    expect(current(d).alerts?.at(-1)).toMatchObject({ kind: "route-changed" });
    settings.set({ protection: { ...settings.get().protection, autoReroute: false } });
    // V6 Stage 13: at the $50K band the protection is automatic — the step's route is adopted with the setting off
    const band = startCampaign({ quotes: quoteSet("thorchain", eth(20)), provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: eth(20), tier: "large-protected", mode: "balanced", preference: "balanced", policy: "balanced", destination: { kind: "fresh-per-tranche" }, usd: 80_000, now: clock, rng: () => 0.5, session });
    r = await tick(band);
    expect(r?.action.kind).toBe("commit");
    expect(current(band)).toMatchObject({ state: "running", provider: "chainflip" });
    expect(current(band).tranches[0]).toMatchObject({ state: "committed", provider: "chainflip" });
    // audit gap 44: a funded step of the old provider after a reroute finishes on the route it was funded on while that
    // route signs it at its approved minimum — no refund, so nothing waits for the escrow's window
    world.sizeChosen = null;
    /** a campaign whose first step is funded with thorchain, then rerouted to chainflip: the next tick is that step's signing */
    const leftBehind = async (): Promise<Campaign> => {
      world.chosen = "thorchain";
      const x = await fresh();
      await tick(x); clock += 2000; await tick(x); clock += 2000; // committed and funded with thorchain
      expect(current(x).tranches[0]).toMatchObject({ state: "funded", provider: "thorchain" });
      pauseCampaign(x.id, session, clock);
      world.chosen = "chainflip"; // the requote at the step's size
      resumeCampaign(x.id, session, clock);
      r = await tick(x);
      expect(r?.action.kind).toBe("requote");
      expect(world.calls.at(-1), "quoted at the next step's size, not the remaining amount").toBe("quote:50");
      acceptReroute(x.id, true, session, clock);
      expect(current(x).provider).toBe("chainflip");
      world.calls.length = 0;
      return x;
    };
    const e = await leftBehind();
    r = await tick(e);
    expect(r?.action.kind).toBe("sign");
    expect(current(e).tranches[0]).toMatchObject({ state: "signed", provider: "thorchain" });
    expect(world.calls.filter((x) => /^(sign|refund):/.test(x)), "signed on its own route, not refunded").toEqual(["sign:0"]);
    clock += 2000;
    r = await tick(e);
    expect(r?.action.kind).toBe("hand-over");
    expect(current(e).tranches[0]).toMatchObject({ state: "executing", provider: "thorchain" });
    expect(world.calls.filter((x) => x.startsWith("refund:")), "the step finished on its own route: no refund").toEqual([]);
    // only when its own route cannot sign it — a lower minimum, the price guard's refusal, an open breaker (not even
    // signed) — does it return through its refund and get planned again
    for (const [why, set, unset, signs] of [
      ["a lower minimum", () => { world.moved = true; }, () => { world.moved = false; }, 1],
      ["the price guard's refusal", () => { world.guardRefuses = true; }, () => { world.guardRefuses = false; }, 1],
      ["an open breaker on its own route", () => { world.brokenProviders.add("thorchain"); }, () => { world.brokenProviders.clear(); }, 0],
    ] as const) {
      const x = await leftBehind();
      set();
      r = await tick(x);
      expect(r?.action.kind, why).toBe("sign");
      cur = current(x);
      expect(cur.tranches[0], why).toMatchObject({ state: "refunding", provider: "thorchain", jobId: expect.any(String) });
      expect(world.calls.filter((y) => y.startsWith("refund:")), why).toEqual(["refund:0"]);
      expect(world.calls.filter((y) => y.startsWith("sign:")), why).toHaveLength(signs);
      unset();
      world.tracked.set(cur.tranches[0].orderId!, "REFUNDED");
      clock += 2000;
      r = await tick(x);
      expect(current(x).tranches[0].state, why).toBe("refunded");
      expect(session.journal().schedule.some((a) => a.id === "discovery:pool" && !a.done), `${why}: the refund note is looked for at once`).toBe(true);
      expect(exposure(current(x)).remaining, why).toBe(eth(2500));
    }
    world.chosen = "thorchain";
  });

  it("the price bound is per unit of what the set was quoted for, and per unit paid to the provider when the set names its tip (the audit round of 2026-10-16, c49/c55)", async () => {
    const tip = AMOUNT / 1000n; // the set is net of a 10 bps tip; each step pays 25 bps of its own (the world's commit)
    const steps = (AMOUNT * 98n) / 100n; // a smaller steps amount: each step's fee note comes off the funding the set quoted
    const input = { quotes: { ...quoteSet(), executorTip: tip.toString() }, provider: "thorchain", from: ETH, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: BTC, amount: steps, quotedAmount: AMOUNT, tier: "institutional" as const, mode: "balanced" as const, preference: "balanced" as const, policy: "privacy-execution" as const, destination: { kind: "fresh-per-tranche" as const }, usd: 10_000_000, confirmations: { secondFactor: T0, secondDevice: T0 }, now: clock, rng: () => 0.5, session, gasPriceWei: "20000000000" };
    const slip = (r: bigint) => (r * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n;
    const built = buildCampaign(input);
    expect(BigInt(built.bounds.minimumOutput), "over the amount the set was asked for (c49)").toBe(slip((OUT_MIN * 10n ** 18n) / AMOUNT));
    expect(BigInt(built.bounds.minimumOutputNet!), "and per unit paid to the provider (c55)").toBe(slip((OUT_MIN * 10n ** 18n) / (AMOUNT - tip)));
    expect(buildCampaign({ ...input, quotes: quoteSet(), quotedAmount: undefined, amount: AMOUNT }).bounds.minimumOutputNet, "a set without its tip: as before").toBeUndefined();
    // a step signs at its own tip's net: the market unmoved, its 25 bps tip is not a price below the bound
    const c = startCampaign(input);
    await tick(c); clock += 2000; await tick(c); clock += 2000; // committed and funded
    const t = current(c).tranches[0];
    const stored = session.journal().swaps.find((x) => x.orderId === t.orderId)!;
    const own = BigInt((stored.params as { executorTip: string }).executorTip);
    const bound = trancheMinimum(current(c).bounds, BigInt(t.amount), own);
    const perEscrowUnit = (BigInt(t.amount) * BigInt(current(c).bounds.minimumOutput)) / 10n ** 18n;
    expect(bound < perEscrowUnit, "the step's own tip aside, its bound is lower than per unit of its escrow").toBe(true);
    world.minOutAtSign = bound; // what its call guarantees: the market where it was
    const r = await tick(c);
    expect(r?.action.kind).toBe("sign");
    expect(current(c).tranches[0].state, "signed, not paused as a price deviation").toBe("signed");
    expect(world.acceptMins.at(-1)).toBe(bound);
    world.minOutAtSign = null;
  });

  it("V3 §3: a step is held to the campaign's price bound (amount × minimumOutput), not its own quote at commit — a 0.1 % dip is signed, one below the bound pauses", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; await tick(c); clock += 2000; // committed and funded
    const t = current(c).tranches[0];
    const stored = session.journal().swaps.find((x) => x.orderId === t.orderId)!;
    const bound = (BigInt(t.amount) * BigInt(current(c).bounds.minimumOutput)) / 10n ** 18n;
    world.minOutAtSign = (BigInt(stored.approvedMin!) * 999n) / 1000n; // the market dipped 0.1 % since the step's commit
    expect(world.minOutAtSign >= bound, "within the 50 bps the user approved").toBe(true);
    let r = await tick(c);
    expect(r?.action.kind).toBe("sign");
    expect(current(c).tranches[0].state, "signed: no pause for a dip inside the bound").toBe("signed");
    expect(world.acceptMins.at(-1)).toBe(bound);
    const d = await fresh();
    await tick(d); clock += 2000; await tick(d); clock += 2000;
    world.minOutAtSign = bound - 1n; // below what the user approved
    r = await tick(d);
    expect(r?.action.kind).toBe("sign");
    expect(current(d)).toMatchObject({ state: "paused", pause: { reason: "price-deviation" } });
    world.minOutAtSign = null;
  });

  it("cancel returns a funded tranche through a refund-only job, skips the rest, and ends when the refund is back; the tick survives a lock", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; await tick(c); clock += 2000; // committed, funded
    expect(current(c).tranches[0].state).toBe("funded");
    // a lock and an unlock: the tick is still scheduled and the campaign is there
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    resetRunnerMemory();
    expect(pendingActions(session).map((a) => a.id)).toEqual([`campaign-tick:${c.id}`]);
    expect(current(c).tranches[0].state).toBe("funded");
    cancelCampaign(c.id, session, clock);
    let cur = current(c);
    expect(cur.state).toBe("winding-down");
    expect(cur.tranches.slice(1).every((t) => t.state === "skipped")).toBe(true);
    let r = await tick(c);
    expect(r?.action.kind).toBe("wind-down");
    expect(world.calls.filter((x) => x.startsWith("refund:"))).toEqual(["refund:0"]);
    cur = current(c);
    expect(cur.tranches[0]).toMatchObject({ state: "refunding", jobId: expect.any(String) });
    clock += 2000;
    r = await tick(c);
    expect(r?.action.kind, "the refund is tracked while the window runs").toBe("track");
    world.tracked.set(cur.tranches[0].orderId!, "REFUNDED");
    clock += 2000;
    r = await tick(c);
    expect(current(c).tranches[0]).toMatchObject({ state: "refunded", outcome: { refunded: eth(50).toString() } });
    expect(r?.action.kind, "nothing open any more: finished in the same tick").toBe("complete");
    cur = current(c);
    expect(cur.state).toBe("cancelled");
    expect(cur.alerts?.map((a) => a.kind)).toEqual(["cancelled", "cancelled"]);
    expect(pendingActions(session).filter((a) => a.kind === "campaign-tick")).toHaveLength(0);
    expect(activityOf(session.journal()).find((x) => x.kind === "campaign")?.status).toBe("cancelled");
    expect(await tick(c)).toBeNull();
  });

  it("V6 Stage 13: returning the rest while a step is committed but never funded gives that order up — only once its escrow reads empty", async () => {
    const c = await fresh();
    await tick(c); // committed, not funded yet
    expect(current(c).tranches[0].state).toBe("committed");
    const orderId = current(c).tranches[0].orderId!;
    cancelCampaign(c.id, session, clock);
    expect(current(c).state).toBe("winding-down");
    // an escrow that cannot be read: nothing is given up, the next tick reads again
    const read = world.escrowBalance.bind(world);
    world.escrowBalance = async () => null as never;
    clock += 2000;
    let r = await tick(c);
    expect(r?.action.kind).toBe("abandon");
    expect(current(c).tranches[0].state).toBe("committed");
    world.escrowBalance = read;
    clock += 2000;
    r = await tick(c);
    expect(r?.action.kind).toBe("abandon");
    expect(current(c).tranches[0]).toMatchObject({ state: "skipped" });
    expect(session.journal().swaps.find((x) => x.orderId === orderId)?.state, "the order is abandoned: nothing left the private balance").toBe("abandoned");
    expect(world.calls.filter((x) => x.startsWith("fund:") || x.startsWith("refund:")), "never funded, nothing to refund").toEqual([]);
    clock += 2000;
    r = await tick(c);
    expect(r?.action.kind).toBe("complete");
    expect(current(c).state).toBe("cancelled");
  });

  it("an answer given while a tick runs is kept, and no money step starts after it (the audit round of 2026-10-16, c36)", async () => {
    const settleTicks = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
    // "Return the rest" while step 1 is being committed
    const c = await fresh();
    let release!: () => void;
    world.gate = new Promise<void>((r) => (release = r));
    const running = tick(c);
    await settleTicks();
    expect(world.calls.filter((x) => x.startsWith("commit:"))).toHaveLength(1);
    cancelCampaign(c.id, session, clock);
    release();
    const r = await running;
    world.gate = null;
    expect(current(c).state, "the tick's own write kept the answer").toBe("winding-down");
    expect(current(c).tranches.filter((t) => t.state === "planned" || t.state === "ready"), "nothing planned is left").toEqual([]);
    expect(r?.nextAt, "acted on at once").toBe(clock);
    // a Pause while a tick reads the facts: the funding it was about to send is not sent
    const d = await fresh();
    await tick(d); clock += 2000; // step 1 committed
    const facts = world.escrowBalance.bind(world);
    world.escrowBalance = async (stored) => { pauseCampaign(d.id, session, clock); return facts(stored); };
    const funds = world.calls.filter((x) => x.startsWith("fund:")).length;
    await tick(d);
    world.escrowBalance = facts;
    expect(world.calls.filter((x) => x.startsWith("fund:")).length, "not funded after the pause").toBe(funds);
    expect(current(d)).toMatchObject({ state: "paused", pause: { reason: "user" } });
  });

  it("a step whose funding is on its way is never given up: not when the rest returns, not when the route changes (the audit round of 2026-10-16, c35)", async () => {
    const c = await fresh();
    await tick(c); clock += 2000; // committed
    world.fundPendingAfterSend = true; // the funding is sent, its answer lost
    await tick(c).catch(() => null);
    world.fundPendingAfterSend = false;
    const orderId = current(c).tranches[0].orderId!;
    expect(session.journal().swaps.find((x) => x.orderId === orderId)?.fundingAttempt, "journaled before it was sent").toBeTruthy();
    cancelCampaign(c.id, session, clock);
    world.fate = "pending";
    clock += 2000;
    await tick(c);
    expect(session.journal().swaps.find((x) => x.orderId === orderId)?.state, "on its way: the order is kept").not.toBe("abandoned");
    expect(current(c).tranches[0].state).not.toBe("skipped");
    // it lands: the escrow holds it, and the step returns through its refund — never lost in an abandoned escrow
    world.fate = "landed";
    world.escrow.set(orderId, BigInt(current(c).tranches[0].amount));
    clock += 2000;
    await tick(c);
    expect(["funded", "refunding"], "funded, then on its way back through its refund").toContain(current(c).tranches[0].state);
    expect(session.journal().swaps.find((x) => x.orderId === orderId)?.state).not.toBe("abandoned");
    world.fate = "unknown";
  });

  it("a step its provider failed at the destination pauses the campaign, and its amount counts until it is back (the audit round of 2026-10-16, c53)", async () => {
    const c = await fresh();
    await toInFlight(c); // step 1 handed over
    const t = current(c).tranches[0];
    world.tracked.set(t.orderId!, "DESTINATION_FAILED");
    clock += 2000;
    await tick(c);
    expect(current(c).tranches[0].state).toBe("refunding");
    expect(current(c)).toMatchObject({ state: "paused", pause: { reason: "provider-error" } });
    expect(exposure(current(c)).inFlight, "still out of the private balance").toBe(BigInt(t.amount));
    const commits = world.calls.filter((x) => x.startsWith("commit:")).length;
    clock += 120_000;
    await tick(c);
    expect(world.calls.filter((x) => x.startsWith("commit:")).length, "the next step is not sent to the same provider").toBe(commits);
    world.tracked.delete(t.orderId!);
  });

  it("a refunded tranche is re-planned; a partial fill pauses, then settles for what was delivered once the rest is back", async () => {
    const c = await fresh();
    await toInFlight(c);
    const first = current(c).tranches[0].orderId!;
    world.tracked.set(first, "PARTIAL");
    world.delivered.set(first, ((OUT * eth(30)) / AMOUNT).toString()); // 30 of 50 ETH worth delivered
    clock += 15_000;
    let r = await tick(c);
    expect(current(c).tranches[0].state).toBe("partial");
    expect(current(c)).toMatchObject({ state: "paused", pause: { reason: "anomaly" } });
    expect(exposure(current(c))).toMatchObject({ completed: eth(30), inFlight: eth(20) });
    // the rest came back (the executor's watch ended): the tranche settles for 30 ETH and 20 ETH return to the remainder
    world.jobs.get(first)!.state = "completed";
    clock += 60_000;
    r = await tick(c);
    const cur = current(c);
    expect(cur.tranches[0]).toMatchObject({ state: "settled", amount: eth(30).toString(), outcome: { refunded: eth(20).toString() } });
    expect(exposure(cur)).toMatchObject({ completed: eth(30), inFlight: 0n, remaining: eth(2470) }); // the planned pieces and the returned 20 ETH
    resumeCampaign(c.id, session, clock);
    r = await tick(c); // requote → running
    clock += 3_000_000 + 1000;
    r = await tick(c);
    expect(r?.action).toMatchObject({ kind: "commit", index: 1 });
    // a delivery the tracker reports with a refund (the rest came back) settles for what was delivered, never as a refund in full
    // (a V6 follow-up of 2026-10-16): the delivered part was re-planned and swapped again
    const e = await fresh();
    await toInFlight(e);
    const partialRefunded = current(e).tranches[0].orderId!;
    world.tracked.set(partialRefunded, "REFUNDED");
    world.delivered.set(partialRefunded, ((OUT * eth(30)) / AMOUNT).toString());
    clock += 15_000;
    await tick(e);
    expect(current(e).tranches[0]).toMatchObject({ state: "settled", amount: eth(30).toString(), outcome: { refunded: eth(20).toString() } });
    expect(exposure(current(e))).toMatchObject({ completed: eth(30), inFlight: 0n });
    // a refund of a whole tranche: the amount returns to the remainder and is planned again at the end
    const d = await fresh();
    await toInFlight(d);
    world.tracked.set(current(d).tranches[0].orderId!, "REFUNDED");
    clock += 15_000;
    await tick(d);
    expect(current(d).tranches[0].state).toBe("refunded");
    expect(exposure(current(d))).toMatchObject({ remaining: eth(2500), completed: 0n });
    clock += 2000;
    r = await tick(d);
    expect(r?.action.kind, "planned tranches remain: the refunded piece is re-planned only once they are used up").not.toBe("replan");
  });
});

describe("the scheduler and a re-scheduled action", () => {
  let root: Root | null = null;
  afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } defaultSession.forget(); });
  it("keeps an action pending when its run scheduled the next tick under the same id", async () => {
    await defaultSession.create("pw");
    defaultSession.acknowledgePhrase();
    const ran: number[] = [];
    scheduleAction({ kind: "campaign-tick", orderId: "0xc", dueAt: Date.now() - 10 }, defaultSession);
    const run = async (a: ScheduledAction) => { ran.push(a.dueAt); if (ran.length < 3) scheduleAction({ kind: "campaign-tick", orderId: "0xc", dueAt: a.dueAt + 1 }, defaultSession); };
    function Runner() { useScheduler(run, 10, defaultSession); return null; }
    const container = document.createElement("div");
    await act(async () => { root = createRoot(container); root.render(<Runner />); });
    await vi.waitFor(() => expect(ran).toHaveLength(3), { timeout: 5_000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(ran, "the third run did not re-schedule: the action is done").toHaveLength(3);
    expect(defaultSession.journal().schedule.find((a) => a.id === "campaign-tick:0xc")?.done).toBe(true);
  });
});
