// Prices through the wallet's RPC quorum (whale-execution spec §13): every endpoint must answer and
// agree, staleness, the fail-safe memory in the journal, and the gate — nothing is read without a
// deployment whose chain has feeds and unspent notes to value.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startMockCore, type MockFeed } from "./helpers/mockRpc";
import { PriceStore, readPrices } from "@privacy-wallet/sdk/prices";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import type { FeedSpec } from "@privacy-wallet/protocol/wallet/valuation";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const CORE = "0x00000000000000000000000000000000000c0de0";
const ETH_FEED = "0x00000000000000000000000000000000000feed1";
const USDC_FEED = "0x00000000000000000000000000000000000feed2";
const BTC_AGG = "0x00000000000000000000000000000000000feed3";
const BTC_DENOMINATION = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const NOW = Math.floor(Date.now() / 1000);
const FEEDS: FeedSpec[] = [
  { symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: ETH_FEED },
  { symbol: "USDC", description: "USDC / USD", heartbeatSeconds: 86400, proxy: USDC_FEED },
  { symbol: "BTC", description: "BTC / USD", heartbeatSeconds: 3600, registryBase: BTC_DENOMINATION },
];
const feeds = (over: Partial<Record<"ETH" | "USDC" | "BTC", Partial<MockFeed>>> = {}): Record<string, MockFeed> => ({
  [ETH_FEED]: { description: "ETH / USD", answer: 2_500_00000000n, updatedAt: NOW - 600, roundId: 10n, ...(over.ETH ?? {}) },
  [USDC_FEED]: { description: "USDC / USD", answer: 99_980_000n, updatedAt: NOW - 3600, roundId: 5n, ...(over.USDC ?? {}) },
  [BTC_AGG]: { description: "BTC / USD", answer: 83_000_00000000n, updatedAt: NOW - 300, roundId: 7n, ...(over.BTC ?? {}) },
});
const registry = { [BTC_DENOMINATION]: BTC_AGG };
const core = () => ({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
const deployment = (urls: string[]): Deployment => ({ chainId: 31337, core: CORE, ethVault: "0x00000000000000000000000000000000000e7000", rpcUrl: urls[0], rpcUrls: urls, fromBlock: 0n, erc20Vaults: [] });
const note = (amount: bigint, leafIndex: number) => ({ note: { vaultId: BigInt("0x00000000000000000000000000000000000e7000"), amount, ownerCommitment: 1n, noteSecret: 2n }, leafIndex, noteData: "0x00" as const, spent: false });

let closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; noteStore.clear(); settings.reset(); });

async function mocks(a: Record<string, MockFeed>, b: Record<string, MockFeed> = a) {
  const m1 = await startMockCore({ ...core(), feeds: a, registry }), m2 = await startMockCore({ ...core(), feeds: b, registry });
  closers.push(m1.close, m2.close);
  return { m1, m2, d: deployment([m1.url, m2.url]) };
}

describe("readPrices (spec §13)", () => {
  it("reads every feed from every endpoint, resolves the registry-based one, and agrees", async () => {
    const { d } = await mocks(feeds());
    const p = await readPrices(d, FEEDS, NOW);
    expect(p.chainId).toBe(31337);
    for (const s of ["ETH", "USDC", "BTC"]) expect(p.feeds[s]).toMatchObject({ symbol: s, endpoints: 2, stale: false });
    expect((p.feeds.ETH as { usd1e8: bigint }).usd1e8).toBe(2_500_00000000n);
  });
  it("a feed the endpoints disagree on, a stale feed and a missing feed are each unavailable on their own", async () => {
    const { d } = await mocks(feeds(), feeds({ ETH: { answer: 2_600_00000000n } }));
    const p = await readPrices(d, FEEDS, NOW);
    expect(p.feeds.ETH).toMatchObject({ unavailable: true, reason: expect.stringContaining("endpoints disagree") });
    expect(p.feeds.USDC).toMatchObject({ stale: false });
    const { d: d2 } = await mocks(feeds({ USDC: { updatedAt: NOW - 200_000 } }));
    const p2 = await readPrices(d2, FEEDS, NOW);
    expect(p2.feeds.USDC).toMatchObject({ stale: true });
    const { d: d3 } = await mocks(feeds());
    const p3 = await readPrices(d3, [...FEEDS, { symbol: "SOL", description: "SOL / USD", heartbeatSeconds: 86400, proxy: "0x00000000000000000000000000000000000feed9" }], NOW);
    expect(p3.feeds.SOL).toMatchObject({ unavailable: true });
  });
  it("a feed whose description is not the expected pair is refused", async () => {
    const { d } = await mocks(feeds({ ETH: { description: "LINK / USD" } }));
    const p = await readPrices(d, FEEDS, NOW);
    expect(p.feeds.ETH).toMatchObject({ unavailable: true, reason: expect.stringContaining('"LINK / USD"') });
  });
});

