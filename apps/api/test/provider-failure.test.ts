// A provider's failure is a gateway's error (a V6 follow-up of 2026-10-14). The API answers 502 `provider_unavailable`
// and logs `provider.failed` with the provider, never the message. Before, a provider's outage or refusal at prepare, at
// track and on the guest routes was logged as the API's own error (500 "internal"). The local stack's log of that day
// held six such lines, and without a message it cannot tell what they were.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TipError } from "@privacy-wallet/swap-engine/tips";
import { harness, orderBody, swapRequest, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.close());

const logged = () => h.lines.map((l) => JSON.parse(l) as Record<string, string>);

describe("a provider's failure", () => {
  it("at prepare: 502 provider_unavailable, the provider logged and the operation kept for the next try", async () => {
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    const real = h.adapter.prepareIngress.bind(h.adapter);
    h.adapter.prepareIngress = async () => {
      throw new Error("THORNode quorum not reached: 1/2 gateways answered for ETH");
    };
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(502);
    expect(p.body).toEqual({ error: "THORNode quorum not reached: 1/2 gateways answered for ETH", code: "provider_unavailable" });
    const line = logged().find((l) => l.event === "provider.failed");
    expect(line).toMatchObject({ level: "warn", provider: "thorchain", state: "502", errorClass: "provider" });
    expect(h.lines.join("\n"), "the provider's message never reaches the log").not.toMatch(/quorum|gateways/);
    expect(
      logged().some((l) => l.event === "http.error"),
      "not the API's own error",
    ).toBe(false);
    h.adapter.prepareIngress = real;
    expect((await h.post(`/v1/operations/${id}/prepare`, {})).status, "the next try prepares").toBe(200);
  });

  it("the API's own error says nothing of itself; a provider's and the gas price's words keep only their URLs' hosts (2026-10-15)", async () => {
    const KEYED = "https://eth-mainnet.g.alchemy.com/v2/SECRET-KEY-123";
    // its own error: a viem error names the RPC's URL, its key in the path, and the request
    const quoteAll = h.deps.engine.quoteAll.bind(h.deps.engine);
    h.deps.engine.quoteAll = async () => {
      throw new Error(`HTTP request failed.\n\nURL: ${KEYED}\nRequest body: {"method":"eth_feeHistory"}`);
    };
    const q = await h.post("/v1/quotes", swapRequest());
    expect([q.status, q.body]).toEqual([500, { error: "internal error", code: "internal" }]);
    h.deps.engine.quoteAll = quoteAll;
    // a provider's failure naming a keyed URL
    const c = await h.post("/v1/operations", orderBody());
    h.adapter.prepareIngress = async () => {
      throw new Error("HTTP 401 from https://api.provider.example/v1/deposit?apiKey=SECRET-KEY-123");
    };
    const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
    expect([p.status, p.body]).toEqual([502, { error: "HTTP 401 from https://api.provider.example/…", code: "provider_unavailable" }]);
    // the gas price that cannot be read, when an order is committed
    const engine = h.deps.engine as unknown as { cfg: { tips: { tipFor: () => Promise<bigint> } } };
    engine.cfg.tips.tipFor = async () => {
      throw new TipError("fee_history_unavailable", `the gas price cannot be read: ${KEYED}: rate limited`);
    };
    const t = await h.post("/v1/operations", orderBody());
    expect(t.status).toBe(503);
    expect(t.body).toEqual({ error: "the gas price cannot be read: https://eth-mainnet.g.alchemy.com/…: rate limited", code: "fee_history_unavailable" });
    for (const r of [q, p, t]) expect(JSON.stringify(r.body)).not.toContain("SECRET-KEY-123");
  });

  it("a health check's words in the status and a quote set keep only their URLs' hosts (2026-10-15)", async () => {
    h.adapter.health = async () => {
      throw new Error("fetch failed for https://thornode.example/v2/SECRET-KEY-123");
    };
    const status = await h.get("/v1/status");
    expect(JSON.stringify(status.body)).toContain("https://thornode.example/…");
    // the unreachable provider's competition entry carries the same note
    const quoted = await h.post("/v1/quotes", swapRequest());
    expect(JSON.stringify(quoted.body.competition)).toContain("https://thornode.example/…");
    for (const r of [status, quoted]) expect(JSON.stringify(r.body)).not.toContain("SECRET-KEY-123");
  });

  it("a provider's refusal and a quote's hops keep only their URLs' hosts, in a quote set and a commit; the risk records keep their links", async () => {
    const KEY = "SECRET-KEY-123";
    const quote = h.adapter.quote.bind(h.adapter);
    h.adapter.quote = async () => {
      throw new Error(`HTTP 401 from https://thornode.example/v2/${KEY}`);
    };
    const refused = await h.post("/v1/quotes", swapRequest());
    expect(JSON.stringify(refused.body.errors)).toContain("https://thornode.example/…");
    // a quote whose hops name the keyed endpoint it came from
    h.adapter.quote = async (req) => ({ ...(await quote(req)), hops: [`ETH -> BTC (https://thornode.example/v2/${KEY})`] });
    const quoted = await h.post("/v1/quotes", swapRequest());
    expect(quoted.body.quotes[0].hops).toEqual(["ETH -> BTC (https://thornode.example/…)"]);
    const committed = await h.post("/v1/operations", orderBody());
    expect(committed.status).toBe(200);
    expect(committed.body.order.quote.hops).toEqual(["ETH -> BTC (https://thornode.example/…)"]);
    for (const r of [refused, quoted, committed]) expect(JSON.stringify(r.body)).not.toContain(KEY);
    // the risk records' sources are public links and stay whole
    expect(JSON.stringify((await h.get("/v1/risk/thorchain")).body)).toContain("https://github.com/thorchain/Resources/tree/master/Audits");
  });

  it("at track and on the guest routes: 502 provider_unavailable", async () => {
    h.adapter.track = async () => {
      throw new Error("HTTP 404 from https://gateway.liquify.com/chain/thorchain_api");
    };
    const t = await h.get(`/v1/track/thorchain?tx=0x${"12".repeat(32)}`);
    expect(t.status).toBe(502);
    expect(t.body.code).toBe("provider_unavailable");
    const g = await h.get(`/v1/guest/track/thorchain/${"ab".repeat(32)}`);
    expect(g.status).toBe(502);
    expect(g.body.code).toBe("provider_unavailable");
    expect(logged().filter((l) => l.event === "provider.failed")).toHaveLength(2);
  });
});
