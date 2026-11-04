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
  // 4 — the review round of 2026-11-02: an operation that expired before its funding is closed only once its refund time has
  // passed (a funding in the mempool at the deadline still lands, and is re-derived meanwhile); until then it waits as
  // RECOVERY_REQUIRED. The rows migration 3 had cancelled, or the reconcile since, with a refund time still ahead come back.
  `
UPDATE operations SET state = 'RECOVERY_REQUIRED', terminal_at = NULL
WHERE state = 'CANCELLED' AND refund_after > CAST(strftime('%s', 'now') AS INTEGER);
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Open (or create) the database and bring it to the current schema. The eighth review round (2026-11-03, A-M1): deleted content is
 * overwritten (secure_delete, set per connection before anything is written) — finalize's NULL and the purge's DELETE had left the
 * destination, the refund note secret and the one-time signer in the file's free pages and in the WAL; a file with free pages from
 * a build without it is vacuumed once at open.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA secure_delete = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  migrate(db);
  return db;
}
/** The busy handler's wait for a write lock held by another connection. */
export const BUSY_TIMEOUT_MS = 5000;
/** The file's application id once its one-time vacuum ran ("PWA9"). */
export const VACUUMED_ONCE = 0x50574139;

/**
 * The WAL written back and emptied (the eighth review round, A-M1): its frames had kept what a finalize or a purge removed. Never waiting
 * for a reader (the ninth review round, A9-4): a TRUNCATE checkpoint calls the busy handler until readers leave, and with a backup, Litestream
 * or an operator's shell on the file every finalize had stalled the whole API (node:sqlite is synchronous) for the 5 s timeout. A reader
 * on the file keeps the WAL until the next checkpoint finds none (docs/deployment.md).
 */
export function checkpoint(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* a reader holds the WAL: the next checkpoint empties it */
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

/** A database another build migrated further: this build does not know its schema (the eighth review round, A-I3). */
export class SchemaTooNew extends Error {
  constructor(readonly version: number) {
    super(`the database is at schema version ${version}, newer than this build's ${MIGRATIONS.length}: run a build that knows it`);
    this.name = "SchemaTooNew";
  }
}

/**
 * Bring the schema up to date, one migration per transaction. The eighth review round (A-I3): a database a newer build migrated is
 * refused, not run silently on an older schema, and each step takes the write lock first and reads the version inside it — two
 * processes starting together had both run the same step.
 */
export function migrate(db: DatabaseSync): void {
  const version = () => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version() > MIGRATIONS.length) throw new SchemaTooNew(version());
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = version();
      if (v > MIGRATIONS.length) throw new SchemaTooNew(v);
      if (v === MIGRATIONS.length) {
        db.exec("COMMIT");
        return;
      }
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
  /** an operation no reconcile saw funded, after its execution deadline (the eighth review round, A-M2) */
  unfundedAfterDeadline: HOUR,
  events: 7 * DAY,
  providerHealth: 48 * HOUR,
} as const;

/** The states of an operation no reconcile has seen funded (reconcile.ts PRE_FUNDING). */
const NEVER_FUNDED = "('DRAFT', 'QUOTING', 'READY_TO_REVIEW', 'AWAITING_AUTHORIZATION', 'PREPARING_PROOF', 'SUBMITTING')";

/**
 * Delete what retention says is no longer kept; returns the rows removed per table. The eighth review round (2026-11-03): an
 * operation's blob — the destination, the refund material, the signer — goes once its execution deadline has passed (no call can be
 * signed past it, and a restore rebuilds from the wallet's own params), whatever its state; an operation no reconcile saw funded goes
 * an hour after that deadline (the wallet's restore creates it again should a late funding need it). Free commits had kept their
 * whole order for days; a reconciled, never-finalized order's blob had outlived the unreconciled one's by five days (A-M2, A-L2).
 * The WAL is emptied afterwards (A-M1).
 */
export function purge(db: DatabaseSync, now: number): Record<"quotes" | "operations" | "abandoned" | "unfunded" | "blobs" | "events" | "health", number> {
  const run = (sql: string, ...args: number[]): number => Number(db.prepare(sql).run(...args).changes);
  const out = {
    quotes: run("DELETE FROM quotes WHERE expires_at * 1000 < ?", now - RETENTION.quoteAfterExpiry),
    operations: run("DELETE FROM operations WHERE terminal_at IS NOT NULL AND terminal_at < ?", now - RETENTION.terminalOperation),
    abandoned: run("DELETE FROM operations WHERE terminal_at IS NULL AND refund_after * 1000 < ?", now - RETENTION.abandonedAfterRefund),
    unfunded: run(
      `DELETE FROM operations WHERE terminal_at IS NULL AND state IN ${NEVER_FUNDED} AND execute_deadline * 1000 < ? AND NOT EXISTS (SELECT 1 FROM executions WHERE executions.operation_id = operations.id)`,
      now - RETENTION.unfundedAfterDeadline,
    ),
    blobs: run("UPDATE operations SET order_blob = NULL WHERE order_blob IS NOT NULL AND execute_deadline * 1000 < ?", now),
    events: run("DELETE FROM system_events WHERE at < ?", now - RETENTION.events),
    health: run("DELETE FROM provider_health WHERE at < ?", now - RETENTION.providerHealth),
  };
  checkpoint(db);
  // the free pages a build without secure_delete left, vacuumed once — at the first purge, so after it (the ninth review round, 2026-11-04,
  // A9-9): every start had vacuumed (any purge leaves free pages), rewriting the whole file before the API could listen, and the first start
  // after the upgrade copied the bloat no purge had removed yet. The file's application id marks it done
  if (Number((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id) !== VACUUMED_ONCE) {
    if (Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count) > 0) db.exec("VACUUM");
    db.exec(`PRAGMA application_id = ${VACUUMED_ONCE}`);
    checkpoint(db);
  }
  return out;
}
