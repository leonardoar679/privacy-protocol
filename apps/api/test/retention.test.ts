// Retention (spec v2.0 §15): quotes 1 h after their expiry, terminal operations after 7 days, an abandoned operation 2 days
// after its refund window, an operation never seen funded an hour after its execution deadline and every blob at that deadline (the
// eighth review round), events after 7 days, provider health after 48 h — and nothing younger.
import { describe, expect, it } from "vitest";
import { openDb, purge, RETENTION } from "../src/db";

const H = 3_600_000,
  D = 24 * H;
const NOW = 1_800_000_000_000;

describe("retention", () => {
  it("deletes exactly what is past its window", () => {
    const db = openDb(":memory:");
    db.exec("INSERT INTO providers (id, enabled, updated_at) VALUES ('thorchain', 1, 0)");
    const q = db.prepare("INSERT INTO quotes (id, created_at, expires_at, provider, pair, tier) VALUES (?, 0, ?, 'thorchain', 'a>b', NULL)");
    q.run("qt_old", Math.floor((NOW - H - 1_000) / 1000));
    q.run("qt_fresh", Math.floor((NOW - H + 60_000) / 1000));
    const op = db.prepare(
      "INSERT INTO operations (id, kind, state, provider, network, order_id, escrow, asset, amount, executor_tip, execute_deadline, refund_after, created_at, updated_at, terminal_at) VALUES (?, 'swap', ?, 'thorchain', 'ethereum', ?, '0xe', 'native', '1', '1', ?, ?, 0, 0, ?)",
    );
    op.run("op_done_old", "COMPLETED", "0x01", 0, 0, NOW - 7 * D - 1);
    op.run("op_done_new", "COMPLETED", "0x02", 0, 0, NOW - 7 * D + 60_000);
    op.run("op_abandoned", "RECOVERY_REQUIRED", "0x03", 0, Math.floor((NOW - 2 * D - 60_000) / 1000), null);
    op.run("op_waiting", "RECOVERY_REQUIRED", "0x04", 0, Math.floor((NOW - 2 * D + 60_000) / 1000), null);
    // the eighth review round (A-M2): an operation no reconcile saw funded goes an hour after its execution deadline — unless finalized
    const deadline = (ms: number) => Math.floor(ms / 1000);
    op.run("op_unfunded_old", "AWAITING_AUTHORIZATION", "0x05", deadline(NOW - H - 60_000), deadline(NOW + D), null);
    op.run("op_unfunded_recent", "AWAITING_AUTHORIZATION", "0x06", deadline(NOW - H + 60_000), deadline(NOW + D), null);
    op.run("op_unfunded_finalized", "AWAITING_AUTHORIZATION", "0x07", deadline(NOW - H - 60_000), deadline(NOW + D), null);
    db.exec("INSERT INTO executions (operation_id, execution_tx, provider_ref, finalized_at) VALUES ('op_unfunded_finalized', NULL, NULL, 0)");
    // and every blob goes once its order's execution deadline has passed (A-M2, A-L2)
    const blob = db.prepare("UPDATE operations SET order_blob = '{}' WHERE id = ?");
    for (const id of ["op_unfunded_recent", "op_unfunded_finalized", "op_waiting"]) blob.run(id);
    db.prepare("UPDATE operations SET execute_deadline = ? WHERE id = 'op_waiting'").run(deadline(NOW + H));
    const ev = db.prepare("INSERT INTO system_events (at, level, event) VALUES (?, 'info', 'x.y')");
    ev.run(NOW - 7 * D - 1);
    ev.run(NOW - 7 * D + 1);
    const h = db.prepare("INSERT INTO provider_health (provider, at, reachable, halted) VALUES ('thorchain', ?, 1, 0)");
    h.run(NOW - 48 * H - 1);
    h.run(NOW - 48 * H + 1);
    expect(purge(db, NOW)).toEqual({ quotes: 1, operations: 1, abandoned: 1, unfunded: 1, blobs: 2, events: 1, health: 1 });
    expect(db.prepare("SELECT id FROM quotes").all()).toEqual([{ id: "qt_fresh" }]);
    expect((db.prepare("SELECT id FROM operations ORDER BY id").all() as { id: string }[]).map((r) => r.id)).toEqual([
      "op_done_new",
      "op_unfunded_finalized",
      "op_unfunded_recent",
      "op_waiting",
    ]);
    const blobs = db
      .prepare(
        "SELECT id, order_blob IS NOT NULL AS kept FROM operations WHERE id IN ('op_unfunded_recent', 'op_unfunded_finalized', 'op_waiting') ORDER BY id",
      )
      .all();
    expect(blobs, "a blob outlives its order's execution deadline nowhere").toEqual([
      { id: "op_unfunded_finalized", kept: 0 },
      { id: "op_unfunded_recent", kept: 0 },
      { id: "op_waiting", kept: 1 },
    ]);
    expect(purge(db, NOW), "a second purge finds nothing").toEqual({ quotes: 0, operations: 0, abandoned: 0, unfunded: 0, blobs: 0, events: 0, health: 0 });
    expect(RETENTION).toEqual({
      quoteAfterExpiry: H,
      terminalOperation: 7 * D,
      abandonedAfterRefund: 2 * D,
      unfundedAfterDeadline: H,
      events: 7 * D,
      providerHealth: 48 * H,
    });
  });
  it("deleting an operation deletes its execution and its relayer job (foreign keys)", () => {
    const db = openDb(":memory:");
    db.exec(
      "INSERT INTO operations (id, kind, state, provider, network, order_id, escrow, asset, amount, executor_tip, execute_deadline, refund_after, created_at, updated_at, terminal_at) VALUES ('op_x', 'swap', 'COMPLETED', 'thorchain', 'ethereum', '0x0a', '0xe', 'native', '1', '1', 0, 0, 0, 0, 0)",
    );
    db.exec("INSERT INTO executions (operation_id, execution_tx, provider_ref, finalized_at) VALUES ('op_x', NULL, NULL, 0)");
    db.exec("INSERT INTO relayer_jobs (operation_id, state, read_at) VALUES ('op_x', 'completed', 0)");
    purge(db, NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM relayer_jobs").get()).toEqual({ n: 0 });
  });
});
