// The database (spec v2.0 §15): the schema pinned by its text, the nine STRICT tables and nothing else, the pragmas (WAL on
// a file, synchronous NORMAL, foreign keys, a busy timeout), migrations by user_version that never run twice, and no
// column that could hold what is never stored (a note, a key, a phrase, a witness, a balance, an address, an IP, a user agent).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION, openDb } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "api-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the schema", () => {
  it("is pinned: a change to the DDL is a new migration, never an edit", () => {
    expect(SCHEMA_VERSION).toBe(1);
    // LF everywhere (.gitattributes); a CRLF checkout must not move the pin
    const text = MIGRATIONS.join("\n-- next migration --\n").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe("d677ebd75547187b85eb9c2a06f908fe19117e7ba87c929962fc6ab053f4d215");
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
});
