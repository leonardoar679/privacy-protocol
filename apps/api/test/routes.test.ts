// The routes (spec v2.0 §15): a quote is the engine's set with a `qt_` id and the §46 quote with exactly its keys; an
// operation is created at commit with an `op_` id, read back without the order, prepared, finalized (the blob gone),
// resumed from the journaled params and found again by a restore; there is no listing and an order id is never an id;
// the registries, the status, the risk view, the track and the guest quote answer.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPERATION_ID, QUOTE_ID } from "../src/ids";
import { harness, orderBody, sign, swapRequest, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness({ terms: { minFeeWei: "1000000000000000", feeVaults: [] } });
});
afterEach(() => h.close());

describe("quotes", () => {
  it("POST /v1/quotes: the set as before, a qt_ id, and the §46 quote with exactly its keys, every fee in the source asset", async () => {
    const r = await h.post("/v1/quotes", swapRequest());
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(QUOTE_ID);
    expect(r.body.quotes).toHaveLength(1);
    expect(r.body.chosen.provider).toBe("thorchain");
    const q = r.body.quote;
    expect(Object.keys(q).sort()).toEqual([
      "destinationAsset",
      "estimatedSeconds",
      "expectedOutput",
      "expiresAt",
      "id",
      "inputAmount",
      "minimumOutput",
      "privacy",
      "privacyFee",
      "providerFee",
      "relayerFee",
      "risk",
      "sourceAsset",
      "totalFee",
    ]);
    expect(q.id).toBe(r.body.id);
    expect(q.inputAmount).toBe((10n ** 18n).toString());
    expect(q.privacyFee, "1 % of the input, rounded up").toBe((10n ** 16n).toString());
    expect(q.relayerFee, "F = the relayer's minimum + 10 %, plus the executor tip").toBe((11n * 10n ** 14n + 25n * 10n ** 14n).toString());
    expect(BigInt(q.totalFee)).toBe(BigInt(q.privacyFee) + BigInt(q.relayerFee) + BigInt(q.providerFee));
    expect(q.sourceAsset.symbol).toBe("ETH");
    expect(q.destinationAsset.symbol).toBe("BTC");
    expect(Object.keys(q.risk).sort()).toEqual(["blockers", "level", "score", "warnings"]);
    expect(q.risk.blockers).toEqual([]);
    expect(q.risk.warnings).toContain("cross_chain");
    expect(["low", "medium", "high"]).toContain(q.privacy.level);
    const row = h.store.db.prepare("SELECT * FROM quotes").all();
    expect(row).toHaveLength(1);
    expect(JSON.stringify(row), "a quote row holds no amount and no destination").not.toMatch(/1000000000000000000|bc1q/);
  });
  it("a request that is not a request is a 400 with invalid_request", async () => {
    const r = await h.post("/v1/quotes", { from: "ETH" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("invalid_request");
  });
});

describe("operations", () => {
  it("create → read → prepare → finalize: the op_ id, the record without the order, the digest, the execution; the blob is gone after finalize", async () => {
    const c = await h.post("/v1/operations", orderBody());
    expect(c.status).toBe(200);
    const id = c.body.operationId as string;
    expect(id).toMatch(OPERATION_ID);
    expect(c.body.order.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.body.order.params.executorTip).toBe((25n * 10n ** 14n).toString());
    const g = await h.get(`/v1/operations/${id}`);
    expect(g.status).toBe(200);
    expect(Object.keys(g.body).sort()).toEqual(["checkedAt", "createdAt", "id", "kind", "provider", "settlement", "state", "tier", "updatedAt"]);
    expect(g.body).toMatchObject({ id, kind: "cross-chain", state: "AWAITING_SIGNATURE", provider: "thorchain", settlement: null });
    expect(JSON.stringify(g.body), "never the order id, the escrow or the destination").not.toMatch(
      new RegExp(`${c.body.order.orderId}|${c.body.order.endpoint}|bc1q`, "i"),
    );
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(200);
    expect(p.body.digest).toMatch(/^0x[0-9a-f]{64}$/);
    const f = await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) });
    expect(f.status).toBe(200);
    expect(f.body.execution.signature).toBe(sign(p.body.digest));
    expect(h.store.blob(id), "the destination and the refund material are gone").toBeNull();
    const again = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(again.status, "finalized: the wallet resumes from its journal to sign again").toBe(404);
    expect(again.body.code).toBe("unknown_order");
  });
  it("finalize refuses a signature that is not the order signer's, and an order not prepared", async () => {
    const { body } = await h.post("/v1/operations", orderBody());
    const id = body.operationId as string;
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: "0x" + "11".repeat(65) })).body.code).toBe("order_not_prepared");
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    const wrong = await h.post(`/v1/operations/${id}/finalize`, { signature: "0x" + "22".repeat(65) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("invalid_request");
    expect(h.store.blob(id), "a refused finalize keeps the blob").not.toBeNull();
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
  });
  it("resume and restore after finalize answer the order but keep no destination; a re-sign brings the params with its prepare; another order's params are refused", async () => {
    const { body } = await h.post("/v1/operations", orderBody());
    const id = body.operationId as string;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) });
    const journaled = { ...swapRequest(), provider: "thorchain", params: body.order.params };
    const r = await h.post(`/v1/operations/${id}/resume`, journaled);
    expect(r.status).toBe(200);
    expect(r.body.operationId).toBe(id);
    expect(r.body.order.endpoint).toBe(body.order.endpoint);
    expect(h.store.blob(id), "finalized: a resume keeps no destination").toBeNull();
    const restored = await h.post("/v1/operations", journaled);
    expect(restored.body.operationId, "the same order is the same operation").toBe(id);
    expect(h.store.blob(id), "nor a restore").toBeNull();
    expect((await h.post(`/v1/operations/${id}/prepare`, {})).status, "a re-sign without the params: unknown here").toBe(404);
    const again = await h.post(`/v1/operations/${id}/prepare`, { restore: journaled });
    expect(again.status, "a re-sign with the journaled params").toBe(200);
    expect(h.store.blob(id)).not.toBeNull();
    await h.post(`/v1/operations/${id}/finalize`, { signature: sign(again.body.digest) });
    expect(h.store.blob(id), "and gone again at its finalize").toBeNull();
    const other = await h.post("/v1/operations", orderBody());
    const mismatch = await h.post(`/v1/operations/${other.body.operationId}/resume`, journaled);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("order_mismatch");
    expect((await h.post(`/v1/operations/op_${"a".repeat(26)}/resume`, journaled)).status, "an unknown operation: the wallet restores").toBe(404);
  });
  it("no listing, and an order id is never an id: only op_ ids resolve", async () => {
    const { body } = await h.post("/v1/operations", orderBody());
    expect((await h.get("/v1/operations")).status).toBe(404);
    expect((await h.get(`/v1/operations/${body.order.orderId}`)).status).toBe(404);
    expect((await h.get(`/v1/operations/${body.order.orderId}`)).body.code).toBe("unknown_order");
    expect((await h.get("/v1/operations/op_short")).status).toBe(404);
  });
});

