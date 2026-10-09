// Valuation on the service (whale spec §1, §13): the same Chainlink feed table, agreement and staleness
// rules as the wallet (reference/typescript/src/wallet/valuation.ts), read through the service's own
// RPC endpoints (RPC_URLS), cached briefly. The service recomputes every order's tier; when it and the
// wallet disagree the higher tier applies (spec §1). Without RPC_URLS the service has no price: every
// order is then at least high-value (the fail-safe), never silently standard.
import {
  FEED_REGISTRY, SELECTOR, agreePrices, assess, decodeAddress, decodeLatestRoundData, decodeString, feedsFor, getFeedCalldata,
  type Assessment, type FeedSpec, type PriceRead, type Prices, type Tier, type TierThresholds,
} from "../../../reference/typescript/src/wallet/valuation";
import type { AssetRef } from "./types";

export interface Valuer { prices(now?: number): Promise<Prices | null> }
/** No RPC configured: no price, the fail-safe tier for everything. */
export const NO_VALUER: Valuer = { prices: async () => null };

async function ethCall(fetchImpl: typeof fetch, url: string, to: string, data: string, timeoutMs = 15000): Promise<string> {
  const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`${url} answered ${r.status} ${text.slice(0, 40).replace(/\s+/g, " ")}`); }
  if (j.error) throw new Error(`${url}: ${j.error.message}`);
  if (typeof j.result !== "string" || j.result === "0x") throw new Error(`${url}: no code / no result at ${to}`);
  return j.result;
}

async function readFeed(fetchImpl: typeof fetch, url: string, spec: FeedSpec): Promise<PriceRead> {
  let address = spec.proxy;
  if (!address) address = decodeAddress(await ethCall(fetchImpl, url, FEED_REGISTRY, getFeedCalldata(spec.registryBase!)));
  const description = decodeString(await ethCall(fetchImpl, url, address, SELECTOR.description));
  if (description !== spec.description) throw new Error(`${spec.symbol}: ${address} is "${description}", not "${spec.description}"`);
  const round = decodeLatestRoundData(await ethCall(fetchImpl, url, address, SELECTOR.latestRoundData));
  if (round.answer <= 0n) throw new Error(`${spec.symbol}: the feed answers ${round.answer}`);
  return { symbol: spec.symbol, usd1e8: round.answer, roundId: round.roundId, updatedAt: round.updatedAt, source: url };
}

/** Reads every feed of the chain from every RPC; every endpoint must answer and agree (spec §13). */
export class RpcValuer implements Valuer {
  private cache: { at: number; prices: Prices } | null = null;
  private inFlight: Promise<Prices> | null = null;
  constructor(readonly chainId: number, readonly rpcUrls: string[], readonly feeds: FeedSpec[] = feedsFor(chainId), readonly ttlMs = 60_000, private readonly fetchImpl: typeof fetch = fetch) {
    if (!rpcUrls.length) throw new Error("RpcValuer needs at least one RPC URL");
  }
  async prices(now = Math.floor(Date.now() / 1000)): Promise<Prices | null> {
    if (!this.feeds.length) return null;
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.prices;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const out: Prices = { chainId: this.chainId, at: now, feeds: {} };
      await Promise.all(this.feeds.map(async (spec) => {
        const reads = await Promise.all(this.rpcUrls.map((u) => readFeed(this.fetchImpl, u, spec).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e) }))));
        const bad = reads.find((x) => !x.ok);
        if (bad && !bad.ok) { out.feeds[spec.symbol] = { unavailable: true, reason: bad.e }; return; }
        const agreed = agreePrices(reads.map((x) => (x as { r: PriceRead }).r), spec, now);
        out.feeds[spec.symbol] = "disagree" in agreed ? { unavailable: true, reason: `endpoints disagree: ${agreed.disagree}` } : agreed;
      }));
      this.cache = { at: Date.now(), prices: out };
      return out;
    })();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
}

/** Value a request's source amount (gross, in `from` units) and place it in a tier; the service applies the default thresholds (a wallet can only raise the tier). */
export async function assessRequest(valuer: Valuer, from: AssetRef, amount: bigint, thresholds?: TierThresholds, now = Math.floor(Date.now() / 1000)): Promise<Assessment> {
  const prices = await valuer.prices(now).catch(() => null);
  return assess({ amount, decimals: from.decimals, symbol: from.symbol, prices, thresholds, now });
}

export const isTier = (x: unknown): x is Tier => x === "standard" || x === "large" || x === "large-protected" || x === "enhanced" || x === "high-value" || x === "high-value-secondary" || x === "institutional";
