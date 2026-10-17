// Valuation and value tiers (whale-execution spec §1, §13; plan V2 §4–§5, §13): the USD value of an
// amount from Chainlink's on-chain feeds, read by the caller through its own RPC endpoints (the wallet:
// its quorum; the service: its RPC; the lab: public RPCs) — this module holds the feed table, the ABI
// decoding, the agreement and staleness rules, the tier thresholds and the fail-safe, with no network
// of its own, so the wallet and the engine compute the same tier from the same bytes.
//
// Prices are kept as the feeds give them, 8-decimal fixed point (`usd1e8`); USD values are numbers
// with cents. Nothing here is a price of its own: a missing or stale feed is "unavailable", and the
// fail-safe then applies the High-Value controls (spec §13) rather than guessing.

/** V5 (Privacy Wallet Web spec §11): `large` ($20K: the Review and the lint) and `large-protected` ($50K: protected execution) sit below `enhanced`, so every rule keyed on `enhanced` and above keeps its meaning. */
export type Tier = "standard" | "large" | "large-protected" | "enhanced" | "high-value" | "high-value-secondary" | "institutional";
/** Ascending. */
export const TIERS: readonly Tier[] = ["standard", "large", "large-protected", "enhanced", "high-value", "high-value-secondary", "institutional"];
/** The two V5 thresholds are optional on the wire (an older wallet sends four); the defaults apply when absent. */
export interface TierThresholds { large?: number; largeProtected?: number; enhanced: number; highValue: number; highValueSecondary: number; institutional: number }
/** Plan V2 §13 defaults and the V5 consumer bands, in USD; configurable in the wallet's settings. */
export const TIER_DEFAULTS: Required<TierThresholds> = { large: 20_000, largeProtected: 50_000, enhanced: 100_000, highValue: 1_000_000, highValueSecondary: 5_000_000, institutional: 10_000_000 };

/**
 * V5: a V2–V4 thresholds object (four values) gets the two consumer bands — the defaults, or a fifth and a half of
 * `enhanced` when the user lowered that one below them, so an older setting keeps its meaning and stays increasing.
 */
export function fillThresholds(t: TierThresholds): Required<TierThresholds> {
  const large = t.large ?? Math.min(TIER_DEFAULTS.large, t.enhanced / 5);
  const largeProtected = t.largeProtected ?? Math.min(TIER_DEFAULTS.largeProtected, t.enhanced / 2);
  return { ...t, large, largeProtected };
}

export function checkThresholds(t: TierThresholds): void {
  const f = fillThresholds(t);
  const v = [f.large, f.largeProtected, f.enhanced, f.highValue, f.highValueSecondary, f.institutional];
  if (v.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error("tier thresholds must be positive numbers");
  for (let i = 1; i < v.length; i++) if (v[i] <= v[i - 1]) throw new Error("tier thresholds must increase: large < largeProtected < enhanced < highValue < highValueSecondary < institutional");
}

export function tierOf(usd: number, t: TierThresholds = TIER_DEFAULTS): Tier {
  if (!(usd >= 0)) throw new Error("tierOf: usd must be a non-negative number");
  if (usd >= t.institutional) return "institutional";
  if (usd >= t.highValueSecondary) return "high-value-secondary";
  if (usd >= t.highValue) return "high-value";
  if (usd >= t.enhanced) return "enhanced";
  const f = fillThresholds(t);
  if (usd >= f.largeProtected) return "large-protected";
  if (usd >= f.large) return "large";
  return "standard";
}
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
export const higherTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b);
export const atLeast = (t: Tier, min: Tier): boolean => tierRank(t) >= tierRank(min);

