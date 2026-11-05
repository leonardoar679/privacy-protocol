// The ninth review round (2026-11-04): the swap service. A restore of a known order (or of a funded escrow) is never refused by the cap
// nor charged to the caller's commit budget (A9-3); the checkpoint never waits for a reader (A9-4); a refunded executed job reads as the
// wallet reads it (A9-6); a reconcile writes only over the row it read and never moves a row back along the execution (A9-7); the one-time
// vacuum runs once (A9-9); no blob comes back past its deadline (A9-11); an escrow deployed bare moves nothing, its own executed flag says
// it executed (A9-12). The reviewer's probes (scratchpad review9/A P3, P5, P6, P7b, P10, P11) became these cases.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { VACUUMED_ONCE, checkpoint, openDb, purge } from "../src/db";
import { stateFrom } from "../src/reconcile";
import { harness, orderBody, sign, signedRestore, swapRequest, type Harness } from "./helpers";

// node:sqlite is a prefix-only builtin the test runner's resolver does not know (src/db.ts, test/schema.test.ts)
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const dbOf = (x: Harness): Database => (x.store as unknown as { db: Database }).db;

describe("A9-3: a restore at the cap and against the commit budget", () => {
  it("of a known order: answered at the cap, never charged to the budget", async () => {
    h = await harness({ maxOpenOperations: 1, commitsPerMinute: 1, commitBurst: 1 });
    const c = await h.post("/v1/operations", orderBody());
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const restore = signedRestore({ ...swapRequest(), provider: "thorchain", params: c.body.order.params });
    for (let i = 0; i < 3; i++) {
      const r = await h.post("/v1/operations", restore);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.operationId).toBe(c.body.operationId);
    }
    expect((await h.post("/v1/operations", orderBody())).status, "a new commit still meets the budget").toBe(429);
  });

  it("a body naming a known order with other params is no restore of it: charged to the budget like any commit (the tenth review round, B10-12)", async () => {
    h = await harness({ commitsPerMinute: 1, commitBurst: 1 });
    const c = await h.post("/v1/operations", orderBody());
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const params = { ...c.body.order.params, executeDeadline: String(Number(c.body.order.params.executeDeadline) + 60) };
    const r = await h.post("/v1/operations", signedRestore({ ...swapRequest(), provider: "thorchain", params }));
    expect(r.status, "the order id is public; its escrow is the known row's only with its own params").toBe(429);
    const same = await h.post("/v1/operations", signedRestore({ ...swapRequest(), provider: "thorchain", params: c.body.order.params }));
    expect(same.status, "its own params: the known restore").toBe(200);
  });

  it("of an order the API no longer holds: refused at the cap unless its escrow holds the funding", async () => {
    h = await harness({ maxOpenOperations: 1 });
    const c1 = await h.post("/v1/operations", orderBody());
    expect(c1.status).toBe(200);
    dbOf(h).prepare("DELETE FROM operations").run(); // a database reset, a purged row, another instance
    expect((await h.post("/v1/operations", orderBody())).status, "the cap filled again by another commit").toBe(200);
    const restore = signedRestore({ ...swapRequest(), provider: "thorchain", params: c1.body.order.params });
    h.script.balance = 0n;
    const refused = await h.post("/v1/operations", restore);
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("service_capacity");
    h.script.balance = BigInt(c1.body.order.params.amount);
    const funded = await h.post("/v1/operations", restore);
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  });
});

