// Prices for the wallet (whale-execution spec §13): Chainlink's feeds read through the wallet's own RPC
// quorum — every configured endpoint answers latestRoundData(), the answers must agree (within 0.5 %,
// at most one round apart) and the newest is used; a price older than twice the feed's heartbeat is
// stale. No price API, no new endpoint, nothing user-specific in the requests (the same calls for every
// user). Read only when there is something to value: a deployment with feeds for its chain and unspent
// notes in the wallet — never at first launch (apps/web/test/first-launch.test.tsx), never from a bare
// mount. The last good read is kept in the encrypted journal (`prices`) for the fail-safe of spec §13.
import type { Hex, PublicClient } from "viem";
import {
  SELECTOR, agreePrices, assess, availablePrice, decodeAddress, decodeLatestRoundData, decodeString, feedsFor, getFeedCalldata, FEED_REGISTRY, parsePrices, serializePrices, usdOf,
  type Assessment, type FeedSpec, type PriceRead, type Prices, type TierThresholds,
} from "@privacy-wallet/protocol/wallet/valuation";
import { clientsFor, type Deployment } from "./chain";
import type { Asset } from "./assets";
import { noteStore } from "../wallet/notes";
import { session, type WalletSession } from "../wallet/session";
import { settings } from "../wallet/settings";
import { config } from "./config";

export type PriceStatus = "idle" | "not-configured" | "loading" | "ready" | "unavailable";
export interface PriceState { status: PriceStatus; prices: Prices | null; reason?: string; at?: number }

/** A deployment's own feed list (VITE_PRICE_FEEDS: JSON array of FeedSpec) for devnets and tests; the table covers mainnet and Sepolia. */
export function feedsFromEnv(env: Record<string, string | undefined>): FeedSpec[] | null {
  const raw = env.VITE_PRICE_FEEDS;
  if (!raw) return null;
  const list = JSON.parse(raw) as FeedSpec[];
  if (!Array.isArray(list) || list.some((f) => !f.symbol || !f.description || !(f.heartbeatSeconds > 0) || !(f.proxy || f.registryBase))) throw new Error("VITE_PRICE_FEEDS must be a JSON array of { symbol, description, heartbeatSeconds, proxy | registryBase }");
  return list;
}

/** One endpoint's read of one feed: resolve the proxy (registry when needed), check description(), decode the round. */
async function readFeed(client: PublicClient, spec: FeedSpec, source: string): Promise<PriceRead> {
  let address = spec.proxy;
  if (!address) {
    const r = await client.call({ to: FEED_REGISTRY as Hex, data: getFeedCalldata(spec.registryBase!) as Hex });
    if (!r.data || r.data === "0x") throw new Error(`${spec.symbol}: the Feed Registry answered nothing`);
    address = decodeAddress(r.data);
  }
  const d = await client.call({ to: address as Hex, data: SELECTOR.description as Hex });
  if (!d.data || d.data === "0x") throw new Error(`${spec.symbol}: no feed at ${address}`);
  const description = decodeString(d.data);
  if (description !== spec.description) throw new Error(`${spec.symbol}: ${address} is "${description}", not "${spec.description}"`);
  const r = await client.call({ to: address as Hex, data: SELECTOR.latestRoundData as Hex });
  if (!r.data || r.data === "0x") throw new Error(`${spec.symbol}: no round data at ${address}`);
  const round = decodeLatestRoundData(r.data);
  if (round.answer <= 0n) throw new Error(`${spec.symbol}: the feed answers ${round.answer}`);
  return { symbol: spec.symbol, usd1e8: round.answer, roundId: round.roundId, updatedAt: round.updatedAt, source };
}

/** Every feed of the chain from every endpoint, agreed per feed (spec §13); pure of any store. */
export async function readPrices(d: Deployment, feeds: FeedSpec[], now = Math.floor(Date.now() / 1000)): Promise<Prices> {
  const clients = clientsFor(d);
  const urls = d.rpcUrls?.length ? d.rpcUrls : [d.rpcUrl];
  const out: Prices = { chainId: d.chainId, at: now, feeds: {} };
  await Promise.all(feeds.map(async (spec) => {
    const reads = await Promise.all(clients.map((c, i) => readFeed(c, spec, urls[i]).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e) }))));
    const good = reads.filter((x): x is { ok: true; r: PriceRead } => x.ok).map((x) => x.r);
    if (good.length < clients.length) { out.feeds[spec.symbol] = { unavailable: true, reason: reads.find((x) => !x.ok && "e" in x)!.e }; return; }
    const agreed = agreePrices(good, spec, now);
    out.feeds[spec.symbol] = "disagree" in agreed ? { unavailable: true, reason: `endpoints disagree: ${agreed.disagree}` } : agreed;
  }));
  return out;
}

