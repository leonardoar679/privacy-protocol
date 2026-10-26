// The delta sync (spec v3.0 §7.4): from the block a snapshot (or the last sync) ended at to `head − 12`, in windows of
// blocks sized to what the endpoint allows (halved on a range refusal, never below 50), each window closed with the
// hash of its last block as a checkpoint; a later sync asks the chain whether the checkpoints still stand and rolls
// back to the newest that does. The deposits must continue the leaf count without a gap. Pure over an injected
// JSON-RPC function; shared by the app, the tests and the snapshot generator.
import { checkContinuity, decodeLogs, type DepositEvent, type Hex, type RawLog, type WithdrawalEvent } from "./events.ts";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export const CONFIRMATIONS = 12;
export const MAX_WINDOW = 500_000;
export const MIN_WINDOW = 50;
export const KEEP_CHECKPOINTS = 24;

export interface Checkpoint {
  blockNumber: number;
  blockHash: Hex;
}

export type SyncErrorKind = "gap" | "rpc" | "reorg" | "window";

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  // no parameter property: Node runs this module with type stripping, which erases types only
  constructor(message: string, kind: SyncErrorKind) {
    super(message);
    this.kind = kind;
  }
}

export interface SyncInput {
  rpc: Rpc;
  address: Hex;
  /** the last block already covered (the snapshot's or the last sync's toBlock) */
  fromBlock: number;
  /** the leaf count so far: the next deposit must be this leaf */
  leaves: number;
  /** the head to sync towards (read from the chain when absent) */
  headBlock?: number;
  confirmations?: number;
  /** the first window size (the last sync's final size is a good start) */
  window?: number;
  onWindow?: (w: { from: number; to: number; deposits: number; withdrawals: number; window: number }) => void;
}

export interface SyncResult {
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
  /** the last block covered now */
  toBlock: number;
  blockHash: Hex | null;
  /** the new checkpoints, oldest first (the caller merges them with the old ones: `mergeCheckpoints`) */
  checkpoints: Checkpoint[];
  windows: number;
  /** the window size that worked last */
  window: number;
}

const hex = (n: number): string => `0x${n.toString(16)}`;
const RANGE_REFUSAL = /range|limit|too (large|many|big)|exceed|block.*(span|window)|more than|unavailable|timeout|timed out/i;

export async function blockHashOf(rpc: Rpc, blockNumber: number): Promise<Hex> {
  const block = (await rpc("eth_getBlockByNumber", [hex(blockNumber), false])) as { hash?: string; number?: string } | null;
  if (!block?.hash || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new SyncError(`block ${blockNumber} has no hash yet`, "rpc");
  if (block.number !== undefined && Number.parseInt(block.number, 16) !== blockNumber)
    throw new SyncError(`the endpoint answered block ${String(block.number)} for ${blockNumber}`, "rpc");
  return block.hash.toLowerCase() as Hex;
}

export async function headBlockOf(rpc: Rpc): Promise<number> {
  const n = (await rpc("eth_blockNumber", [])) as string;
  const head = Number.parseInt(n, 16);
  if (!Number.isFinite(head) || head <= 0) throw new SyncError("the endpoint answered no block number", "rpc");
  return head;
}

/** Syncs `fromBlock + 1 … head − confirmations`. */
export async function syncDelta(input: SyncInput): Promise<SyncResult> {
  const { rpc, address } = input;
  const confirmations = input.confirmations ?? CONFIRMATIONS;
  const head = input.headBlock ?? (await headBlockOf(rpc));
  const target = head - confirmations;
  let window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, input.window ?? MAX_WINDOW));
  const deposits: DepositEvent[] = [];
  const withdrawals: WithdrawalEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  let leaves = input.leaves;
  let from = input.fromBlock + 1;
  let windows = 0;
  let successes = 0;
  while (from <= target) {
    const to = Math.min(target, from + window - 1);
    let logs: RawLog[];
    try {
      logs = (await rpc("eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to) }])) as RawLog[];
      if (!Array.isArray(logs)) throw new SyncError("eth_getLogs answered no list", "rpc");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (window > MIN_WINDOW && RANGE_REFUSAL.test(message)) {
        window = Math.max(MIN_WINDOW, Math.floor(window / 2));
        successes = 0;
        continue;
      }
      throw e instanceof SyncError ? e : new SyncError(message, "rpc");
    }
    const endHash = await blockHashOf(rpc, to);
    // a log of the window's last block must carry that block's hash, or the chain moved under the window: redo it
    if (logs.some((l) => l.blockNumber !== undefined && Number.parseInt(l.blockNumber, 16) === to && l.blockHash && l.blockHash.toLowerCase() !== endHash)) {
      successes = 0;
      continue;
    }
    const decoded = decodeLogs(logs, address);
    checkContinuity(decoded.deposits, leaves);
    leaves += decoded.deposits.length;
    deposits.push(...decoded.deposits);
    withdrawals.push(...decoded.withdrawals);
    checkpoints.push({ blockNumber: to, blockHash: endHash });
    windows++;
    input.onWindow?.({ from, to, deposits: decoded.deposits.length, withdrawals: decoded.withdrawals.length, window });
    from = to + 1;
    if (++successes >= 2 && window < MAX_WINDOW) {
      window = Math.min(MAX_WINDOW, window * 2);
      successes = 0;
    }
  }
  const last = checkpoints.at(-1);
  return {
    deposits,
    withdrawals,
    toBlock: last ? last.blockNumber : input.fromBlock,
    blockHash: last ? last.blockHash : null,
    checkpoints: checkpoints.slice(-KEEP_CHECKPOINTS),
    windows,
    window,
  };
}

/** The old and the new checkpoints, oldest first, the newest KEEP_CHECKPOINTS kept. */
export function mergeCheckpoints(old: readonly Checkpoint[], fresh: readonly Checkpoint[]): Checkpoint[] {
  return [...old, ...fresh].sort((a, b) => a.blockNumber - b.blockNumber).slice(-KEEP_CHECKPOINTS);
}

/**
 * Asks the chain for the block hash at every checkpoint, newest first, and returns the newest that still stands — or
 * null when none does (the history must be rebuilt from its snapshot).
 */
export async function findReorg(rpc: Rpc, checkpoints: readonly Checkpoint[]): Promise<{ intact: true } | { intact: false; rollbackTo: Checkpoint | null }> {
  const ordered = [...checkpoints].sort((a, b) => b.blockNumber - a.blockNumber);
  for (let i = 0; i < ordered.length; i++) {
    const hash = await blockHashOf(rpc, ordered[i].blockNumber);
    if (hash === ordered[i].blockHash.toLowerCase()) return i === 0 ? { intact: true } : { intact: false, rollbackTo: ordered[i] };
  }
  return { intact: false, rollbackTo: null };
}

/** The events up to and including a block (what a rollback keeps). */
export function eventsUpTo<T extends { blockNumber: number }>(events: readonly T[], blockNumber: number): T[] {
  return events.filter((e) => e.blockNumber <= blockNumber);
}