describe("A9-4: the checkpoint never waits for a reader", () => {
  it("returns at once while another connection holds a read transaction, and the busy timeout is restored", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-checkpoint-"));
    const file = join(dir, "api.sqlite");
    const db = openDb(file);
    const reader = new DatabaseSync(file);
    try {
      db.prepare("CREATE TABLE IF NOT EXISTS t (x INTEGER)").run();
      db.prepare("INSERT INTO t VALUES (1)").run();
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) AS n FROM t").get();
      const t0 = Date.now();
      checkpoint(db);
      expect(Date.now() - t0, "no 5 s stall").toBeLessThan(1000);
      expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
      reader.exec("COMMIT");
    } finally {
      reader.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A9-6: a refunded executed job reads as the wallet reads it", () => {
  const row = { state: "PROVIDER_EXECUTING" as const, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, amount: "1000" };
  it("mined only on the relayer's own flag; delivered in part with delivered units or the provider's word of a delivery (the eleventh review round's K4 critique)", () => {
    const now = 1_900_000_000;
    expect(stateFrom(row, { state: "refunded", executionTx: "0x" + "ee".repeat(32) }, null, null, now).state, "a reverted execution: refunded").toBe(
      "REFUNDED",
    );
    const executed = { state: "refunded" as const, executed: true, executionTx: "0x" + "ee".repeat(32) };
    expect(stateFrom(row, executed, null, null, now).state, "the provider unread: nothing final").toBe("REFUNDING");
    for (const state of ["completed", "destination-final", "partial"])
      expect(stateFrom(row, executed, { state }, null, now), `${state} without an amount: part was delivered (K4)`).toEqual({
        state: "RECOVERY_REQUIRED",
        code: "partial_delivery",
      });
    expect(stateFrom(row, executed, { state: "destination-submitted" }, null, now).state, "a delivery on its way: nothing final (K4)").toBe("REFUNDING");
    for (const state of ["refunded", "failed"]) expect(stateFrom(row, executed, { state }, null, now).state, `${state}: nothing delivered`).toBe("REFUNDED");
    for (const state of ["unknown", "pending", "executing"])
      expect(stateFrom(row, executed, { state }, null, now).state, `${state}: tells nothing, read again (K4's third critique)`).toBe("REFUNDING");
    expect(stateFrom(row, executed, { state: "refunded", deliveredAmount: "5" }, null, now)).toEqual({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
  });
});

describe("A9-12: an escrow deployed bare", () => {
  const row = { state: "AWAITING_AUTHORIZATION" as const, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, amount: "1000" };
  it("moves nothing before its funding; its own executed flag says it executed", () => {
    const now = 1_900_000_000;
    expect(stateFrom(row, null, null, false, now, false, true, { deployed: true, executed: false }).state).toBe("AWAITING_AUTHORIZATION");
    expect(stateFrom(row, null, null, false, now, false, true, { deployed: true, executed: true }).state).toBe("PROVIDER_EXECUTING");
    expect(
      stateFrom({ ...row, state: "PROVIDER_EXECUTING" }, null, null, false, now, false, true, { deployed: true, executed: false }).state,
      "after its funding: refunded by anyone",
    ).toBe("REFUNDING");
  });
});

describe("A9-7: a reconcile writes over the row it read only, never backwards", () => {
  it("a write over a row changed since it was read is refused; a terminal row stays", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    const at = h.store.getOperation(id)!.updatedAt;
    h.clock.now += 1000;
    expect(h.store.updateState(id, { state: "COMPLETED", settlement: "COMPLETED" })).toBe(true);
    h.clock.now += 1000;
    expect(h.store.updateState(id, { state: "AWAITING_AUTHORIZATION", settlement: null }, { unchangedSince: at }), "a snapshot from before").toBe(false);
    expect(h.store.updateState(id, { state: "PROVIDER_EXECUTING", settlement: null }), "nor over a terminal row").toBe(false);
    expect(h.store.getOperation(id)!.state).toBe("COMPLETED");
  });
  it("two reconciles that overlapped: the later-started one's answer stands whichever writes first (the tenth review round, B10-12)", async () => {
    h = await harness();
    const id = (await h.post("/v1/operations", orderBody())).body.operationId as string;
    const older = h.clock.now;
    const newer = older + 500;
    h.clock.now = newer + 2000;
    // the older-started writes first: the newer one's terminal answer is written over it — refused by the row it read before
    expect(h.store.updateState(id, { state: "PROVIDER_EXECUTING", settlement: null }, { startedAt: older })).toBe(true);
    expect(h.store.updateState(id, { state: "COMPLETED", settlement: "COMPLETED" }, { startedAt: newer })).toBe(true);
    expect(h.store.getOperation(id)!.state).toBe("COMPLETED");
    // the newer-started writes first: an older snapshot after it is refused
    const other = (await h.post("/v1/operations", orderBody({ refundOwnerCommitment: "1234567891" }))).body.operationId as string;
    expect(h.store.updateState(other, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" }, { startedAt: newer })).toBe(true);
    expect(h.store.updateState(other, { state: "PROVIDER_EXECUTING", settlement: null }, { startedAt: older }), "an older snapshot").toBe(false);
    expect(h.store.getOperation(other)!.state).toBe("DESTINATION_CONFIRMING");
  });

  it("a job read 'none' leaves a finalized row past the provider's step where it was", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
    h.store.updateState(id, { state: "DESTINATION_CONFIRMING", settlement: "DESTINATION_PENDING" });
    h.script.job = "none";
    h.script.balance = 0n;
    h.clock.now += 10_000;
    await h.post(`/v1/operations/${id}/reconcile`, {});
    expect(h.store.getOperation(id)!.state).toBe("DESTINATION_CONFIRMING");
  });
});

describe("A9-9: the one-time vacuum runs once", () => {
  it("at the first purge, which marks the file; a later purge leaves its free pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-vacuum-"));
    const file = join(dir, "api.sqlite");
    try {
      const db = openDb(file);
      const appId = () => (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      const free = () => Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
      const bloat = () => {
        db.prepare("CREATE TABLE IF NOT EXISTS junk (x BLOB)").run();
        for (let i = 0; i < 50; i++) db.prepare("INSERT INTO junk VALUES (?)").run(new Uint8Array(4096));
        db.prepare("DELETE FROM junk").run();
        checkpoint(db);
      };
      expect(appId(), "not at open: the purge decides").toBe(0);
      bloat();
      expect(free()).toBeGreaterThan(0);
      purge(db, Date.now());
      expect(appId()).toBe(VACUUMED_ONCE);
      expect(free(), "vacuumed once").toBe(0);
      bloat();
      const left = free();
      purge(db, Date.now());
      expect(free(), "no vacuum at a later purge").toBe(left);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A9-11: no blob comes back past its deadline", () => {
  it("a resume or a restore after the execution deadline writes nothing back", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    const id = c.body.operationId as string;
    h.clock.now = (Number(c.body.order.params.executeDeadline) + 60) * 1000;
    h.store.purge(); // the blob goes at the deadline
    expect(h.store.blob(id)).toBeNull();
    expect(h.store.setBlobUnlessFinalized(id, "{}")).toBe(false);
    expect(h.store.setRestoredBlob(id, "{}", null)).toBe(false);
  });
});
