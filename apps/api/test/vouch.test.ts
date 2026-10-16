// The API vouches for what a relayer may execute (a V6 follow-up of 2026-10-16; audit gap 47; spec v2.0 §15): the escrow of
// each order it commits, and at the finalize the provider call it prepared — only for an order whose commit vouch the
// wallet shows, so an order rebuilt from anyone's params gets none. Without API_VOUCH_KEY it vouches for nothing.
import { afterEach, describe, expect, it } from "vitest";
import { executionVouchDigest, orderVouchDigest, vouchedBy } from "@privacy-wallet/swap-engine/endpoints";
import { makeVoucher, voucherFrom } from "../src/vouch";
import { harness, orderBody, sign, type Harness } from "./helpers";

const KEY = ("0x" + "5a".repeat(32)) as `0x${string}`;
const VOUCHER = makeVoucher(KEY).address;
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("the API's vouches", () => {
  it("vouches for the escrow of the order it commits, and names its address in the status", async () => {
    h = await harness({ vouchKey: KEY });
    const c = await h.post("/v1/operations", orderBody());
    expect(c.status).toBe(200);
    expect(vouchedBy(VOUCHER, orderVouchDigest(1n, c.body.order.endpoint), c.body.vouch.order)).toBe(true);
    expect((await h.get("/v1/status")).body.deployment.voucher).toBe(VOUCHER);
  });

  it("vouches for the call it prepared only when the wallet shows the order's vouch, and finalizes nothing without it", async () => {
    h = await harness({ vouchKey: KEY });
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    const signature = sign(p.body.digest);
    for (const vouch of [undefined, "0x" + "11".repeat(65), makeVoucher(("0x" + "5b".repeat(32)) as `0x${string}`).order(1n, c.body.order.endpoint)]) {
      const refused = await h.post(`/v1/operations/${id}/finalize`, { signature, ...(vouch ? { vouch } : {}) });
      expect([refused.status, refused.body.code], String(vouch)).toEqual([400, "unvouched_order"]);
      expect(h.store.blob(id), "nothing finalized").not.toBeNull();
    }
    const f = await h.post(`/v1/operations/${id}/finalize`, { signature, vouch: c.body.vouch.order });
    expect(f.status).toBe(200);
    const x = f.body.execution;
    const digest = executionVouchDigest(1n, c.body.order.endpoint, x.provider, BigInt(x.value), x.providerCalldata, Number(x.deadline));
    expect(vouchedBy(VOUCHER, digest, f.body.vouch.execution), "the call it prepared, for this escrow").toBe(true);
  });

  it("an order rebuilt from params gets no vouch: a restore answers none, and its call is vouched for only with the commit's", async () => {
    h = await harness({ vouchKey: KEY });
    const c = await h.post("/v1/operations", orderBody());
    const restored = await h.post("/v1/operations", { ...orderBody(), provider: "thorchain", params: c.body.order.params });
    expect(restored.status).toBe(200);
    expect(restored.body.vouch, "a restore vouches for nothing").toBeUndefined();
  });

  it("without API_VOUCH_KEY it vouches for nothing and asks for nothing; a malformed key stops the start, unechoed", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    expect(c.body.vouch).toBeUndefined();
    const id = c.body.operationId as string;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    const f = await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) });
    expect([f.status, f.body.vouch]).toEqual([200, undefined]);
    expect((await h.get("/v1/status")).body.deployment.voucher).toBeNull();
    expect(voucherFrom(undefined)).toBeNull();
    expect(voucherFrom(" ")).toBeNull();
    for (const bad of ["0x1234", "5a".repeat(32), "0x" + "zz".repeat(32), "0x" + "00".repeat(32)]) {
      let message = "";
      try {
        voucherFrom(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/^API_VOUCH_KEY (must be 32 bytes of hex|is not a usable secp256k1 key)/);
      expect(message, "the key is never echoed").not.toContain(bad.slice(2, 20));
    }
  });
});
