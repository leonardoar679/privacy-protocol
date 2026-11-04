// The API's repository (spec v2.0 §15) over db.ts: the seeded registries, the providers' health, the chain's last block,
// the quotes (no amount), the operations (swaps and cross-chain swaps only; the order's blob until finalize), the
// executions, the relayer jobs as the API last read them, and the system events — every event is the logger's sanitized
// record, so the table holds exactly what the log line says.
import type { DatabaseSync } from "node:sqlite";
import { sanitize, type LogFields, type Logger } from "@privacy-wallet/server-kit/logger";
import { TERMINAL_STATES, type OperationState, type SettlementState } from "@privacy-wallet/protocol-types";
import { checkpoint, purge } from "./db";

export interface OperationRow {
  id: string;
  kind: "swap" | "cross-chain";
  state: OperationState;
  settlement: SettlementState | null;
  provider: string;
  network: string;
  tier: string | null;
  quoteId: string | null;
  orderId: string;
  escrow: string;
  asset: string;
  amount: string;
  executorTip: string;
  executeDeadline: number;
  refundAfter: number;
  createdAt: number;
  updatedAt: number;
  checkedAt: number | null;
  terminalAt: number | null;
}

type Row = Record<string, unknown>;
const toOperation = (r: Row): OperationRow => ({
  id: String(r.id),
  kind: r.kind as OperationRow["kind"],
  state: r.state as OperationState,
  settlement: (r.settlement as SettlementState | null) ?? null,
  provider: String(r.provider),
  network: String(r.network),
  tier: (r.tier as string | null) ?? null,
  quoteId: (r.quote_id as string | null) ?? null,
  orderId: String(r.order_id),
  escrow: String(r.escrow),
  asset: String(r.asset),
  amount: String(r.amount),
  executorTip: String(r.executor_tip),
  executeDeadline: Number(r.execute_deadline),
  refundAfter: Number(r.refund_after),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  checkedAt: r.checked_at === null || r.checked_at === undefined ? null : Number(r.checked_at),
  terminalAt: r.terminal_at === null || r.terminal_at === undefined ? null : Number(r.terminal_at),
});

export class Store {
  constructor(
    readonly db: DatabaseSync,
    readonly log: Logger,
    readonly now: () => number = Date.now,
  ) {}

  /** The asset registry as this deployment serves it (upserted at start). */
  seedAssets(assets: { id: string; chain: string; symbol: string; decimals: number; status: string }[]): void {
    const st = this.db.prepare(
      "INSERT INTO assets (id, chain, symbol, decimals, status, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chain = excluded.chain, symbol = excluded.symbol, decimals = excluded.decimals, status = excluded.status, updated_at = excluded.updated_at",
    );
    for (const a of assets) st.run(a.id, a.chain, a.symbol, a.decimals, a.status, this.now());
  }
  assets(): { id: string; chain: string; symbol: string; decimals: number; status: string }[] {
    return this.db.prepare("SELECT id, chain, symbol, decimals, status FROM assets ORDER BY id").all() as never;
  }
  seedProviders(ids: string[]): void {
    const st = this.db.prepare(
      "INSERT INTO providers (id, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
    );
    for (const id of ids) st.run(id, this.now());
  }

