// The service's valuation (whale spec §1, §13): the same rules as the wallet through its own RPCs, the
// fail-safe without a price, the hint that can only raise the tier, and the tier on every order.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { NO_VALUER, RpcValuer, assessRequest, isTier } from "../src/valuation";
import { PrivateSwapEngine } from "../src/engine";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../src/types";
import { TIER_DEFAULTS, type FeedSpec } from "@privacy-wallet/protocol/wallet/valuation";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const FEED = "0x00000000000000000000000000000000000feed1";
const FEEDS: FeedSpec[] = [{ symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: FEED }];
const NOW = Math.floor(Date.now() / 1000);
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const str = (s: string) => "0x" + word(32n) + word(BigInt(s.length)) + Buffer.from(s, "utf8").toString("hex").padEnd(64, "0");
const round = (answer: bigint, updatedAt: number, roundId = 10n) => "0x" + word(roundId) + word(answer) + word(BigInt(updatedAt)) + word(BigInt(updatedAt)) + word(roundId);

let servers: Server[] = [];
afterEach(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); servers = []; });
async function rpc(answer: bigint, updatedAt = NOW - 600, roundId = 10n): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const j = JSON.parse(body);
      const data: string = j.params[0].data;
      const result = data.startsWith("0x7284e416") ? str("ETH / USD") : data.startsWith("0xfeaf968c") ? round(answer, updatedAt, roundId) : "0x";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls: () => calls };
}

describe("RpcValuer (spec §13)", () => {
  it("reads the chain's feeds from every RPC, agrees, caches, and values a request", async () => {
    const a = await rpc(2_500_00000000n), b = await rpc(2_505_00000000n, NOW - 500, 11n);
    const v = new RpcValuer(1, [a.url, b.url], FEEDS, 60_000);
    const p = await v.prices(NOW);
    expect(p?.feeds.ETH).toMatchObject({ endpoints: 2, stale: false, roundId: 11n });
    const before = a.calls();
    await v.prices(NOW);
    expect(a.calls()).toBe(before); // cached
    const r = await assessRequest(v, ETH, 1_330n * 10n ** 18n, undefined, NOW);
    expect(r).toMatchObject({ tier: "high-value", failSafe: false });
    expect((r.value as { usd: number }).usd).toBeCloseTo(1_330 * 2505, 0);
  });
  it("V5 (Privacy Wallet Web spec §11): a valued order lands in the consumer bands — $20K large, $50K large-protected", async () => {
    const a = await rpc(2_500_00000000n), b = await rpc(2_500_00000000n, NOW - 500, 11n);
    const v = new RpcValuer(1, [a.url, b.url], FEEDS, 60_000);
    expect(await assessRequest(v, ETH, 7n * 10n ** 18n, undefined, NOW)).toMatchObject({ tier: "standard", failSafe: false }); // $17.5K
    expect(await assessRequest(v, ETH, 8n * 10n ** 18n, undefined, NOW)).toMatchObject({ tier: "large" }); // $20K
    expect(await assessRequest(v, ETH, 24n * 10n ** 18n, undefined, NOW)).toMatchObject({ tier: "large-protected" }); // $60K
    expect(await assessRequest(v, ETH, 40n * 10n ** 18n, undefined, NOW)).toMatchObject({ tier: "enhanced" }); // $100K
    expect(await assessRequest(v, ETH, 8n * 10n ** 18n, { ...TIER_DEFAULTS, largeProtected: 20_000 }, NOW), "a wallet's own thresholds").toMatchObject({ tier: "large-protected" });
  });
  it("a disagreeing or missing RPC answer leaves the feed unavailable and the fail-safe tier applies", async () => {
    const a = await rpc(2_500_00000000n), b = await rpc(2_700_00000000n);
    const v = new RpcValuer(1, [a.url, b.url], FEEDS, 0);
    expect((await v.prices(NOW))?.feeds.ETH).toMatchObject({ unavailable: true, reason: expect.stringContaining("endpoints disagree") });
    expect(await assessRequest(v, ETH, 10n ** 18n, undefined, NOW)).toMatchObject({ tier: "high-value", failSafe: true });
    const dead = new RpcValuer(1, ["http://127.0.0.1:1"], FEEDS, 0);
    expect((await dead.prices(NOW))?.feeds.ETH).toMatchObject({ unavailable: true });
    expect(await assessRequest(NO_VALUER, BTC, 10n ** 8n, undefined, NOW)).toMatchObject({ tier: "high-value", failSafe: true, value: { reason: "no price read yet" } });
    expect(new RpcValuer(31337, ["http://127.0.0.1:1"]).feeds).toEqual([]);
    expect(() => new RpcValuer(1, [])).toThrow(/RPC/);
  });
  it("isTier accepts the seven tiers only (V5: the two consumer bands)", () => {
    for (const t of ["standard", "large", "large-protected", "enhanced", "high-value", "high-value-secondary", "institutional"]) expect(isTier(t)).toBe(true);
    expect(isTier("whale")).toBe(false);
    expect(isTier(undefined)).toBe(false);
  });
});