// ---- Chainlink feeds --------------------------------------------------------------------------------
export interface FeedSpec {
  symbol: string;
  /** what the feed's description() must return (checked before any price is used) */
  description: string;
  /** the feed's heartbeat; a price older than twice it is stale */
  heartbeatSeconds: number;
  /** the aggregator proxy, when pinned */
  proxy?: string;
  /** the Feed Registry base denomination, when the proxy is resolved at read time */
  registryBase?: string;
}
export const FEED_REGISTRY = "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf";
export const USD_DENOMINATION = "0x0000000000000000000000000000000000000348";
export const BTC_DENOMINATION = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
/** Every pinned address answered its description() from here on 2026-10-07/08 (the lab, `benchmarks/whale`). */
export const FEEDS: Record<number, FeedSpec[]> = {
  1: [
    { symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
    { symbol: "BTC", description: "BTC / USD", heartbeatSeconds: 3600, registryBase: BTC_DENOMINATION },
    { symbol: "USDC", description: "USDC / USD", heartbeatSeconds: 86400, proxy: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6" },
    { symbol: "USDT", description: "USDT / USD", heartbeatSeconds: 86400, proxy: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D" },
    { symbol: "SOL", description: "SOL / USD", heartbeatSeconds: 86400, proxy: "0x4ffC43a60e009B551865A93d232E33Fce9f01507" },
  ],
  11155111: [
    { symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: "0x694AA1769357215DE4FAC081bf1f309aDC325306" },
    { symbol: "BTC", description: "BTC / USD", heartbeatSeconds: 3600, proxy: "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43" },
    { symbol: "USDC", description: "USDC / USD", heartbeatSeconds: 86400, proxy: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E" },
  ],
};
/** The feeds for a chain; an override (a deployment's own list, e.g. a devnet mock) replaces the table. */
export const feedsFor = (chainId: number, override?: FeedSpec[] | null): FeedSpec[] => override ?? FEEDS[chainId] ?? [];

export const SELECTOR = { latestRoundData: "0xfeaf968c", description: "0x7284e416", getFeed: "0xd2edb6dd" } as const;
const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const getFeedCalldata = (base: string, quote: string = USD_DENOMINATION): string => SELECTOR.getFeed + pad32(base) + pad32(quote);

const word = (hex: string, i: number): bigint => BigInt("0x" + hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64).padEnd(64, "0"));
export interface RoundData { roundId: bigint; answer: bigint; startedAt: number; updatedAt: number; answeredInRound: bigint }
export function decodeLatestRoundData(hex: string): RoundData {
  if (hex.replace(/^0x/, "").length < 5 * 64) throw new Error("latestRoundData: short answer");
  const raw = word(hex, 1);
  const answer = raw >= 1n << 255n ? raw - (1n << 256n) : raw; // int256
  return { roundId: word(hex, 0), answer, startedAt: Number(word(hex, 2)), updatedAt: Number(word(hex, 3)), answeredInRound: word(hex, 4) };
}
export function decodeString(hex: string): string {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) throw new Error("string: short answer");
  const off = Number(BigInt("0x" + h.slice(0, 64))) * 2, len = Number(BigInt("0x" + h.slice(off, off + 64)));
  const bytes = h.slice(off + 64, off + 64 + len * 2);
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return s;
}
export const decodeAddress = (hex: string): string => "0x" + word(hex, 0).toString(16).padStart(40, "0");

// ---- reads, agreement, staleness -------------------------------------------------------------------
export interface PriceRead { symbol: string; usd1e8: bigint; roundId: bigint; updatedAt: number; source: string }
export interface AgreedPrice extends PriceRead { endpoints: number; stale: boolean; heartbeatSeconds: number }

/**
 * Several endpoints' reads of one feed agree when every answer is within `toleranceBps` of the median
 * and no round is more than one behind the newest (endpoints sit at slightly different blocks). The
 * newest read is the result. A single read agrees with itself.
 */
export function agreePrices(reads: PriceRead[], spec: FeedSpec, now: number, toleranceBps = 50): AgreedPrice | { disagree: string } {
  if (!reads.length) return { disagree: "no endpoint answered" };
  const sorted = [...reads].sort((a, b) => (a.usd1e8 < b.usd1e8 ? -1 : a.usd1e8 > b.usd1e8 ? 1 : 0));
  const median = sorted[Math.floor(sorted.length / 2)].usd1e8;
  for (const r of reads) {
    const gap = r.usd1e8 > median ? r.usd1e8 - median : median - r.usd1e8;
    if (gap * 10000n > median * BigInt(toleranceBps)) return { disagree: `${spec.symbol}: ${r.source} answers ${fmt1e8(r.usd1e8)} vs ${fmt1e8(median)}` };
  }
  const newest = reads.reduce((m, r) => (r.roundId > m.roundId ? r : m));
  for (const r of reads) if (newest.roundId - r.roundId > 1n) return { disagree: `${spec.symbol}: ${r.source} is ${newest.roundId - r.roundId} rounds behind` };
  return { ...newest, endpoints: reads.length, stale: isStale(newest, spec, now), heartbeatSeconds: spec.heartbeatSeconds };
}
export const isStale = (read: Pick<PriceRead, "updatedAt">, spec: Pick<FeedSpec, "heartbeatSeconds">, now: number): boolean => now - read.updatedAt > 2 * spec.heartbeatSeconds;
const fmt1e8 = (x: bigint) => `${x / 100000000n}.${(x % 100000000n).toString().padStart(8, "0").slice(0, 2)}`;

/** What a wallet or the engine holds after a read: per symbol, the agreed price or why there is none. */
export interface Prices { chainId: number; at: number; feeds: Record<string, AgreedPrice | { unavailable: true; reason: string }> }
export const availablePrice = (p: Prices | null | undefined, symbol: string): AgreedPrice | null => {
  const f = p?.feeds[symbol];
  return f && !("unavailable" in f) && !f.stale ? f : null;
};

/** A cost in wei as `asset`'s base units at the agreed ETH and asset prices, rounded up; null without both prices (Privacy
 *  Wallet Web spec v2.0 §3: a gas cost in an ERC-20 is valued, never guessed). */
export function weiInAsset(wei: bigint, asset: { symbol: string; decimals: number; native: boolean }, prices: Prices | null | undefined): bigint | null {
  if (asset.native) return wei;
  const eth = availablePrice(prices, "ETH");
  const token = availablePrice(prices, asset.symbol);
  if (!eth || !token) return null;
  const den = 10n ** 18n * token.usd1e8;
  return (wei * eth.usd1e8 * 10n ** BigInt(asset.decimals) + den - 1n) / den;
}

/** The journal form (JSON: bigints as decimal strings). */
export interface PricesJson { chainId: number; at: number; feeds: Record<string, { symbol: string; usd1e8: string; roundId: string; updatedAt: number; source: string; endpoints: number; stale: boolean; heartbeatSeconds: number } | { unavailable: true; reason: string }> }
export function serializePrices(p: Prices): PricesJson {
  const feeds: PricesJson["feeds"] = {};
  for (const [k, f] of Object.entries(p.feeds)) feeds[k] = "unavailable" in f ? f : { ...f, usd1e8: f.usd1e8.toString(), roundId: f.roundId.toString() };
  return { chainId: p.chainId, at: p.at, feeds };
}
export function parsePrices(j: unknown): Prices | null {
  const x = j as PricesJson | null | undefined;
  if (!x || typeof x !== "object" || typeof x.chainId !== "number" || typeof x.at !== "number" || !x.feeds || typeof x.feeds !== "object") return null;
  const feeds: Prices["feeds"] = {};
  for (const [k, f] of Object.entries(x.feeds)) {
    if ("unavailable" in f) { feeds[k] = f; continue; }
    if (!/^\d+$/.test(f.usd1e8) || !/^\d+$/.test(f.roundId)) return null;
    feeds[k] = { ...f, usd1e8: BigInt(f.usd1e8), roundId: BigInt(f.roundId) };
  }
  return { chainId: x.chainId, at: x.at, feeds };
}

// ---- values and tiers ------------------------------------------------------------------------------
/** USD with cents from base units and an 8-decimal price (bigint arithmetic; exact to the cent). */
export function usdOf(amount: bigint, decimals: number, usd1e8: bigint): number {
  if (amount < 0n || usd1e8 < 0n) throw new Error("usdOf: negative input");
  const cents = (amount * usd1e8 * 100n) / (10n ** BigInt(decimals) * 100000000n);
  return Number(cents) / 100;
}

export type Valuation =
  | { usd: number; at: number; source: "chainlink"; feeds: { pair: string; roundId: string; updatedAt: number }[] }
  | { unavailable: true; reason: string };

export interface Assessment { value: Valuation; tier: Tier; /** the tier came from the fail-safe, not from a price */ failSafe: boolean }

/**
 * Value an amount and place it in a tier (spec §13). Without a usable current price the fail-safe
 * applies: the higher of `high-value` and the tier the last journaled price (< 24 h old) implies.
 */
export function assess(o: { amount: bigint; decimals: number; symbol: string; prices: Prices | null; lastPrices?: Prices | null; thresholds?: TierThresholds; now: number }): Assessment {
  const t = o.thresholds ?? TIER_DEFAULTS;
  const p = availablePrice(o.prices, o.symbol);
  if (p) {
    const usd = usdOf(o.amount, o.decimals, p.usd1e8);
    return { value: { usd, at: o.now, source: "chainlink", feeds: [{ pair: `${o.symbol} / USD`, roundId: p.roundId.toString(), updatedAt: p.updatedAt }] }, tier: tierOf(usd, t), failSafe: false };
  }
  const f = o.prices?.feeds[o.symbol];
  const reason = !o.prices ? "no price read yet" : !f ? `no ${o.symbol} / USD feed on this chain` : "unavailable" in f ? f.reason : `the ${o.symbol} / USD price is ${Math.round((o.now - f.updatedAt) / 60)} min old (stale)`;
  const last = availablePrice(o.lastPrices, o.symbol);
  const lastTier = last && o.now - (o.lastPrices?.at ?? 0) < 86400 ? tierOf(usdOf(o.amount, o.decimals, last.usd1e8), t) : "standard";
  return { value: { unavailable: true, reason }, tier: higherTier("high-value", lastTier), failSafe: true };
}

/** "$3,420,000" / "$4,281,924.20"; compact: "$4.28M", "$120K", "$950". */
export function formatUsd(usd: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(usd)) return "—";
  if (opts.compact) {
    if (usd >= 1e9) return `$${trim((usd / 1e9).toFixed(2))}B`;
    if (usd >= 1e6) return `$${trim((usd / 1e6).toFixed(2))}M`;
    if (usd >= 1e3) return `$${trim((usd / 1e3).toFixed(usd >= 1e5 ? 0 : 1))}K`;
    return `$${trim(usd.toFixed(2))}`;
  }
  // in whole cents, the sign in front (the audit round of 2026-10-16, c56): −37.25 read "$-38.75" and 12.996 "$12.100"
  const total = Math.round(Math.abs(usd) * 100);
  const sign = usd < 0 && total > 0 ? "−" : "";
  const whole = Math.floor(total / 100), cents = total % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents > 0 && Math.abs(usd) < 1e6 ? `${sign}$${grouped}.${cents.toString().padStart(2, "0")}` : `${sign}$${grouped}`;
}
const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** The tier in the user's words (spec §23: no jargon). */
export const tierLabel: Record<Tier, string> = {
  standard: "Transfer",
  large: "Large transfer",
  "large-protected": "Protected transfer",
  enhanced: "Large transfer",
  "high-value": "High-value transfer",
  "high-value-secondary": "High-value transfer",
  institutional: "Institutional transfer",
};