/** The last good read, from the journal (optional field, JSON form; absent on a fresh wallet). */
const journaledPrices = (s: WalletSession): Prices | null => {
  if (!s.isUnlocked()) return null;
  return parsePrices((s.journal() as { prices?: unknown }).prices);
};

export class PriceStore {
  private st: PriceState = { status: "idle", prices: null };
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  constructor(private readonly s: WalletSession = session, readonly maxAgeMs = 5 * 60_000) {}
  state(): PriceState { return this.st; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private set(st: PriceState): void { this.st = st; for (const l of this.listeners) l(); }
  reset(): void { this.set({ status: "idle", prices: null }); }

  /** Whether a read is warranted: feeds for this chain, and unspent notes to value (spec §13: never at first launch). */
  eligible(d: Deployment | null, feeds: FeedSpec[] | null = config().priceFeeds): boolean {
    return !!d && feedsFor(d.chainId, feeds).length > 0 && noteStore.unspent().length > 0;
  }

  /** Read if eligible and not fresh. Never throws: a failure is the `unavailable` state with its reason. */
  async refresh(d: Deployment | null, o: { force?: boolean; feeds?: FeedSpec[] | null; now?: number } = {}): Promise<void> {
    const feeds = o.feeds === undefined ? config().priceFeeds : o.feeds;
    if (!d || !feedsFor(d.chainId, feeds).length) { this.set({ status: "not-configured", prices: null, reason: d ? `no price feeds for chain ${d.chainId}` : "no deployment" }); return; }
    if (!noteStore.unspent().length) return; // nothing to value; stay as we are
    if (!o.force && this.st.status === "ready" && this.st.at && Date.now() - this.st.at < this.maxAgeMs) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      this.set({ ...this.st, status: "loading" });
      try {
        const prices = await readPrices(d, feedsFor(d.chainId, feeds), o.now);
        const anyGood = Object.values(prices.feeds).some((f) => !("unavailable" in f) && !f.stale);
        if (anyGood) this.s.update((j) => { (j as { prices?: unknown }).prices = serializePrices(prices); });
        this.set({ status: anyGood ? "ready" : "unavailable", prices, at: Date.now(), reason: anyGood ? undefined : Object.values(prices.feeds).map((f) => ("unavailable" in f ? f.reason : `${f.symbol} stale`)).join("; ") });
      } catch (e: any) {
        this.set({ status: "unavailable", prices: this.st.prices, at: Date.now(), reason: e?.message ?? String(e) });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Value an amount of an asset with the current read, the journaled read as the fail-safe's memory, and the user's thresholds. */
  assess(amount: bigint, asset: Pick<Asset, "symbol" | "decimals">, now = Math.floor(Date.now() / 1000)): Assessment {
    const thresholds: TierThresholds = settings.get().tiers;
    return assess({ amount, decimals: asset.decimals, symbol: asset.symbol, prices: this.st.prices, lastPrices: journaledPrices(this.s), thresholds, now });
  }
}

export const priceStore = new PriceStore();

/** Whether valuation is configured at all for this deployment (spec §13: without feeds for the chain the wallet shows no USD and the tiers are off). */
export const feedsConfigured = (d: Deployment | null, feeds: FeedSpec[] | null = config().priceFeeds): boolean => !!d && feedsFor(d.chainId, feeds).length > 0;

/** The USD value of balances under a price state: the total of what could be valued, how many assets that is, and the symbols left unpriced. */
export function valueOfBalances(st: PriceState, lines: { symbol: string; decimals: number; units: bigint }[]): { usd: number; valued: number; unpriced: string[] } {
  let usd = 0, valued = 0;
  const unpriced: string[] = [];
  for (const l of lines) {
    if (l.units === 0n) continue;
    const p = availablePrice(st.prices, l.symbol);
    if (p) { usd += usdOf(l.units, l.decimals, p.usd1e8); valued++; } else unpriced.push(l.symbol);
  }
  return { usd, valued, unpriced };
}
