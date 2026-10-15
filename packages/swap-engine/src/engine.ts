// PrivateSwap engine (spec §2, §6, §8, §9; whale spec §1–§5, §12–§14, §16–§17): quote every capable
// provider, score by policy, build the order (one-time escrow endpoint + refund note), and produce the
// signed execution once the ingress is known. The engine never holds keys for money: the order key is a
// per-order wallet-derived key.
import { randomBytes } from "crypto";
import type { CompetitionEntry, Order, OrderParams, Policy, Preference, ProviderAdapter, ProviderId, Quote, QuoteRequest, Health, Execution, Ingress, Tier } from "./types";
import { CATEGORY_PREFERENCE, categoryOf } from "./types";
import { chooseRoute, policyFor, priceGuard, scoreRoutes, type RouteScore } from "./scoring";
import { privacyScore } from "./privacyScore";
import { isBucketOf } from "@privacy-wallet/protocol/wallet/amounts";
import { atLeast, higherTier, type Assessment, type TierThresholds } from "@privacy-wallet/protocol/wallet/valuation";
import { executionDigest, orderSignerAddress, predictEscrow, recoverExecutionSigner, signExecution } from "./endpoints";
import { encodeCall } from "./abi";
import { NO_VALUER, assessRequest, type Valuer } from "./valuation";
import { ProviderHealthTracker } from "./health";
import { placeholderDestination } from "./placeholders";
import { protectionFor, type Protection, type ProviderRisk } from "./risk/protection";
import { normalizeQuote } from "./normalize";
import type { ProtectionMode } from "@privacy-wallet/protocol/wallet/campaign";
import { SHIELD_TIP_DIVISOR, type TipSource } from "./tips";

export interface EngineConfig {
  adapters: ProviderAdapter[];
  factory: string; // SwapOrderFactory address
  escrowCreationCode: string; // from contracts/abi/periphery/SwapOrderEscrow.json
  chainId: bigint;
  refundVaults: Record<string, string>; // asset ("native" or token address) -> canonical vault
  /** V6 (Privacy Wallet Web spec v2.0 §3): the executor tip — the execution's gas in the order's asset (./tips.ts gasTips), never a percentage */
  tips: TipSource;
  refundWindowSeconds: number; // refundAfter = executeDeadline + this
  /** cover traffic per provider (swaps/hour on a typical pair): it counts only for a provider that keeps the escrow → destination link private (spec §10) */
  providerThroughput?: Partial<Record<ProviderId, number>>;
  /** whale spec §13: the price source for the value tiers (RPC_URLS); without one every order is at least high-value */
  valuer?: Valuer;
  /** the service's tier thresholds (the defaults; a wallet can only raise the tier) */
  tierThresholds?: TierThresholds;
  /** whale spec §16: the failure history, breaker and health cache (one per service) */
  healthTracker?: ProviderHealthTracker;
  /** the time budget per adapter in a competition (whale spec §3): its health check and its quote together */
  quoteTimeoutMs?: number;
}

/** Static estimates (docs/privacy-lab.md, cross-chain section); they matter only for a provider that keeps the escrow → destination link private, and no adapter does today. */
export const DEFAULT_PROVIDER_THROUGHPUT: Record<ProviderId, number> = { thorchain: 60, chainflip: 30, mayan: 60, "near-intents": 40, lifi: 100, "uniswap-across": 100 };
export const QUOTE_TIMEOUT_MS = 25_000;

export interface PreparedExecution {
  quote: Quote;
  ingress: Ingress;
  provider: string;
  value: bigint;
  calldata: `0x${string}`;
  deadline: number;
  digest: `0x${string}`;
}

export interface QuoteSet {
  /** per quoted provider: is the escrow → destination link public, and where (shown under "View route") */
  links: Partial<Record<ProviderId, { public: boolean; evidence: string }>>;
  quotes: Quote[];
  errors: Partial<Record<ProviderId, string>>;
  health: Record<ProviderId, Health>;
  scores: RouteScore[];
  chosen?: RouteScore;
  /** whale spec §1, §13: the service's valuation of the gross amount and the tier that applies (the higher of the wallet's hint and the service's own) */
  value?: Assessment["value"];
  tier?: Tier;
  /** the policy the routes were scored under (given, or derived from the preference and the tier) */
  policy: Policy;
  /** V6 (spec v2.0 §3): the executor tip every quote here is net of (the wallet's "Relayer/network" line adds it) */
  executorTip: bigint;
  /** V6 Stage 12 (spec v2.0 §11.2): a protected destination's shield tip, in the output asset (the receiver's parameters commit it) */
  shieldTip?: bigint;
  /** whale spec §2: every capable provider and what it answered */
  competition: CompetitionEntry[];
  /** High-Value Protection spec §10: the recommendation for the chosen route and the risk view of every provider that quoted, from the enhanced tier (advice: the wallet keeps its own accounting) */
  protection?: Protection;
  risk?: Partial<Record<ProviderId, ProviderRisk>>;
}