  recordHealth(provider: string, h: { reachable: boolean; halted: boolean; reason?: string }): void {
    this.db
      .prepare("INSERT INTO provider_health (provider, at, reachable, halted, reason) VALUES (?, ?, ?, ?, ?)")
      .run(provider, this.now(), h.reachable ? 1 : 0, h.halted ? 1 : 0, h.reason ?? null);
  }
  /** Each provider's last sample and how many of its samples in the last hour found it unreachable or halted. */
  health(): { provider: string; at: number | null; reachable: boolean | null; halted: boolean | null; reason: string | null; recentFailures: number }[] {
    const since = this.now() - 3_600_000;
    const rows = this.db
      .prepare(
        `SELECT p.id AS provider, h.at, h.reachable, h.halted, h.reason,
           (SELECT COUNT(*) FROM provider_health f WHERE f.provider = p.id AND f.at >= ? AND (f.reachable = 0 OR f.halted = 1)) AS failures
         FROM providers p LEFT JOIN provider_health h ON h.id = (SELECT MAX(id) FROM provider_health WHERE provider = p.id) ORDER BY p.id`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      provider: String(r.provider),
      at: r.at === null ? null : Number(r.at),
      reachable: r.reachable === null ? null : r.reachable === 1,
      halted: r.halted === null ? null : r.halted === 1,
      reason: (r.reason as string | null) ?? null,
      recentFailures: Number(r.failures),
    }));
  }

  chainState(chain: string, block: number): void {
    this.db
      .prepare("INSERT INTO chain_state (chain, block, at) VALUES (?, ?, ?) ON CONFLICT(chain) DO UPDATE SET block = excluded.block, at = excluded.at")
      .run(chain, block, this.now());
  }
  chains(): { chain: string; block: number; at: number }[] {
    return this.db.prepare("SELECT chain, block, at FROM chain_state ORDER BY chain").all() as never;
  }

  /** A quote's row: when, until when, the chosen route, the pair and the tier — never an amount or a destination. */
  putQuote(q: { id: string; expiresAt: number; provider: string | null; pair: string; tier: string | null }): void {
    this.db
      .prepare("INSERT INTO quotes (id, created_at, expires_at, provider, pair, tier) VALUES (?, ?, ?, ?, ?, ?)")
      .run(q.id, this.now(), q.expiresAt, q.provider, q.pair, q.tier);
  }

  createOperation(o: Omit<OperationRow, "createdAt" | "updatedAt" | "checkedAt" | "terminalAt" | "settlement">, blob: string): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO operations (id, kind, state, settlement, provider, network, tier, quote_id, order_id, escrow, asset, amount, executor_tip, execute_deadline, refund_after, order_blob, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.kind,
        o.state,
        o.provider,
        o.network,
        o.tier,
        o.quoteId,
        o.orderId.toLowerCase(),
        o.escrow,
        o.asset,
        o.amount,
        o.executorTip,
        o.executeDeadline,
        o.refundAfter,
        blob,
        t,
        t,
      );
  }
  getOperation(id: string): OperationRow | null {
    const r = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    return r ? toOperation(r) : null;
  }
  operationByOrder(orderId: string): OperationRow | null {
    const r = this.db.prepare("SELECT * FROM operations WHERE order_id = ?").get(orderId.toLowerCase()) as Row | undefined;
    return r ? toOperation(r) : null;
  }
  blob(id: string): string | null {
    const r = this.db.prepare("SELECT order_blob FROM operations WHERE id = ?").get(id) as Row | undefined;
    return (r?.order_blob as string | null | undefined) ?? null;
  }
  setBlob(id: string, blob: string): void {
    this.db.prepare("UPDATE operations SET order_blob = ?, updated_at = ? WHERE id = ?").run(blob, this.now(), id);
  }
  /** The blob written back only while the operation still has one (the fourth review round, 2026-11-03): false once finalize nulled it. */
  setBlobIfPresent(id: string, blob: string): boolean {
    const r = this.db.prepare("UPDATE operations SET order_blob = ?, updated_at = ? WHERE id = ? AND order_blob IS NOT NULL").run(blob, this.now(), id);
    return Number(r.changes) > 0;
  }
  /**
   * The blob written back only while nothing of the operation is finalized (the fifth review round, 2026-11-03): a restore or a resume
   * had checked `execution()` and written in two statements, and a finalize between them put the destination and the refund material
   * back into a finalized row. False when an execution row exists.
   */
  setBlobUnlessFinalized(id: string, blob: string): boolean {
    // nor into an operation that ended (the eighth review round, A-L2): its blob went with its terminal state
    const r = this.db
      .prepare(
        "UPDATE operations SET order_blob = ?, updated_at = ? WHERE id = ? AND terminal_at IS NULL AND execute_deadline * 1000 >= ? AND NOT EXISTS (SELECT 1 FROM executions WHERE executions.operation_id = operations.id)",
      )
      .run(blob, this.now(), id, this.now()); // nor past its execution deadline (the ninth review round, A9-11): the purge had removed it there
    return Number(r.changes) > 0;
  }
  /**
   * A re-sign's blob, rebuilt from the wallet's params after a finalize (the eighth review round, 2026-11-03, A-L2): written only while
   * the operation still has no blob and its finalize is the one the prepare started from. A slow prepare that lost the race to its
   * retry had written the destination, the refund material and the signer back into a row its retry had finalized since.
   */
  setRestoredBlob(id: string, blob: string, finalizedAt: number | null): boolean {
    const r = this.db
      .prepare(
        "UPDATE operations SET order_blob = ?, updated_at = ? WHERE id = ? AND order_blob IS NULL AND terminal_at IS NULL AND execute_deadline * 1000 >= ? AND (SELECT finalized_at FROM executions WHERE executions.operation_id = operations.id) IS ?",
      )
      .run(blob, this.now(), id, this.now(), finalizedAt);
    return Number(r.changes) > 0;
  }
  /** The operations not yet ended (the eighth review round, A-M2: the commit's capacity). */
  openOperations(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE terminal_at IS NULL").get() as { n: number }).n);
  }
  /** Several statements as one (the fourth review round, 2026-11-03): node:sqlite is synchronous, so a handler's block is atomic once wrapped. */
  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
  }
  /**
   * Finalize: the execution is recorded (its provider, the provider's reference, and the plan's seconds that time a
   * settlement stall) and the blob — the destination and the refund material — is gone.
   */
  finalize(id: string, e: { providerRef?: string; expectedSeconds?: number }): void {
    const t = this.now();
    // one transaction (the fourth review round, 2026-11-03): a crash between the two statements had left an operation with no blob
    // and no execution row — prepare answered unknown until a restore
    this.transaction(() => {
      this.db.prepare("UPDATE operations SET order_blob = NULL, updated_at = ? WHERE id = ?").run(t, id);
      this.db
        .prepare(
          "INSERT INTO executions (operation_id, execution_tx, provider_ref, finalized_at, expected_seconds) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET provider_ref = excluded.provider_ref, finalized_at = excluded.finalized_at, expected_seconds = excluded.expected_seconds",
        )
        .run(id, e.providerRef ?? null, t, e.expectedSeconds ?? null);
    });
    checkpoint(this.db); // the WAL's frames had kept the blob finalize removed (the eighth review round, A-M1)
  }
  execution(id: string): { executionTx: string | null; providerRef: string | null; finalizedAt: number; expectedSeconds: number | null } | null {
    const r = this.db.prepare("SELECT execution_tx, provider_ref, finalized_at, expected_seconds FROM executions WHERE operation_id = ?").get(id) as
      Row | undefined;
    return r
      ? {
          executionTx: (r.execution_tx as string | null) ?? null,
          providerRef: (r.provider_ref as string | null) ?? null,
          finalizedAt: Number(r.finalized_at),
          expectedSeconds: r.expected_seconds === null || r.expected_seconds === undefined ? null : Number(r.expected_seconds),
        }
      : null;
  }
  /**
   * The state and settlement after a reconcile; a terminal state is final (I-O1), stamps `terminal_at` and drops the blob (the eighth
   * review round, A-L2: an order a reconcile ended kept its destination and refund material for the terminal row's seven days).
   */
  /**
   * `unchangedSince`: the row's updated_at the caller read it at — the write is made only over that row (the ninth review round, 2026-11-04,
   * A9-7: a reconcile slower than the throttle had written its snapshot over a newer terminal answer); never over a terminal row (I-O1).
   * Whether it was written.
   */
  /**
   * `startedAt`: a reconcile's own start (the tenth review round, B10-12) — written as the row's checked_at, and refused over a row a later-started
   * reconcile wrote: two that overlapped had kept the older snapshot when it wrote first, the newer terminal answer refused. `unchangedSince`:
   * only over the row as it was read.
   */
  updateState(id: string, s: { state: OperationState; settlement: SettlementState | null }, o: { unchangedSince?: number; startedAt?: number } = {}): boolean {
    const t = this.now();
    const checked = o.startedAt ?? t;
    const terminal = TERMINAL_STATES.includes(s.state);
    const r = this.db
      .prepare(
        `UPDATE operations SET state = ?, settlement = ?, checked_at = ?, updated_at = ?, terminal_at = CASE WHEN terminal_at IS NULL AND ? THEN ? ELSE terminal_at END, order_blob = CASE WHEN ? THEN NULL ELSE order_blob END WHERE id = ? AND terminal_at IS NULL${o.unchangedSince !== undefined ? " AND updated_at = ?" : ""}${o.startedAt !== undefined ? " AND (checked_at IS NULL OR checked_at <= ?)" : ""}`,
      )
      .run(
        s.state,
        s.settlement,
        checked,
        t,
        terminal ? 1 : 0,
        t,
        terminal ? 1 : 0,
        id,
        ...(o.unchangedSince !== undefined ? [o.unchangedSince] : []),
        ...(o.startedAt !== undefined ? [o.startedAt] : []),
      );
    const written = Number(r.changes) > 0;
    if (written && terminal) checkpoint(this.db); // the blob it dropped leaves the WAL too (A9-11)
    return written;
  }
  putJob(id: string, j: { state: string; executionTx?: string; actualWei?: string }): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO relayer_jobs (operation_id, state, execution_tx, actual_wei, read_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET state = excluded.state, execution_tx = COALESCE(excluded.execution_tx, relayer_jobs.execution_tx), actual_wei = COALESCE(excluded.actual_wei, relayer_jobs.actual_wei), read_at = excluded.read_at",
        )
        .run(id, j.state, j.executionTx ?? null, j.actualWei ?? null, this.now());
      // the relayer's execution transaction is the authority (the review round of 2026-11-03, F6): one it dropped and sent again has a
      // new hash, and the stall rule compared against the dead one for good
      if (j.executionTx) this.db.prepare("UPDATE executions SET execution_tx = ? WHERE operation_id = ?").run(j.executionTx, id);
    });
  }

  /** An event: the log line and its row are the same sanitized record. */
  event(f: LogFields): void {
    const at = this.now();
    const r = sanitize(f, new Date(at));
    this.db
      .prepare("INSERT INTO system_events (at, level, event, operation_id, provider, state, error_class, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at, r.level ?? "info", r.event ?? "redacted", r.operationId ?? null, r.provider ?? null, r.state ?? null, r.errorClass ?? null, r.network ?? null);
    this.log.log(f);
  }
  hasEvent(event: string, operationId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM system_events WHERE event = ? AND operation_id = ? LIMIT 1").get(event, operationId);
  }

  purge(): ReturnType<typeof purge> {
    return purge(this.db, this.now());
  }
}
