// The request bodies are checked at the edge (a V6 follow-up of 2026-10-14). A malformed number or string had reached
// the engine and the providers: an order's params that were not integers crashed the API (a 500 logged as its own
// error), and a slippage that was not a number went to every provider as NaN, where an error without a refusal's words
// would have counted against the provider's health for every user. Now each answers 400 `invalid_request`, and no
// provider is asked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, orderBody, swapRequest, type Harness } from "./helpers";

let h: Harness;
let asked = 0;
let tracked = 0;
beforeEach(async () => {
  h = await harness();
  asked = 0;
  tracked = 0;
  const quote = h.adapter.quote.bind(h.adapter);
  h.adapter.quote = async (req) => {
    asked++;
    return quote(req);
  };
  const track = h.adapter.track.bind(h.adapter);
  h.adapter.track = async () => {
    tracked++;
    return track();
  };
});
afterEach(() => h.close());

const refused = async (path: string, body: unknown) => {
  const r = await h.post(path, body);
  return { status: r.status, code: r.body.code as string | undefined };
};

describe("the request bodies, checked at the edge", () => {
  it("a slippage, decimals, an amount or a destination out of shape: 400 before any provider is asked", async () => {
    const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
    for (const body of [
      swapRequest({ slippageBps: "lots" }),
      swapRequest({ slippageBps: -1 }),
      swapRequest({ slippageBps: 10_001 }),
      swapRequest({ slippageBps: 12.5 }),
      swapRequest({ from: { ...ETH, decimals: -1 } }),
      swapRequest({ from: { ...ETH, decimals: 99_999 } }),
      swapRequest({ amount: "1".repeat(79) }),
      swapRequest({ destination: "x".repeat(257) }),
      swapRequest({ destination: { not: "a string" } }),
    ])
      expect(await refused("/v1/quotes", body), JSON.stringify(body).slice(0, 120)).toEqual({ status: 400, code: "invalid_request" });
    expect(asked).toBe(0);
    expect(
      h.lines.some((l) => l.includes('"http.error"')),
      "never the API's own error",
    ).toBe(false);
  });

  it("a tracking query out of shape: 400 before the provider is asked — nothing else reaches a provider's URL", async () => {
    for (const path of [
      "/v1/track/thorchain?tx=abc",
      "/v1/track/thorchain?tx=" + "e1".repeat(32) + "%2F..%2Fvaults",
      "/v1/track/thorchain?ref=a%2F..%2Fb",
      "/v1/track/thorchain?ref=" + "x".repeat(129),
      "/v1/guest/track/thorchain/notatxid",
    ]) {
      const r = await h.get(path);
      expect({ status: r.status, code: r.body.code }, path).toEqual({ status: 400, code: "invalid_request" });
    }
    expect(tracked).toBe(0);
    // a transaction hash, with or without 0x, and a plain reference are read
    for (const path of ["/v1/track/thorchain?tx=0x" + "e1".repeat(32), "/v1/guest/track/thorchain/" + "AB".repeat(32), "/v1/track/thorchain?ref=deposit.near"])
      expect((await h.get(path)).status, path).toBe(200);
    expect(tracked).toBe(3);
  });

  it("an order's journaled params out of shape: 400 before any provider is asked, never a crash", async () => {
    const committed = (await h.post("/v1/operations", orderBody())).body;
    asked = 0;
    const params = committed.order.params as Record<string, unknown>;
    for (const bad of [
      { amount: "abc" },
      { amount: undefined },
      { orderId: "0x01" },
      { assetType: 2 },
      { orderSigner: "nobody" },
      { executeDeadline: "soon" },
      { refundNoteDataHash: "0xab" },
    ]) {
      const body = { ...swapRequest(), provider: "thorchain", params: { ...params, ...bad } };
      expect(await refused("/v1/operations", body), JSON.stringify(bad)).toEqual({ status: 400, code: "invalid_request" });
    }
    expect(asked).toBe(0);
    expect(h.lines.some((l) => l.includes('"http.error"'))).toBe(false);
    // the well-formed params still restore the order
    const restored = await h.post("/v1/operations", { ...swapRequest(), provider: "thorchain", params });
    expect(restored.status).toBe(200);
    expect(restored.body.operationId).toBe(committed.operationId);
  });
});