export const DELAY_BUDGET: Record<Policy, [number, number]> = {
  "best-privacy": [6 * 3600, 72 * 3600],
  "best-price": [3600, 24 * 3600],
  fastest: [0, 0],
  balanced: [3600, 24 * 3600],
  "privacy-execution": [3600, 24 * 3600],
  "best-execution": [3600, 24 * 3600],
  "high-privacy": [6 * 3600, 72 * 3600],
};

/** V6 Stage 12 (spec v2.0 §12): `destinationType: "protected"` asks for what this deployment cannot shield — another
 *  chain's output, or an asset without a canonical vault in the pool. */
export class ProtectedDestinationError extends Error {
  readonly code = "destination_not_protectable";
}

/** The hard quote guarantees less than the user approved at commit (whale spec §3, §14): the wallet asks for consent. */
export class MinimumMovedError extends Error {
  constructor(readonly approvedMin: bigint, readonly newMin: bigint) {
    super(`the route now guarantees at least ${newMin}, below the ${approvedMin} approved at commit`);
  }
}
/**
 * A provider failed, or answered something this engine will not build on (whale spec §16). The API answers it as a
 * gateway's error (502 `provider_unavailable`) and logs the provider, never as an internal error; the wallet tries again.
 */
export class ProviderFailure extends Error {
  constructor(readonly provider: ProviderId, message: string) {
    super(message);
  }
}
/** What a provider's call threw, as that provider's failure. */
export const asProviderFailure = (provider: ProviderId, e: unknown): ProviderFailure =>
  e instanceof ProviderFailure ? e : new ProviderFailure(provider, String((e as Error)?.message ?? e));
