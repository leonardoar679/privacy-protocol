// The eleventh review round (2026-11-04), part B — the swap service's reconcile: its write is judged against the row as it is when it writes, not
// as it was read before the reads (B11-6: a later-started reconcile whose provider read failed had moved a row another reconcile finalized meanwhile
// back to an earlier step), and a refused write answers the row as it is — its state, its settlement, its time — never the refused read's
// settlement beside the newer state (B11-7). The reviewer's probes (scratchpad review11/B) became these cases.
import { afterEach, describe, expect, it } from "vitest";
import { reconcileOperation, type ReconcileReads } from "../src/reconcile";
import { harness, orderBody, sign, type Harness } from "./helpers";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function finalized(): Promise<string> {
  h = await harness();
  const c = await h.post("/v1/operations", orderBody());
  const id = c.body.operationId as string;
  const p = await h.post(`/v1/operations/${id}/prepare`, {});
  expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
  return id;
}

describe("a reconcile's write and answer (B11-6, B11-7)", () => {
  it("a later-started reconcile whose provider read failed never moves a row another reconcile advanced meanwhile back", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!; // read before the other reconcile wrote
    const t1 = h!.clock.now + 1000;
    expect(h!.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: t1 })).toBe(true);
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "executed", executionTx: "0x" + "ee".repeat(32) }) as never,
      escrowBalance: async () => 0n,
      track: async () => {
        throw new Error("the provider is down");
      },
    };
    const r = await reconcileOperation(h!.store, snapshot, reads, t1 + 6000);
    expect(h!.store.getOperation(id)!.state, "never back along the execution").toBe("DESTINATION_CONFIRMING");
    expect(h!.store.getOperation(id)!.settlement, "a failed read keeps the last settlement, the row's").toBe("DESTINATION_PENDING");
    expect(r.state).toBe("DESTINATION_CONFIRMING");
  });

  it("a refused write answers the row as it is, with nothing of the refused read", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!;
    const t2 = h!.clock.now + 10_000;
    expect(h!.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: t2 })).toBe(true); // the later-started one wrote first
    const slow: ReconcileReads = { job: async () => null, escrowBalance: async () => 10n ** 30n, track: async () => null }; // its own read: the escrow funded
    const r = await reconcileOperation(h!.store, snapshot, slow, t2 - 5000);
    expect(r).toMatchObject({ state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING", refs: {} });
    expect(r.reason).toBeUndefined();
    expect(r.delayed).toBeUndefined();
    expect(r.checkedAt).toBe(t2);
  });

  it("a later-started reconcile whose relayer read failed never writes its start snapshot back over a row another reconcile moved on (the critique, C4)", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!; // still its creation state: finalize changes no state
    const t1 = h!.clock.now + 1000;
    expect(h!.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: t1 })).toBe(true);
    const down: ReconcileReads = {
      job: async () => {
        throw new Error("the relayer is unreachable");
      },
      escrowBalance: async () => 0n,
      track: async () => null,
    };
    const r = await reconcileOperation(h!.store, snapshot, down, t1 + 6000);
    expect(h!.store.getOperation(id)!.state, "the row as it is, never the snapshot's state").toBe("DESTINATION_CONFIRMING");
    expect(r.state).toBe("DESTINATION_CONFIRMING");
  });

  it("a later-started reconcile reading no job and no escrow derives from the row as it is: a finalized order never goes back before its submission (the second critique, T9)", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!;
    const t1 = h!.clock.now + 1000;
    expect(h!.store.updateState(id, { state: "PROVIDER_EXECUTING", settlement: null }, { startedAt: t1 })).toBe(true);
    const blind: ReconcileReads = { job: async () => "none", escrowBalance: async () => null, track: async () => null };
    await reconcileOperation(h!.store, snapshot, blind, t1 + 6000);
    expect(h!.store.getOperation(id)!.state).toBe("PROVIDER_EXECUTING");
  });

  it("a reconcile that writes back the row's own state logs no transition — another reconcile's move is logged once (the second critique, T10)", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!;
    const t1 = h!.clock.now + 1000;
    expect(h!.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: t1 })).toBe(true);
    const down: ReconcileReads = {
      job: async () => {
        throw new Error("the relayer is unreachable");
      },
      escrowBalance: async () => 0n,
      track: async () => null,
    };
    await reconcileOperation(h!.store, snapshot, down, t1 + 6000);
    const db = (h!.store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { n: number } } } }).db;
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM system_events WHERE event = ? AND operation_id = ?").get("operation.reconciled", id).n,
      "no transition of its own",
    ).toBe(0);
  });

  it("a refused read ahead of the row answers the row's settlement, never its own (the critique, T6)", async () => {
    const id = await finalized();
    const snapshot = h!.store.getOperation(id)!;
    const t2 = h!.clock.now + 10_000;
    expect(h!.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: t2 })).toBe(true);
    const ahead: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "completed", executionTx: "0x" + "ee".repeat(32) }) as never,
      escrowBalance: async () => 0n,
      track: async () => ({ state: "completed", destinationTxHash: "0x" + "dd".repeat(32) }) as never,
    };
    const r = await reconcileOperation(h!.store, snapshot, ahead, t2 - 5000);
    expect(r.settlement, "the row's, another reconcile's").toBe("DESTINATION_PENDING");
    expect(r.state).toBe("DESTINATION_CONFIRMING");
  });
});
