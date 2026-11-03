// Reconcile (spec v2.0 §12.4–§12.5, §15): the API reads the relayer's job, the escrow's balance and the provider's track and
// answers { state, settlement, refs, checkedAt, sources } with the wallet's derivation — the legs of doc §82 one by one: the
// funding confirmed, the provider executing, the destination pending, completed (terminal, stamped, final), the relayer
// unreachable (nothing downgraded), the execution failed (the refund available), a reorg (the funding pending again), an
// unfunded order past its window; one read per 5 s; a cost above 1.5 × the tip logged once as fee.deviation, no amount.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECONCILE_THROTTLE_MS, SwapApi } from "../src/routes/swap";
import { stateFrom } from "../src/reconcile";
import { harness, orderBody, TIP, type Harness } from "./helpers";

let h: Harness;
let id: string;
let amount: bigint;
const EXEC = "0x" + "e1".repeat(32);
beforeEach(async () => {
  h = await harness();
  const c = await h.post("/v1/operations", orderBody());
  id = c.body.operationId;
  amount = BigInt(c.body.order.params.amount);
});
afterEach(() => h.close());

/** reconcile now, past the throttle */
async function reconcile(): Promise<{ status: number; body: any }> {
  h.clock.now += 6_000;
  return h.post(`/v1/operations/${id}/reconcile`, {});
}

