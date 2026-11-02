// The database (spec v2.0 §15): the schema pinned by its text, the nine STRICT tables and nothing else, the pragmas (WAL on
// a file, synchronous NORMAL, foreign keys, a busy timeout), migrations by user_version that never run twice, and no
// column that could hold what is never stored (a note, a key, a phrase, a witness, a balance, an address, an IP, a user agent).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION, openDb } from "../src/db";
import { API_EXECUTION_FIELDS, apiOperationColumns } from "@privacy-wallet/protocol-types";

// node:sqlite is a prefix-only builtin Vite's resolver does not know (as in src/db.ts): required at run time
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = mkdtempSync(join(tmpdir(), "api-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the schema", () => {
  it("is pinned: a change to the DDL is a new migration, never an edit", () => {
    expect(SCHEMA_VERSION).toBe(4);
    // one pin per migration: a new one adds a pin, an edit to an old one fails (LF everywhere, .gitattributes: a CRLF
    // checkout must not move a pin)
    expect(MIGRATIONS.map((m) => createHash("sha256").update(m.replace(/\r\n/g, "\n")).digest("hex"))).toEqual([
      "d677ebd75547187b85eb9c2a06f908fe19117e7ba87c929962fc6ab053f4d215",
      // 2 (2026-10-14): executions.expected_seconds, the plan's seconds that time a settlement stall
      "497f73f9ea06d5518a0f108eda41d5fb2b8e92f9782ad01507c85253ed8077cf",
      // 3 (V7 Stage 15, spec v3.0 §6): the fifteen operation states — the rows renamed in place, an operation expired before its funding cancelled
      "5afd31f4ff1b8878268ab5aa2afee7de35e957df385d105be1397ee12f92363e",
      // 4 (the review round of 2026-11-02): an operation expired before its funding waits as RECOVERY_REQUIRED until its refund time; the rows cancelled early come back
      "47b5692fede6b6dd9520b38ac0be132aaf3a1846e0282d59618e8715353d25d2",
    ]);
  });
  it("a database at version 1 migrates to the current version: its executions kept, the plan's seconds empty until a finalize records them", () => {
    const path = join(dir, "v1.sqlite");
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false }); // an execution row alone, as a fixture
    old.exec(MIGRATIONS[0]);
    old.exec("PRAGMA user_version = 1");
    old.exec("INSERT INTO executions (operation_id, execution_tx, provider_ref, finalized_at) VALUES ('op_x', NULL, NULL, 1)");
    old.close();
    const db = openDb(path);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare("SELECT * FROM executions").all()).toEqual([
      { operation_id: "op_x", execution_tx: null, provider_ref: null, finalized_at: 1, expected_seconds: null },
    ]);
    db.close();
  });
  it("holds the nine tables, every one STRICT, and no column for what is never stored", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string; sql: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "assets",
      "chain_state",
      "executions",
      "operations",
      "provider_health",
      "providers",
      "quotes",
      "relayer_jobs",
      "system_events",
    ]);
    for (const t of tables) expect(t.sql, t.name).toMatch(/\) STRICT$/);
    const columns = tables.flatMap((t) => (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => `${t.name}.${c.name}`));
    for (const c of columns) expect(c, c).not.toMatch(/(^|[._])(notes?|secret|phrase|seed|witness|balance|address|ip|agent|user|funding|destination)(_|$)/i);
    expect(columns).toContain("operations.order_blob"); // the one place the destination and the refund material live, until finalize
    // V6 Stage 14: the Privacy Center words the API's record from protocol-types' list — it must be exactly these columns
    expect(
      columns
        .filter((c) => c.startsWith("operations."))
        .map((c) => c.slice("operations.".length))
        .sort(),
    ).toEqual(apiOperationColumns().sort());
    // the execution's record and the relayer's report, as the Privacy Center words them (a V6 follow-up of 2026-10-14)
    const besideTheOperation = (t: string) =>
      columns
        .filter((c) => c.startsWith(`${t}.`))
        .map((c) => c.slice(t.length + 1))
        .filter((c) => c !== "operation_id")
        .sort();
    expect(besideTheOperation("executions")).toEqual([...API_EXECUTION_FIELDS.execution].sort());
    expect(besideTheOperation("relayer_jobs")).toEqual([...API_EXECUTION_FIELDS.job].sort());
    expect(columns.filter((c) => c.startsWith("quotes."))).toEqual([
      "quotes.id",
      "quotes.created_at",
      "quotes.expires_at",
      "quotes.provider",
      "quotes.pair",
      "quotes.tier",
    ]);
  });
  it("opens a file in WAL with synchronous NORMAL, foreign keys and a busy timeout; migrating twice is a no-op", () => {
    const path = join(dir, "api.sqlite");
    const db = openDb(path);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.exec("INSERT INTO providers (id, enabled, updated_at) VALUES ('thorchain', 1, 1)");
    db.close();
    const again = openDb(path);
    expect(again.prepare("SELECT id FROM providers").all()).toEqual([{ id: "thorchain" }]);
    expect(() => again.exec("INSERT INTO provider_health (provider, at, reachable, halted) VALUES ('nobody', 1, 1, 0)"), "foreign keys are enforced").toThrow();
    expect(() => again.exec("INSERT INTO quotes (id, created_at, expires_at, pair) VALUES ('op_wrong', 1, 1, 'a>b')"), "a quote id is qt_").toThrow();
    expect(
      () => again.exec("INSERT INTO assets (id, chain, symbol, decimals, status, updated_at) VALUES ('x', 'c', 'S', 'not a number', 'supported', 1)"),
      "STRICT refuses a wrong type",
    ).toThrow();
    again.close();
  });
  it("a database at version 2 migrates to the current version (V7 Stage 15 + the review round of 2026-11-02): the V6 state names renamed in place, an operation expired before its funding cancelled with its terminal time once its refund time has passed and waiting until then, the system events' column following", () => {
    const path = join(dir, "v2.sqlite");
    const old = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.exec("PRAGMA user_version = 2");
    const row = old.prepare(
      "INSERT INTO operations (id, kind, state, provider, network, order_id, escrow, asset, amount, executor_tip, execute_deadline, refund_after, created_at, updated_at) VALUES (?, 'swap', ?, 'thorchain', 'ethereum', ?, '0xe', 'ETH', '1', '0', 1, 2, 10, 20)",
    );
    for (const [id, state] of [
      ["op_a", "AWAITING_SIGNATURE"],
      ["op_b", "SUBMITTED"],
      ["op_c", "EXECUTING"],
      ["op_d", "SETTLING"],
      ["op_e", "QUOTE_EXPIRED"],
      ["op_f", "COMPLETED"],
    ])
      row.run(id, state, id);
    old
      .prepare(
        "INSERT INTO operations (id, kind, state, provider, network, order_id, escrow, asset, amount, executor_tip, execute_deadline, refund_after, created_at, updated_at) VALUES ('op_g', 'swap', 'QUOTE_EXPIRED', 'thorchain', 'ethereum', 'op_g', '0xe', 'ETH', '1', '0', 1, 4102444800, 10, 20)",
      )
      .run(); // expired, its refund time (the year 2100) not reached: waits, never closed
    old
      .prepare("INSERT INTO system_events (at, level, event, operation_id, state) VALUES (1, 'info', 'operation.created', 'op_a', 'AWAITING_SIGNATURE')")
      .run();
    old.close();
    const db = openDb(path);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(db.prepare("SELECT id, state, terminal_at FROM operations ORDER BY id").all()).toEqual([
      { id: "op_a", state: "AWAITING_AUTHORIZATION", terminal_at: null },
      { id: "op_b", state: "SOURCE_CONFIRMING", terminal_at: null },
      { id: "op_c", state: "PROVIDER_EXECUTING", terminal_at: null },
      { id: "op_d", state: "DESTINATION_CONFIRMING", terminal_at: null },
      { id: "op_e", state: "CANCELLED", terminal_at: 20 },
      { id: "op_f", state: "COMPLETED", terminal_at: null },
      { id: "op_g", state: "RECOVERY_REQUIRED", terminal_at: null },
    ]);
    expect(db.prepare("SELECT state FROM system_events").all()).toEqual([{ state: "AWAITING_AUTHORIZATION" }]);
    db.close();
  });
});