/** A stub adapter that quotes anything (the engine tests need no provider here). */
class StubAdapter implements ProviderAdapter {
  readonly id = "thorchain" as const;
  readonly implemented = true;
  capabilities(): Capabilities { return { routes: ["A", "B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin"], destinationLinkPublic: true, linkEvidence: "stub" }; }
  async quote(req: QuoteRequest): Promise<Quote> { return { provider: "thorchain", category: "A", toAmount: req.amount / 30n, toAmountMin: req.amount / 31n, fees: [], etaSeconds: 600, expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now() }; }
  async prepareIngress(): Promise<Ingress> { throw new Error("not in this test"); }
  async track(): Promise<TrackStatus> { return { state: "unknown" }; }
  async health(): Promise<Health> { return { provider: "thorchain", reachable: true, apiLatencyMs: 10, halted: false, haltedChains: [], checkedAt: Date.now() }; }
}

describe("the engine records the value and the tier (spec §1)", () => {
  const engine = (valuer = NO_VALUER) => new PrivateSwapEngine({ adapters: [new StubAdapter()], factory: "0x0000000000000000000000000000000000000001", escrowCreationCode: "0x00", chainId: 1n, refundVaults: { native: "0x0000000000000000000000000000000000000002" }, tipBps: 25, refundWindowSeconds: 7200, valuer });
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 1_330n * 10n ** 18n, destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", slippageBps: 50 };
  const keys = { orderSigner: "0x00000000000000000000000000000000000000a1", refundOwnerCommitment: 1n, refundNoteSecret: 2n, refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}` };

  it("without a price source every order is at least high-value, and the wallet's hint can only raise the tier", async () => {
    const e = engine();
    const set = await e.quoteAll(req, "best-privacy");
    expect(set.tier).toBe("high-value");
    expect(set.value).toMatchObject({ unavailable: true });
    expect((await e.quoteAll(req, "best-privacy", { tier: "institutional" })).tier).toBe("institutional");
    expect((await e.quoteAll(req, "best-privacy", { tier: "standard" })).tier).toBe("high-value");
    const order = e.buildOrder(req, "best-privacy", set.quotes[0], keys, { value: set.value!, tier: set.tier!, failSafe: true }, "balanced");
    expect(order.tier).toBe("high-value");
    expect(order.preference).toBe("balanced");
    expect(order.value).toMatchObject({ unavailable: true });
  });
  it("with a price source the tier follows the USD value", async () => {
    const a = await rpc(2_500_00000000n);
    const e = engine(new RpcValuer(1, [a.url], FEEDS));
    const set = await e.quoteAll(req, "best-price");
    expect(set.tier).toBe("high-value");
    expect((set.value as { usd: number }).usd).toBe(3_325_000);
    expect((await e.quoteAll({ ...req, amount: 10n ** 18n }, "best-price")).tier).toBe("standard");
    expect((await e.quoteAll({ ...req, amount: 50n * 10n ** 18n }, "best-price")).tier).toBe("enhanced");
  });
});
