// What the database holds after a whole flow (spec v2.0 §15): the operation's row, its execution and its relayer job — and,
// once finalized, no trace of the destination, the refund secret, the one-time signer or an amount beyond the escrow's own
// (public once funded); a quote's row holds the pair, never an amount.
import { describe, expect, it } from "vitest";
import { DEST, ORDER_SIGNER, REFUND_SECRET, harness, orderBody, sign, swapRequest } from "./helpers";

describe("the database after a flow", () => {
  it("holds the operation, its execution and its job; after finalize nothing of the destination, the refund material or the signer", async () => {
    const h = await harness();
    try {
      await h.post("/v1/quotes", swapRequest());
      const c = await h.post("/v1/operations", orderBody());
      const id = c.body.operationId as string;
      const blob = h.store.blob(id)!;
      expect(blob, "before finalize the blob carries what prepare needs").toContain(DEST);
      const p = await h.post(`/v1/operations/${id}/prepare`, {});
      await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) });
      h.script.job = { state: "executed", executionTx: "0x" + "e1".repeat(32) };
      h.clock.now += 6_000;
      await h.post(`/v1/operations/${id}/reconcile`, {});
      const dump: Record<string, unknown[]> = {};
      for (const t of ["assets", "providers", "provider_health", "chain_state", "quotes", "operations", "executions", "relayer_jobs", "system_events"])
        dump[t] = h.store.db.prepare(`SELECT * FROM ${t}`).all();
      const all = JSON.stringify(dump);
      expect(all).not.toContain(DEST);
      expect(all).not.toContain(REFUND_SECRET);
      expect(all.toLowerCase()).not.toContain(ORDER_SIGNER.toLowerCase());
      expect(dump.operations).toEqual([expect.objectContaining({ id, kind: "cross-chain", order_blob: null, provider: "thorchain", network: "ethereum" })]);
      expect(dump.executions).toEqual([expect.objectContaining({ operation_id: id, execution_tx: "0x" + "e1".repeat(32) })]);
      expect(dump.relayer_jobs).toEqual([expect.objectContaining({ operation_id: id, state: "executed" })]);
      // the review round of 2026-11-03 (F6): the relayer dropped and re-sent the execution — its new hash is the authority (the stall
      // rule had compared against the dead one for good)
      h.script.job = { state: "executed", executionTx: "0x" + "e2".repeat(32) };
      h.clock.now += 6_000;
      await h.post(`/v1/operations/${id}/reconcile`, {});
      expect(h.store.db.prepare("SELECT execution_tx FROM executions WHERE operation_id = ?").get(id)).toEqual({ execution_tx: "0x" + "e2".repeat(32) });
      expect(dump.quotes).toEqual([expect.objectContaining({ pair: "ethereum:ETH>bitcoin:BTC", provider: "thorchain" })]);
      expect(Object.keys(dump.quotes[0] as object).sort()).toEqual(["created_at", "expires_at", "id", "pair", "provider", "tier"]);
      expect(JSON.stringify(dump.quotes), "no amount").not.toContain((10n ** 18n).toString());
    } finally {
      await h.close();
    }
  });
});