describe("PriceStore: the gate, the states, the journal memory (spec §13, §25)", () => {
  let session: WalletSession;
  beforeEach(async () => { session = new WalletSession(memoryStorage(), KDF); await session.create("pw"); session.acknowledgePhrase(); });

  it("reads nothing without a deployment, without feeds for the chain, or without unspent notes", async () => {
    const { m1, d } = await mocks(feeds());
    const store = new PriceStore(session);
    await store.refresh(null, { feeds: FEEDS });
    expect(store.state().status).toBe("not-configured");
    await store.refresh(d, { feeds: null }); // chain 31337 has no table
    expect(store.state().status).toBe("not-configured");
    store.reset();
    await store.refresh(d, { feeds: FEEDS }); // feeds, but nothing to value
    expect(store.state().status).toBe("idle");
    expect(m1.state.calls).toBe(0);
  });
  it("with unspent notes it reads, values the balance, journals the read and serves the fail-safe from it", async () => {
    const { d } = await mocks(feeds());
    noteStore.add(note(1_330n * 10n ** 18n, 0));
    const store = new PriceStore(session);
    await store.refresh(d, { feeds: FEEDS, now: NOW });
    expect(store.state().status).toBe("ready");
    const a = store.assess(1_330n * 10n ** 18n, { symbol: "ETH", decimals: 18 }, NOW);
    expect(a).toMatchObject({ tier: "high-value", failSafe: false, value: { usd: 3_325_000 } });
    expect(store.assess(10n ** 18n, { symbol: "ETH", decimals: 18 }, NOW)).toMatchObject({ tier: "standard" });
    expect((session.journal() as { prices?: { chainId: number } }).prices?.chainId).toBe(31337);
    // the user's thresholds apply
    settings.set({ tiers: { enhanced: 1_000, highValue: 2_000, highValueSecondary: 3_000, institutional: 4_000 } });
    expect(store.assess(10n ** 18n, { symbol: "ETH", decimals: 18 }, NOW)).toMatchObject({ tier: "high-value" });
    settings.reset();
    // a second store with no read of its own: the fail-safe uses the journaled price when it is fresh
    const fresh = new PriceStore(session);
    expect(fresh.assess(5_000n * 10n ** 18n, { symbol: "ETH", decimals: 18 }, NOW)).toMatchObject({ tier: "institutional", failSafe: true });
    expect(fresh.assess(10n ** 15n, { symbol: "ETH", decimals: 18 }, NOW)).toMatchObject({ tier: "high-value", failSafe: true });
  });
  it("an endpoint outage makes the price unavailable, keeps the last read, and is retried on a forced refresh", async () => {
    const { m2, d } = await mocks(feeds());
    noteStore.add(note(10n ** 18n, 0));
    const store = new PriceStore(session);
    await store.refresh(d, { feeds: FEEDS, now: NOW });
    expect(store.state().status).toBe("ready");
    await m2.close();
    closers = closers.filter((c) => c !== m2.close);
    await store.refresh(d, { feeds: FEEDS, now: NOW, force: true });
    expect(store.state().status).toBe("unavailable");
    expect(store.assess(10n ** 18n, { symbol: "ETH", decimals: 18 }, NOW)).toMatchObject({ failSafe: true, tier: "high-value" });
  });
});
