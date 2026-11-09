// The twelfth review round (2026-11-06), C12-5: a reconcile writes its job read only with a state it wrote. An earlier-started, slower
// reconcile whose state write is refused (B11-6) had written its older job read back — the relayer's dropped execution transaction — over the
// later-started one's, and a reconcile whose relayer read failed then asked the provider about the dead transaction. The reviewer's probe
// (scratchpad review12/C) became this case.
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

const TX1 = "0x" + "11".repeat(32); // the relayer's first execution, dropped
const TX2 = "0x" + "22".repeat(32); // the one it sent again (F6), which landed

describe("C12-5: a refused reconcile writes nothing of its job read", () => {
  it("the later-started reconcile records TX2; the slower, earlier one is refused its state and its job: TX2 stays the execution", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const t0 = h!.clock.now;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const asked: string[] = [];
    const slow: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "executing", executionTx: TX1 }) as never,
      escrowBalance: async () => 0n,
      track: async (_p, ref) => {
        asked.push(`slow:${ref.tx}`);
        await slowGate; // the provider answers it late
        return { state: "pending" } as never;
      },
    };
    const fast: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "executed", executionTx: TX2 }) as never,
      escrowBalance: async () => 0n,
      track: async (_p, ref) => {
        asked.push(`fast:${ref.tx}`);
        return { state: "destination-submitted", destinationTxHash: "0x" + "dd".repeat(32) } as never;
      },
    };
    const first = reconcileOperation(h!.store, row, slow, t0 + 1000); // started first
    await new Promise((r) => setTimeout(r, 10));
    const second = await reconcileOperation(h!.store, h!.store.getOperation(id)!, fast, t0 + 2000); // started later, done first
    expect(h!.store.execution(id)?.executionTx).toBe(TX2);
    releaseSlow();
    await first;
    expect(h!.store.getOperation(id)?.state, "its state write refused").toBe(second.state);
    expect(h!.store.execution(id)?.executionTx, "its job write refused with its state").toBe(TX2);
    // the next reconcile whose relayer read fails asks the provider about the transaction that landed
    const down: ReconcileReads = {
      job: async () => {
        throw new Error("relayer down");
      },
      escrowBalance: async () => 0n,
      track: async (_p, ref) => {
        asked.push(`down:${ref.tx}`);
        return { state: "unknown" } as never;
      },
    };
    await reconcileOperation(h!.store, h!.store.getOperation(id)!, down, t0 + 9000);
    expect(asked.at(-1)).toBe(`down:${TX2}`);
  });

  it("a refunded job after an execution, a refund held in the escrow since: the executor's to re-shield inside its watch, a late refund past it — never a terminal Refunded with its refund 'available' for good", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
    const row = h.store.getOperation(id)!;
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "refunded", executionTx: TX1, executed: true }) as never,
      escrowBalance: async () => (BigInt(row.amount) * 3n) / 10n,
      track: async () => ({ state: "refunded", refundedTo: "escrow" }) as never,
    };
    const inside = await reconcileOperation(h.store, row, reads, (row.refundAfter + 3600) * 1000);
    expect(inside.state).toBe("REFUNDING");
    expect(inside.settlement).toBe("REFUNDING");
    const past = await reconcileOperation(h.store, h.store.getOperation(id)!, reads, (row.refundAfter + 2 * 86_400) * 1000);
    expect(past).toMatchObject({ state: "RECOVERY_REQUIRED" });
    expect(past.reason?.code).toBe("late_refund");
    expect(past.settlement).toBe("REFUND_AVAILABLE");
  });

  it("the executor's late-refund watch ends 24 hours past the refund time: inside it a minute before, a late refund from that second (XU)", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "refunded", executionTx: TX1, executed: true }) as never,
      escrowBalance: async () => (BigInt(row.amount) * 3n) / 10n,
      track: async () => ({ state: "refunded", refundedTo: "escrow" }) as never,
    };
    const inside = await reconcileOperation(h!.store, row, reads, (row.refundAfter + 86_400 - 60) * 1000);
    expect([inside.state, inside.settlement]).toEqual(["REFUNDING", "REFUNDING"]);
    const past = await reconcileOperation(h!.store, h!.store.getOperation(id)!, reads, (row.refundAfter + 86_400) * 1000);
    expect(past).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "late_refund" }, settlement: "REFUND_AVAILABLE" });
  });

  it("a refunded job's leftover inside its watch beside a refund paid at the destination: its row refunding, and its settlement too — the API reads no refund token (XV)", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "refunded", executionTx: TX1, executed: true }) as never,
      escrowBalance: async () => (BigInt(row.amount) * 3n) / 10n,
      track: async () => ({ state: "refunded", refundedTo: "destination" }) as never,
    };
    const inside = await reconcileOperation(h!.store, row, reads, (row.refundAfter + 3600) * 1000);
    expect([inside.state, inside.settlement]).toEqual(["REFUNDING", "REFUNDING"]);
  });

  it("a completed job's late refund beside a refund paid at the destination: a late refund to return, as the wallet reads it — never a terminal COMPLETED (XU)", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "completed", executionTx: TX1, executed: true }) as never,
      escrowBalance: async () => (BigInt(row.amount) * 3n) / 10n,
      track: async () => ({ state: "refunded", refundedTo: "destination" }) as never,
    };
    const r = await reconcileOperation(h!.store, row, reads, (row.refundAfter + 2 * 86_400) * 1000);
    expect(r).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "late_refund" } });
  });

  it("the same with the provider saying it delivered in part: the refund held is read before the partial delivery — the executor's inside its watch, a late refund past it", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const reads: ReconcileReads = {
      job: async () => ({ id: "job-1", state: "refunded", executionTx: TX1, executed: true }) as never,
      escrowBalance: async () => (BigInt(row.amount) * 3n) / 10n,
      track: async () => ({ state: "partial" }) as never,
    };
    const inside = await reconcileOperation(h!.store, row, reads, (row.refundAfter + 3600) * 1000);
    expect(inside).toMatchObject({ state: "REFUNDING", settlement: "REFUNDING" });
    const past = await reconcileOperation(h!.store, h!.store.getOperation(id)!, reads, (row.refundAfter + 2 * 86_400) * 1000);
    expect(past).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "late_refund" } });
  });

  it("a refunded job's reconcile with the escrow unread settles nothing (XF's critique): REFUNDING, never a terminal REFUNDED frozen beside no settlement; read empty later, REFUNDED", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const job = async () => ({ id: "job-1", state: "refunded", executionTx: TX1, executed: true }) as never;
    const track = async () => ({ state: "refunded", refundedTo: "escrow" }) as never;
    const unread = await reconcileOperation(
      h!.store,
      row,
      {
        job,
        track,
        escrowBalance: async () => {
          throw new Error("the endpoint is down");
        },
      },
      (row.refundAfter + 3600) * 1000,
    );
    expect(unread.state).toBe("REFUNDING");
    const empty = await reconcileOperation(
      h!.store,
      h!.store.getOperation(id)!,
      { job, track, escrowBalance: async () => 0n },
      (row.refundAfter + 7200) * 1000,
    );
    expect(empty.state).toBe("REFUNDED");
    expect(empty.settlement).toBe("COMPLETED");
  });

  it("a bare 'refunded' for an order that never executed, its escrow still holding it: never REFUNDED — read as its funding says; read empty, REFUNDED", async () => {
    const id = await finalized();
    const row = h!.store.getOperation(id)!;
    const reads = (balance: bigint): ReconcileReads => ({
      job: async () => ({ id: "job-1", state: "refunded", executed: false }) as never,
      escrowBalance: async () => balance,
      track: async () => null as never,
    });
    const held = await reconcileOperation(h!.store, row, reads(BigInt(row.amount)), (row.executeDeadline - 60) * 1000);
    expect(held, "inside its window: executable, read as its funding says").toMatchObject({ state: "PROVIDER_EXECUTING" });
    const empty = await reconcileOperation(h!.store, h!.store.getOperation(id)!, reads(0n), (row.refundAfter + 60) * 1000);
    expect(empty.state).toBe("REFUNDED");
  });
});