describe("the registries, the status, the risk view, the track, the guest quote", () => {
  it("answer from the registries and the engine", async () => {
    const assets = await h.get("/v1/assets");
    expect(assets.status).toBe(200);
    expect(Array.isArray(assets.body.assets)).toBe(true);
    const networks = await h.get("/v1/networks");
    expect(networks.body.networks.map((n: { id: string }) => n.id)).toContain("ethereum");
    const status = await h.get("/v1/status");
    expect(status.body.deployment.factory).toBe("0x00000000000000000000000000000000000000f1");
    expect(status.body.providers.thorchain.reachable).toBe(true);
    h.store.recordHealth("thorchain", { reachable: false, halted: false });
    const health = await h.get("/v1/providers/health");
    expect(health.body.providers[0]).toMatchObject({ provider: "thorchain", reachable: false, recentFailures: 1 });
    expect((await h.get("/v1/risk")).body.providers.map((p: { provider: string }) => p.provider)).toEqual(["thorchain"]);
    expect((await h.get("/v1/risk/nobody")).status).toBe(404);
    expect((await h.get("/v1/track/thorchain")).status, "tx or ref is required").toBe(400);
    expect((await h.get(`/v1/track/thorchain?tx=0x${"12".repeat(32)}`)).body).toMatchObject({ track: { state: "pending" }, status: "Pending" });
    expect((await h.post("/v1/guest/quote", swapRequest())).body.quotes).toHaveLength(1);
    expect((await h.get("/v1/gateway/health")).status).toBe(200);
  });
});

describe("the metered quote gateway, once it has an upstream (a V6 follow-up of 2026-10-15)", () => {
  it("answers the quote set as /v1/quotes does; a missing key is 401, a malformed body the caller's 400, an upstream's error without a key", async () => {
    await h.close();
    h = await harness({ gatewayUpstream: "zkapi-test:private-swap" });
    const key = { authorization: "zkapi rk_0123456789abcdef" };
    expect((await h.post("/v1/gateway/quote", swapRequest())).status, "no runtime key").toBe(401);
    const ok = await h.post("/v1/gateway/quote", swapRequest(), key);
    expect(ok.status, "the quote set's bigints went to res.json raw: a 500").toBe(200);
    expect(ok.body.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(ok.body.result.quotes).toHaveLength(1);
    expect(typeof ok.body.result.quotes[0].toAmountMin, "a bigint as a string").toBe("string");
    const bad = await h.post("/v1/gateway/quote", { nope: true }, key);
    expect([bad.status, bad.body.code], "the caller's mistake, not the upstream's").toEqual([400, "invalid_request"]);
    h.adapter.quote = async () => {
      throw new Error("HTTP 401 from https://thornode.example/v2/SECRET-KEY-123");
    };
    const refused = await h.post("/v1/gateway/quote", swapRequest(), key);
    expect(JSON.stringify(refused.body)).toContain("https://thornode.example/…");
    expect(JSON.stringify(refused.body)).not.toContain("SECRET-KEY-123");
  });
});
