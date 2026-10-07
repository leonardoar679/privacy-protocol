// Walletless / guest mode (plan §49), LIVE and read-only: a native-chain seller gets a one-time deposit
// instruction whose address is confirmed by the THORNode gateway quorum and whose memo carries the
// destination and a minimum output built locally — nothing but the destination leaves this process.
import { describe, it, expect } from "vitest";
import { ThorchainAdapter } from "../src/adapters/thorchain";
import { categoryOf, type Ingress, type QuoteRequest } from "../src/types";
import { recordFetch } from "./helpers/tamper";

const req: QuoteRequest = {
  from: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
  to: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
  amount: 1_000_000n, // 0.01 BTC
  destination: "0x4E41cD3b4B0D4ec1B0c1dB5E1c9f0a7d0b5C1e2f", // a destination nobody has used; the only thing a guest reveals
  slippageBps: 100,
};

describe("guest deposit instruction (THORChain, BTC → ETH)", () => {
  it("is a plain deposit address confirmed by the gateway quorum, with the destination and the limit in the memo", async (ctx) => {
    const adapter = new ThorchainAdapter();
    const health = await adapter.health();
    if (!health.reachable) ctx.skip();
    expect(categoryOf(req.from, req.to)).toBe("E");
    let skipReason = "";
    const result = await recordFetch(async (calls) => {
      const quote = await adapter.quote(req);
      expect(quote.provider).toBe("thorchain");
      expect(quote.toAmountMin).toBeGreaterThan(0n);
      expect(quote.toAmountMin).toBeLessThanOrEqual(quote.toAmount);
      let ingress: Ingress | undefined;
      try { ingress = await adapter.prepareIngress(req, quote); } catch (e) { if (/halted|not confirmed|quorum/.test(String(e))) skipReason = String(e); else throw e; }
      return { ingress, calls: calls.map((c) => `${c.url} ${c.body ?? ""}`) };
    });
    if (skipReason) ctx.skip();
    const ingress = result.ingress!;
    expect(ingress.kind).toBe("plain-address");
    expect(ingress.calldata).toBe("0x");
    expect(ingress.value).toBe(req.amount);
    expect(ingress.to).toMatch(/^(bc1|[13])[a-zA-Z0-9]{20,}$/);
    expect(ingress.memo).toBeDefined();
    expect(ingress.memo!.includes(req.destination)).toBe(true);
    const limit = ingress.memo!.split(":")[3];
    expect(limit).toMatch(/^\d+/); // the memo limit is the minimum output in 1e8 units, built locally
    expect(ingress.verified?.some((v) => /gateways agree/.test(v))).toBe(true);
    expect(ingress.expiresAt * 1000).toBeGreaterThan(Date.now());
    // the only identifying string in any request is the destination the guest typed
    expect(result.calls.length).toBeGreaterThan(0);
    for (const c of result.calls) expect(c).not.toMatch(/seed|secret|spend|private/i);
  });
});
