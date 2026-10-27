// The API's database (spec v2.0 §15): node:sqlite (DatabaseSync) in WAL mode, synchronous=NORMAL, foreign keys on, a busy
// timeout, migrations by PRAGMA user_version. What it never holds: a note, a key, a recovery phrase, a witness, a
// balance, the user's address, an IP address, a user agent, the funding transaction — a quote row has no amount, and an
// operation's destination and refund material exist only in `order_blob` until finalize nulls it. Retention: purge().
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";

// node:sqlite is a prefix-only builtin that Vite's resolver (the test runner) does not know: it is required at run time
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = Database;

/** The schema, one migration per entry; the test pins its text. STRICT tables: a wrong type is refused, not coerced. */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('supported', 'temporarily-unavailable', 'unsupported')),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE provider_health (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  reachable INTEGER NOT NULL,
  halted INTEGER NOT NULL,
  reason TEXT
) STRICT;
CREATE INDEX provider_health_at ON provider_health(at);
CREATE TABLE chain_state (
  chain TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE TABLE quotes (
  id TEXT PRIMARY KEY CHECK (id GLOB 'qt_*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  provider TEXT,
  pair TEXT NOT NULL,
  tier TEXT
) STRICT;
CREATE INDEX quotes_expires_at ON quotes(expires_at);
CREATE TABLE operations (
  id TEXT PRIMARY KEY CHECK (id GLOB 'op_*'),
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'cross-chain')),
  state TEXT NOT NULL,
  settlement TEXT,
  provider TEXT NOT NULL,
  network TEXT NOT NULL,
  tier TEXT,
  quote_id TEXT,
  order_id TEXT NOT NULL UNIQUE,
  escrow TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  executor_tip TEXT NOT NULL,
  execute_deadline INTEGER NOT NULL,
  refund_after INTEGER NOT NULL,
  order_blob TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER,
  terminal_at INTEGER
) STRICT;
CREATE INDEX operations_terminal_at ON operations(terminal_at);
CREATE TABLE executions (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
  execution_tx TEXT,
  provider_ref TEXT,
  finalized_at INTEGER NOT NULL
) STRICT;
CREATE TABLE relayer_jobs (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  execution_tx TEXT,
  actual_wei TEXT,
  read_at INTEGER NOT NULL
) STRICT;
CREATE TABLE system_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  operation_id TEXT,
  provider TEXT,
  state TEXT,
  error_class TEXT,
  network TEXT
) STRICT;
CREATE INDEX system_events_at ON system_events(at);
`,
  // 2 — a V6 follow-up of 2026-10-14: the plan's seconds, recorded at finalize, so that a settlement stall is timed by the
  // API's own records (the hand-over and the plan), never by a caller
  `
ALTER TABLE executions ADD COLUMN expected_seconds INTEGER;
`,
  // 3 — V7 Stage 15 (spec v3.0 §6): the fifteen operation states — the V6 names renamed in place; an operation that expired
  // before its funding (QUOTE_EXPIRED) is cancelled, nothing moved; the system events' state column follows
  `
UPDATE operations SET state = CASE state
  WHEN 'REVIEW' THEN 'READY_TO_REVIEW'
  WHEN 'AWAITING_SIGNATURE' THEN 'AWAITING_AUTHORIZATION'
  WHEN 'SIGNED' THEN 'SUBMITTING'
  WHEN 'SUBMITTED' THEN 'SOURCE_CONFIRMING'
  WHEN 'CONFIRMING' THEN 'SOURCE_CONFIRMING'
  WHEN 'EXECUTING' THEN 'PROVIDER_EXECUTING'
  WHEN 'SETTLING' THEN 'DESTINATION_CONFIRMING'
  WHEN 'QUOTE_EXPIRED' THEN 'CANCELLED'
  ELSE state END;
UPDATE operations SET terminal_at = updated_at WHERE state = 'CANCELLED' AND terminal_at IS NULL;
UPDATE system_events SET state = CASE state
  WHEN 'REVIEW' THEN 'READY_TO_REVIEW'
  WHEN 'AWAITING_SIGNATURE' THEN 'AWAITING_AUTHORIZATION'
  WHEN 'SIGNED' THEN 'SUBMITTING'
  WHEN 'SUBMITTED' THEN 'SOURCE_CONFIRMING'
  WHEN 'CONFIRMING' THEN 'SOURCE_CONFIRMING'
  WHEN 'EXECUTING' THEN 'PROVIDER_EXECUTING'
  WHEN 'SETTLING' THEN 'DESTINATION_CONFIRMING'
  WHEN 'QUOTE_EXPIRED' THEN 'CANCELLED'
  ELSE state END
WHERE state IS NOT NULL;
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Open (or create) the database and bring it to the current schema. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Retention (spec v2.0 §15), in milliseconds. */
export const RETENTION = {
  quoteAfterExpiry: HOUR,
  terminalOperation: 7 * DAY,
  abandonedAfterRefund: 2 * DAY,
  events: 7 * DAY,
  providerHealth: 48 * HOUR,
} as const;

/** Delete what retention says is no longer kept; returns the rows removed per table. */
export function purge(db: DatabaseSync, now: number): Record<"quotes" | "operations" | "abandoned" | "events" | "health", number> {
  const run = (sql: string, ...args: number[]): number => Number(db.prepare(sql).run(...args).changes);
  return {
    quotes: run("DELETE FROM quotes WHERE expires_at * 1000 < ?", now - RETENTION.quoteAfterExpiry),
    operations: run("DELETE FROM operations WHERE terminal_at IS NOT NULL AND terminal_at < ?", now - RETENTION.terminalOperation),
    abandoned: run("DELETE FROM operations WHERE terminal_at IS NULL AND refund_after * 1000 < ?", now - RETENTION.abandonedAfterRefund),
    events: run("DELETE FROM system_events WHERE at < ?", now - RETENTION.events),
    health: run("DELETE FROM provider_health WHERE at < ?", now - RETENTION.providerHealth),
  };
}