class QuoteTimeout extends Error {}
/** `p` within `ms`; the message names the whole `budgetMs` when `ms` is what is left of it. */
const withTimeout = <T>(p: Promise<T>, ms: number, what: string, budgetMs = ms): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new QuoteTimeout(`${what}: no answer within ${Math.round(budgetMs / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
/** A provider that answered "no" for this request (a 4xx with a reason, a refusal of the size or the route) is not an outage: the breaker ignores it. */
const isRefusal = (msg: string) => /HTTP 4\d\d|refused|not supported|does not (support|list|serve)|insufficient|too low|too high|not offered|cannot|no (dry-quote|quote|liquidity|route|available)|unexpected|mismatch|placeholder|not implemented|only|limit/i.test(msg);

export interface QuoteHint {
  tier?: Tier; preference?: Preference; preferNative?: boolean;
  /** High-Value Protection spec §14: the protection mode the recommendation is computed under (balanced when absent) */
  mode?: ProtectionMode;
  /** High-Value Protection spec §3: the per-tranche execution window; buildOrder clamps it into the policy's delay budget */
  executeWindowSeconds?: number;
}
/** The shortest execution window a wallet can ask for: a quote refreshed at submission still needs a relayer tick (High-Value Protection spec §3). */
export const EXECUTE_WINDOW_MIN_SECONDS = 600;
/** executeDeadline − quote expiry: the policy's maximum delay (V2), or the wallet's shorter window clamped into [EXECUTE_WINDOW_MIN_SECONDS, that maximum]. */
export function executeWindowFor(policy: Policy, executeWindowSeconds?: number): number {
  const dMax = DELAY_BUDGET[policy][1];
  if (executeWindowSeconds === undefined || !Number.isFinite(executeWindowSeconds)) return dMax;
  return Math.max(Math.min(EXECUTE_WINDOW_MIN_SECONDS, dMax), Math.min(Math.floor(executeWindowSeconds), dMax));
}

/**
 * The one call the escrow makes for an ingress (spec §5, §6). The escrow forwards what is left after the
 * executor tip: an ETH order sends it as value (a plain deposit address gets a bare transfer); an ERC-20
 * order forwards no ETH — a contract-call provider pulls the tokens it was approved for, and a plain
 * deposit address is paid with the token's own `transfer(depositAddress, amount − tip)`, so the
 * provider call the order key signs is the token contract itself.
 */
export function escrowCall(p: OrderParams, ingress: Ingress): { provider: string; value: bigint; calldata: `0x${string}` } {
  const net = p.amount - p.executorTip;
  const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (p.assetType === 1) {
    if (ingress.value !== 0n) throw new Error("an ERC-20 order forwards no ETH value");
    if (ingress.kind === "plain-address") {
      if (!isAddress(ingress.to) || !isAddress(p.asset)) throw new Error("an ERC-20 deposit needs an EVM deposit address and token");
      return { provider: p.asset, value: 0n, calldata: encodeCall("transfer(address,uint256)", [{ t: "address", v: ingress.to }, { t: "uint", v: net }]) };
    }
    return { provider: ingress.to, value: 0n, calldata: ingress.calldata };
  }
  if (ingress.kind === "plain-address") return { provider: ingress.to, value: net, calldata: "0x" };
  if (ingress.value > net) throw new Error("ingress value exceeds the escrow's spendable balance");
  return { provider: ingress.to, value: ingress.value, calldata: ingress.calldata };
}

export class PrivateSwapEngine {
  readonly tracker: ProviderHealthTracker;
  constructor(readonly cfg: EngineConfig) {
    this.tracker = cfg.healthTracker ?? new ProviderHealthTracker();
  }

  /** The executor tip comes out of the escrow balance, so providers are quoted for the net amount. */
  net(req: QuoteRequest, executorTip: bigint): QuoteRequest {
    return { ...req, amount: req.amount - executorTip };
  }

  /** The gross amount's USD value and tier by the service's own read (whale spec §13); a wallet's hint can only raise the tier. */
  async assess(gross: QuoteRequest, hint?: Tier): Promise<Assessment> {
    const a = await assessRequest(this.cfg.valuer ?? NO_VALUER, gross.from, gross.amount, this.cfg.tierThresholds);
    return hint ? { ...a, tier: higherTier(a.tier, hint) } : a;
  }

  /** A provider's health, from the tracker's cache when fresh (whale spec §16). */
  private async healthOf(a: ProviderAdapter, now: number): Promise<Health> {
    const cached = this.tracker.cachedHealth(a.id, now);
    if (cached) return cached;
    const h = await a.health();
    return this.tracker.rememberHealth(a.id, h, now);
  }

  /**
   * `healthOf` within `ms`. A check that does not answer in time reads unreachable (`timedOut`), and its late answer is
   * still cached. THORChain's check walks its gateways in turn, at 20 s each: unbounded, one slow provider held up every
   * competition, every commit and every status read (the local stack's quick pass of 2026-10-14: a commit stalled two
   * minutes).
   */
  private async healthWithin(a: ProviderAdapter, now: number, ms: number): Promise<{ health: Health; timedOut: boolean }> {
    const t0 = Date.now();
    try {
      return { health: await withTimeout(this.healthOf(a, now), ms, a.id), timedOut: false };
    } catch (e) {
      const note = String((e as Error)?.message ?? e);
      return { health: { provider: a.id, reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: now, note }, timedOut: e instanceof QuoteTimeout };
    }
  }

  /** Every provider's health for a status view (GET /v1/status): from the cache, each check within the competition's budget. */
  async healthAll(now = Date.now()): Promise<Record<ProviderId, Health>> {
    const budget = this.cfg.quoteTimeoutMs ?? QUOTE_TIMEOUT_MS;
    const all = await Promise.all(this.cfg.adapters.map(async (a) => [a.id, (await this.healthWithin(a, now, budget)).health] as const));
    return Object.fromEntries(all) as Record<ProviderId, Health>;
  }

  /**
   * Quote all capable providers in parallel; failures are recorded, never fatal (plan §57). V2 (whale spec
   * §2–§5): the policy may be derived from a preference and the tier; phase-1 quotes carry a placeholder
   * destination; every provider gets a time budget; the competition record says what each answered.
   */
  async quoteAll(gross: QuoteRequest, policyOrPreference: Policy | { preference: Preference }, hint: QuoteHint = {}): Promise<QuoteSet> {
    const assessment = await this.assess(gross, hint.tier);
    const tier = assessment.tier;
    const preference = typeof policyOrPreference === "string" ? hint.preference : policyOrPreference.preference;
    const policy: Policy = typeof policyOrPreference === "string" ? policyOrPreference : policyFor(policyOrPreference.preference, tier, hint.mode);
    const preferNative = hint.preferNative ?? preference === "native";
    // V6 Stage 12 (spec v2.0 §11.2): into the protected balance only on the pool's own chain, only for an asset with a canonical vault
    const sameChain = gross.from.chain === gross.to.chain;
    const protectedDestination = gross.destinationType === "protected";
    if (protectedDestination) {
      if (!sameChain) throw new ProtectedDestinationError(`only a swap on ${gross.from.chain} itself delivers into the protected balance, not one to ${gross.to.chain}`);
      if (!this.cfg.refundVaults[gross.to.asset]) throw new ProtectedDestinationError(`the pool has no canonical vault for ${gross.to.symbol}: it cannot be received into the protected balance`);
      if (!this.cfg.tips.shieldTipFor) throw new ProtectedDestinationError("this service cannot price a shield tip");
    }
    // V6 (spec v2.0 §3): the execution's gas at today's fees, in the order's asset; refused when the escrow could not pay it
    const executorTip = await this.cfg.tips.tipFor(gross.from, gross.amount);
    const shieldTip = protectedDestination ? await this.cfg.tips.shieldTipFor!(gross.to) : undefined;
    const req = this.net(gross, executorTip);
    // phase 1: the fresh destination goes only to the chosen provider at prepare (whale spec §5)
    const indicative: QuoteRequest = { ...req, destination: req.source ? req.destination : (placeholderDestination(req.to.chain) ?? req.destination), tier, plan: req.plan ?? (atLeast(tier, "enhanced") ? "stream" : undefined), preferNative };
    const category = categoryOf(req.from, req.to);
    const capable = this.cfg.adapters.filter((a) => a.capabilities().routes.includes(category) && a.capabilities().chains.includes(req.from.chain) && a.capabilities().chains.includes(req.to.chain) && (!sameChain || a.capabilities().sameChain === true));
    const ordered = [...capable].sort((a, b) => CATEGORY_PREFERENCE[category].indexOf(a.id) - CATEGORY_PREFERENCE[category].indexOf(b.id));
    const now = Date.now();
    const budget = this.cfg.quoteTimeoutMs ?? QUOTE_TIMEOUT_MS;
    const competition: CompetitionEntry[] = [];
    const skipped: Partial<Record<ProviderId, string>> = {};
    const results = await Promise.all(ordered.map(async (a) => {
      const t0 = Date.now();
      // the budget covers the provider's health check and its quote together: the competition never waits longer for one provider (§16)
      const { health, timedOut } = await this.healthWithin(a, now, budget);
      const open = this.tracker.breakerOpen(a.id, now);
      if (open) { skipped[a.id] = open; competition.push({ provider: a.id, outcome: "skipped", reason: open, ms: 0 }); return { id: a.id, health, quote: undefined, error: open }; }
      if (!a.implemented) { competition.push({ provider: a.id, outcome: "refused", reason: "not implemented", ms: 0 }); return { id: a.id, health, quote: undefined, error: "not implemented" }; }
      if (timedOut) {
        this.tracker.recordFailure(a.id, Date.now()); // a timeout, like a quote's: outage-like
        competition.push({ provider: a.id, outcome: "timeout", reason: health.note, ms: Date.now() - t0 });
        return { id: a.id, health, quote: undefined, error: health.note };
      }
      if (!health.reachable) { competition.push({ provider: a.id, outcome: "halted", reason: health.note ?? "unreachable", ms: Date.now() - t0 }); return { id: a.id, health, quote: undefined, error: health.note ?? "provider unreachable" }; }
      try {
        const quote = await withTimeout(a.quote(indicative), Math.max(1, budget - (Date.now() - t0)), a.id, budget);
        this.tracker.recordSuccess(a.id);
        competition.push({ provider: a.id, outcome: "quoted", ms: Date.now() - t0, plan: quote.plan });
        return { id: a.id, health, quote, error: undefined };
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const timeout = e instanceof QuoteTimeout;
        if (timeout || !isRefusal(msg)) this.tracker.recordFailure(a.id, Date.now());
        competition.push({ provider: a.id, outcome: timeout ? "timeout" : "refused", reason: msg, ms: Date.now() - t0 });
        return { id: a.id, health, quote: undefined, error: msg };
      }
    }));
    const quotes = results.flatMap((r) => (r.quote ? [{ ...r.quote, executorTip, ...(shieldTip !== undefined ? { shieldTip } : {}) }] : []));
    const health = Object.fromEntries(results.map((r) => [r.id, r.health])) as Record<ProviderId, Health>;
    const errors = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.id, r.error])) as Partial<Record<ProviderId, string>>;
    const unexecutable = Object.fromEntries(ordered.filter((a) => a.capabilities().contractSender === false).map((a) => [a.id, "ingress from a contract sender unconfirmed by the provider"])) as Partial<Record<ProviderId, string>>;
    const filteredBy: Partial<Record<ProviderId, string>> = {};
    if (preferNative && quotes.some((q) => q.nativeAssets)) for (const q of quotes) if (!q.nativeAssets) filteredBy[q.provider] = "a wrapped or bridged leg (a native route quoted; preference: native assets)";
    // a receiver pays its tip only from a delivery of at least a hundred tips (its 1 % rule): a smaller minimum cannot be shielded
    if (shieldTip !== undefined) for (const q of quotes) if (q.toAmountMin < shieldTip * SHIELD_TIP_DIVISOR) filteredBy[q.provider] = `the minimum output cannot pay the shield's gas (${shieldTip} of ${req.to.symbol}'s base units) within 1 %`;
    const scores = scoreRoutes(quotes, health, policy, now, unexecutable, { tier, amount: req.amount, chains: [req.from.chain, req.to.chain], skipped, filteredBy });
    for (const s of scores) if (s.filtered) { const c = competition.find((x) => x.provider === s.provider && x.outcome === "quoted"); if (c) { c.outcome = "filtered"; c.reason = s.filtered; } }
    const links = Object.fromEntries(ordered.map((a) => [a.id, { public: a.capabilities().destinationLinkPublic, evidence: a.capabilities().linkEvidence }])) as QuoteSet["links"];
    // V4 (contract §3.2): every quoted or filtered line in the common shape, risk and privacy included
    for (const c of competition) {
      if (c.outcome !== "quoted" && c.outcome !== "filtered") continue;
      const quote = quotes.find((x) => x.provider === c.provider), s = scores.find((x) => x.provider === c.provider);
      if (quote && s) c.normalized = normalizeQuote(quote, { req: gross, score: s, health: health[c.provider], breakerOpen: !!skipped[c.provider], linkPublic: this.linkPublic(c.provider), now });
    }
    const set: QuoteSet = { quotes, errors, health, scores, chosen: chooseRoute(scores), links, value: assessment.value, tier, policy, competition, executorTip, ...(shieldTip !== undefined ? { shieldTip } : {}) };
    // V3 (High-Value Protection spec §10): the recommendation rides on the competition from the enhanced tier; the USD per source unit comes from the same valuation as the tier
    const units = Number(gross.amount) / 10 ** gross.from.decimals;
    const usdPerUnit = "usd" in assessment.value && units > 0 ? assessment.value.usd / units : null;
    return { ...set, ...protectionFor(set, gross, gross.amount, tier, hint.mode ?? "balanced", usdPerUnit, this.tracker) };
  }

  /** Whether this provider publishes the escrow → destination link; an unknown provider counts as public (no credit for cover traffic). */
  linkPublic(provider: ProviderId): boolean {
    return this.cfg.adapters.find((a) => a.id === provider)?.capabilities().destinationLinkPublic ?? true;
  }

  private privacyOf(req: QuoteRequest, policy: Policy, quote: Quote, amount: bigint, dMin: number): number {
    return privacyScore({
      sourceIsPool: true, destinationFresh: req.destinationKind !== "entered", amountIsBucket: isBucketOf(amount, req.from.decimals), amountUniqueness: 0.5, delaySeconds: dMin,
      providerKind: quote.provider === "thorchain" || quote.provider === "chainflip" || quote.provider === "near-intents" ? "deposit-address" : quote.provider === "mayan" ? "signed-intent" : "aggregator-api",
      nativeAssets: quote.nativeAssets, oneTimeEndpoints: true, privateSubmission: policy !== "fastest",
      crossChain: { throughputPerHour: this.cfg.providerThroughput?.[quote.provider] ?? DEFAULT_PROVIDER_THROUGHPUT[quote.provider], etaSeconds: quote.etaSeconds, linkPublic: this.linkPublic(quote.provider) },
    });
  }

  /** Build the order object + on-chain params for a chosen quote (spec §2, §6); `assessment` (whale spec §1) is the value / tier recorded with it. */
  buildOrder(req: QuoteRequest, policy: Policy, quote: Quote, keys: { orderPrivateKey?: Uint8Array; orderSigner?: string; refundOwnerCommitment: bigint; refundNoteSecret: bigint; refundNoteDataHash: `0x${string}` }, assessment?: Assessment, preference?: Preference, opts: { executeWindowSeconds?: number } = {}): Order {
    const orderSigner = keys.orderSigner ?? (keys.orderPrivateKey ? orderSignerAddress(keys.orderPrivateKey) : undefined);
    if (!orderSigner) throw new Error("buildOrder needs the one-time order signer (address) or its key");
    const orderId = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
    const amount = req.amount; // gross: what the private withdrawal funds
    const executorTip = quote.executorTip; // the tip the quote is net of (quoteAll)
    if (executorTip === undefined) throw new Error("buildOrder: the quote names no executor tip (quote through quoteAll)");
    const [dMin, dMax] = DELAY_BUDGET[policy];
    const executeDeadline = quote.expiresAt + executeWindowFor(policy, opts.executeWindowSeconds); // the quote is refreshed at submission: the policy's budget, or a campaign tranche's short window (V3 §3)
    const params: OrderParams = {
      orderId, assetType: req.from.asset === "native" ? 0 : 1, asset: req.from.asset === "native" ? "0x0000000000000000000000000000000000000000" : req.from.asset,
      amount, orderSigner, executeDeadline, refundAfter: executeDeadline + this.cfg.refundWindowSeconds,
      refundVault: this.cfg.refundVaults[req.from.asset], refundOwnerCommitment: keys.refundOwnerCommitment, refundNoteSecret: keys.refundNoteSecret,
      refundNoteDataHash: keys.refundNoteDataHash, executorTip,
    };
    if (!params.refundVault) throw new Error(`no canonical vault configured for ${req.from.asset}`);
    const endpoint = predictEscrow(this.cfg.factory, this.cfg.escrowCreationCode, params);
    const score = this.privacyOf(req, policy, quote, amount, dMin);
    return {
      orderId, request: req, policy, ...(preference ? { preference } : {}), quote, ingress: { kind: "contract-call", to: "", calldata: "0x", value: 0n, expiresAt: quote.expiresAt, minOutEncoded: quote.minOutEncoded },
      params, endpoint, privacy: { delaySeconds: [dMin, dMax], amountNormalized: isBucketOf(amount, req.from.decimals), score, destinationLinkPublic: this.linkPublic(quote.provider) },
      ...(assessment ? { value: assessment.value, tier: assessment.tier } : {}),
      destination: { chain: req.to.chain, asset: req.to.asset, address: req.destination, kind: req.destinationKind ?? "fresh" },
      ...(quote.plan ? { plan: quote.plan } : {}),
      state: "QUOTED", history: [{ state: "QUOTED", at: Date.now() }],
    };
  }

  /**
   * Rebuild an order the wallet persisted (spec §3 recovery, plan §30): the same on-chain params give
   * the same escrow, so a wallet that funded its escrow hours ago can prepare / sign after a service
   * restart. `quote` is a fresh quote from the same provider (it is re-quoted again at prepare time).
   */
  restoreOrder(req: QuoteRequest, policy: Policy, quote: Quote, params: OrderParams, assessment?: Assessment, preference?: Preference): Order {
    if (!/^0x[0-9a-fA-F]{40}$/.test(params.orderSigner)) throw new Error("restoreOrder: params.orderSigner is not an address");
    if (params.executeDeadline >= params.refundAfter) throw new Error("restoreOrder: executeDeadline must precede refundAfter");
    const endpoint = predictEscrow(this.cfg.factory, this.cfg.escrowCreationCode, params);
    const [dMin, dMax] = DELAY_BUDGET[policy];
    const score = this.privacyOf(req, policy, quote, params.amount, dMin);
    return {
      orderId: params.orderId, request: req, policy, ...(preference ? { preference } : {}), quote, ingress: { kind: "contract-call", to: "", calldata: "0x", value: 0n, expiresAt: quote.expiresAt, minOutEncoded: quote.minOutEncoded },
      params, endpoint, privacy: { delaySeconds: [dMin, dMax], amountNormalized: isBucketOf(params.amount, req.from.decimals), score, destinationLinkPublic: this.linkPublic(quote.provider) },
      ...(assessment ? { value: assessment.value, tier: assessment.tier } : {}),
      destination: { chain: req.to.chain, asset: req.to.asset, address: req.destination, kind: req.destinationKind ?? "fresh" },
      ...(quote.plan ? { plan: quote.plan } : {}),
      state: "COMMITTED", history: [{ state: "COMMITTED", at: Date.now(), note: "restored by the wallet" }],
    };
  }

  /**
   * Once the escrow address is known (phase 3, whale spec §3): re-quote with the escrow as sender and the
   * order's plan, obtain the final ingress and the digest the order key must sign. The hard quote must
   * keep the minimum approved at commit (else MinimumMovedError) and pass the price guard against live
   * alternatives when given (spec §5, whale spec §14).
   */
  async prepareExecution(order: Order, adapter: ProviderAdapter, guard?: { alternatives: Quote[]; maxGapBps: number }, approvedMin?: bigint): Promise<PreparedExecution> {
    const plan = order.plan ?? order.quote.plan;
    const req: QuoteRequest = { ...this.net(order.request, order.params.executorTip), source: order.endpoint, tier: order.tier, plan: plan ? (plan.mode === "single" ? "single" : "stream") : undefined, destinationKind: order.destination?.kind }; // net of the tip, escrow as sender
    // the provider's failures, and its answers this engine will not build on, are its own (ProviderFailure); a moved minimum and the price guard are not
    const failed = (e: unknown): never => {
      throw asProviderFailure(adapter.id, e);
    };
    const quote = await adapter.quote(req).catch(failed); // re-quote with the escrow as sender (spec §5)
    if (quote.minOutVerified === false && order.policy !== "fastest") throw new ProviderFailure(adapter.id, `${adapter.id}: the minimum output cannot be verified locally in the calldata; refused under policy ${order.policy}`);
    if (approvedMin !== undefined && quote.toAmountMin < approvedMin) throw new MinimumMovedError(approvedMin, quote.toAmountMin);
    if (guard) priceGuard(quote, guard.alternatives, guard.maxGapBps);
    const ingress = await adapter.prepareIngress(req, quote).catch(failed);
    if (ingress.expiresAt * 1000 <= Date.now()) throw new ProviderFailure(adapter.id, `${adapter.id}: the ingress has already expired`);
    if (ingress.kind === "contract-call" && !/^0x[0-9a-fA-F]{40}$/.test(ingress.to)) throw new ProviderFailure(adapter.id, `${adapter.id}: ingress target is not an address`);
    const deadline = Math.min(quote.expiresAt, order.params.executeDeadline);
    let call: ReturnType<typeof escrowCall>;
    try {
      call = escrowCall(order.params, ingress); // an ingress the order cannot pay is the provider's answer
    } catch (e) {
      throw asProviderFailure(adapter.id, e);
    }
    const { provider, value, calldata } = call;
    const digest = executionDigest(this.cfg.chainId, order.endpoint, order.orderId, provider, value, calldata, deadline);
    order.quote = quote;
    order.ingress = ingress;
    if (quote.plan) order.plan = quote.plan;
    return { quote, ingress, provider, value, calldata, deadline, digest };
  }

  /** The wallet signed `prepared.digest` with the one-time order key: check it and attach the execution. */
  attachSignature(order: Order, prepared: PreparedExecution, signature: `0x${string}`): Execution {
    const signer = recoverExecutionSigner(prepared.digest, signature);
    if (signer.toLowerCase() !== order.params.orderSigner.toLowerCase()) throw new Error(`signature recovers to ${signer}, not the order signer ${order.params.orderSigner}`);
    const execution: Execution = { provider: prepared.provider, value: prepared.value, providerCalldata: prepared.calldata, deadline: prepared.deadline, signature };
    order.execution = execution;
    return execution;
  }

  /** Convenience for a wallet that holds the order key in-process: prepare + sign + attach. */
  async authorize(order: Order, adapter: ProviderAdapter, orderPrivateKey: Uint8Array, guard?: { alternatives: Quote[]; maxGapBps: number }): Promise<Execution> {
    const prepared = await this.prepareExecution(order, adapter, guard);
    return this.attachSignature(order, prepared, signExecution(orderPrivateKey, prepared.digest));
  }
}