describe("reconcile — the legs of doc §82", () => {
  it("funded, then executing, then the destination pending, then completed: the state and the settlement follow; completed is final and stamped", async () => {
    h.script.balance = amount;
    let r = await reconcile();
    expect(r.body).toMatchObject({ state: "PROVIDER_EXECUTING", settlement: "SOURCE_CONFIRMED", sources: { relayer: "none", chain: "ok", provider: "none" } });
    h.script.job = { state: "executed", executionTx: EXEC };
    h.script.balance = 0n;
    r = await reconcile();
    expect(r.body).toMatchObject({
      state: "PROVIDER_EXECUTING",
      settlement: "PROVIDER_PENDING",
      refs: { executionTx: EXEC },
      sources: { relayer: "ok", provider: "ok" },
    });
    h.adapter.track_ = { state: "destination-submitted", destinationTxHash: "dest-tx-1" };
    r = await reconcile();
    expect(r.body).toMatchObject({ state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING", refs: { destinationTx: "dest-tx-1" } });
    h.script.job = { state: "completed", executionTx: EXEC };
    h.adapter.track_ = { state: "completed" };
    r = await reconcile();
    expect(r.body).toMatchObject({ state: "COMPLETED", settlement: "COMPLETED" });
    const row = h.store.getOperation(id)!;
    expect(row.terminalAt).not.toBeNull();
    h.script.job = { state: "executing" };
    r = await reconcile();
    expect(r.body.state, "I-O1: a terminal state never changes").toBe("COMPLETED");
    expect(h.store.db.prepare("SELECT state, execution_tx FROM relayer_jobs WHERE operation_id = ?").get(id)).toEqual({
      state: "executing",
      execution_tx: EXEC,
    });
  });
  it("a job the executor stopped watching is completed only on the provider's word; a refund back after its watch is the wallet's to return (audit round 2, r36)", async () => {
    h.script.job = { state: "completed", executionTx: EXEC };
    h.script.balance = 0n;
    h.adapter.track_ = { state: "destination-submitted", destinationTxHash: "dest-tx-1" };
    let r = await reconcile();
    expect(r.body).toMatchObject({ state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" });
    expect(h.store.getOperation(id)!.terminalAt, "still open").toBeNull();
    h.script.balance = amount / 2n; // the provider's refund lands days later
    r = await reconcile();
    expect(r.body).toMatchObject({ state: "RECOVERY_REQUIRED", settlement: "REFUND_AVAILABLE", reason: { code: "late_refund" } });
  });
  it("the relayer unreachable: the state and the settlement are kept, never downgraded", async () => {
    h.script.job = { state: "executed", executionTx: EXEC };
    await reconcile();
    const before = h.store.getOperation(id)!;
    h.script.job = null;
    const r = await reconcile();
    expect(r.body).toMatchObject({ state: before.state, settlement: before.settlement, sources: { relayer: "unreachable" } });
  });
  it("the execution failed with the escrow funded: recovery with the refund available", async () => {
    h.script.job = { state: "execute-failed" };
    h.script.balance = amount;
    const r = await reconcile();
    expect(r.body).toMatchObject({ state: "RECOVERY_REQUIRED", settlement: "REFUND_AVAILABLE", reason: { code: "execute_failed" } });
  });
  it("a reorg: the escrow funded, then empty again with no job — the funding is pending again, nothing re-sent", async () => {
    h.script.balance = amount;
    await reconcile();
    h.script.balance = 0n;
    const r = await reconcile();
    expect(r.body).toMatchObject({ state: "SOURCE_CONFIRMING", settlement: null });
  });
  it("an unfunded order past its window expired before it moved; a funded one past its window is a delay with the refund available", async () => {
    const row = h.store.getOperation(id)!;
    h.clock.now = (row.executeDeadline + 60) * 1000;
    h.script.balance = 0n;
    let r = await reconcile();
    expect(
      r.body,
      "past its window, before its refund time: waits — a funding in the mempool at the deadline still lands (the review round of 2026-11-02)",
    ).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "order_expired" }, settlement: null });
    h.clock.now = (row.refundAfter + 1) * 1000;
    r = await reconcile();
    expect(r.body, "past its refund time: closed, nothing moved").toMatchObject({ state: "CANCELLED", reason: { code: "order_expired" }, settlement: null });
    const c = await h.post("/v1/operations", orderBody());
    id = c.body.operationId;
    h.clock.now = (h.store.getOperation(id)!.executeDeadline + 60) * 1000;
    h.script.balance = BigInt(c.body.order.params.amount);
    r = await reconcile();
    expect(r.body).toMatchObject({ state: "PROVIDER_EXECUTING", delayed: { code: "provider_timeout" }, settlement: "REFUND_AVAILABLE" });
  });
  it("a lapsed job — the executor's watch ended with the escrow empty, never executed — reads REFUNDING past the funding, never 'the funding is pending again' (the review round of 2026-11-03, F3)", () => {
    const row = { state: "REFUNDING" as const, executeDeadline: 1_800_000_000, refundAfter: 1_800_007_200, amount: "1" };
    const lapsed = { state: "lapsed" } as never;
    expect(stateFrom(row, lapsed, null, false, 1_800_010_000)).toEqual({ state: "REFUNDING" });
    expect(stateFrom({ ...row, state: "PROVIDER_EXECUTING" }, lapsed, null, false, 1_800_010_000)).toEqual({ state: "REFUNDING" });
    // before the funding the expiry rule decides: past the refund time the order is cancelled as expired
    expect(stateFrom({ ...row, state: "AWAITING_AUTHORIZATION" }, lapsed, null, false, 1_800_010_000)).toEqual({ state: "CANCELLED", code: "order_expired" });
  });
  it("one read per operation per 5 s: a second call inside the window answers the last result", async () => {
    h.script.balance = amount;
    const first = await reconcile();
    h.script.balance = 0n;
    const second = await h.post(`/v1/operations/${id}/reconcile`, {});
    expect(second.body).toEqual(first.body);
    expect((await h.post(`/v1/operations/op_${"b".repeat(26)}/reconcile`, {})).status).toBe(404);
  });
  it("the throttle keeps an answer only while it serves it: nothing of an operation stays in memory past the window", async () => {
    const api = new SwapApi(h.deps);
    const held = () => (api as unknown as { reconciled: Map<string, unknown> }).reconciled;
    const other = (await h.post("/v1/operations", orderBody())).body.operationId as string;
    await api.reconcile(id);
    expect([...held().keys()]).toEqual([id]);
    h.clock.now += RECONCILE_THROTTLE_MS;
    await api.reconcile(other);
    expect([...held().keys()], "the first answer is gone once the throttle no longer serves it").toEqual([other]);
  });
  it("a relayer cost above 1.5 × the committed tip of an ETH order is logged once as fee.deviation, without an amount", async () => {
    h.script.job = { state: "executed", executionTx: EXEC, actualNetworkWei: ((TIP * 3n) / 2n + 1n).toString() };
    await reconcile();
    await reconcile();
    const lines = h.lines.map((l) => JSON.parse(l)).filter((l) => l.event === "fee.deviation");
    expect(lines).toEqual([
      {
        at: expect.any(String),
        level: "warn",
        event: "fee.deviation",
        operationId: id,
        provider: "thorchain",
        errorClass: "execution_above_tip",
        network: "ethereum",
      },
    ]);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM system_events WHERE event = 'fee.deviation'").get()).toEqual({ n: 1 });
  });
});
