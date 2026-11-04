// A pool's history in the app (spec v3.0 §7.4; V7 Stage 9): what the device kept, else the served snapshot, then the
// delta from the chain, then the one check — the recomputed root a root the pool knows and the leaf count its
// nextIndex. The tree lives in the prover worker (loaded from persisted layers, appended, asked for a path); the events
// live here for lookups and the statistics; both are kept in the app's own IndexedDB. A note never enters this module:
// a lookup takes a commitment and a nullifier hash the worker derived.
import type { PoolId } from "../../config";
import type { DepositEvent, Hex, WithdrawalEvent } from "../../history/events";
import { verifySnapshot, type SnapshotManifest } from "../../history/snapshot";
import { depositFacts, indexHistory, type HistoryIndex } from "../../history/spent";
import { eventsUpTo, findReorg, headBlockOf, mergeCheckpoints, MIN_WINDOW, syncDelta, SyncError, type Rpc } from "../../history/sync";
import { call, SELECTORS, verifyAgainstChain, wordOf } from "../../history/verify";
import type { DepositFacts, PoolStats } from "../../model/types";
import type { FetchedSnapshot } from "../../net/snapshot";
import { TREE_INCONSISTENT, type PathResult, type ProverProgress, type TreeResult } from "../../prover/protocol";
import type { HistoryStore, SyncState } from "../../storage/historyDb";

/** What the history needs of the worker (the ProverClient has it). */
export interface TreeClient {
  loadTree(pool: string, layers: string[][]): Promise<TreeResult>;
  buildTree(pool: string, leaves: string[], onProgress?: (p: ProverProgress) => void): Promise<TreeResult>;
  appendLeaves(pool: string, leaves: string[]): Promise<TreeResult>;
  truncateTree(pool: string, leaves: number): Promise<TreeResult>;
  pathOf(pool: string, index: number): Promise<PathResult>;
  layersOf(pool: string): Promise<string[][]>;
}

/** a ready history older than this syncs again when asked for (ensure): a deposit made meanwhile is found without a reload */
export const STALE_MS = 60_000;
/** How many times a delta the pool's count says is short is asked again, with a halved window, before the sync fails. */
export const DELTA_ATTEMPTS = 6;
const hexBlock = (n: number): string => `0x${n.toString(16)}`;
/** The pool's `nextIndex()` at a block: the leaves a history synced to that block must hold. */
const nextIndexAt = async (rpc: Rpc, address: Hex, block: number): Promise<number> =>
  Number(wordOf(await call(rpc, address, SELECTORS.nextIndex, hexBlock(block))));

export type HistoryStatus =
  | { kind: "idle" }
  | { kind: "loading"; step: "stored" | "snapshot" | "tree" | "sync" | "verify"; loaded?: number; total?: number }
  | { kind: "ready"; toBlock: number; leaves: number; root: Hex; verified: boolean; verifiedAt: number; reason?: string }
  | { kind: "failed"; reason: string };

export interface PoolHistoryDeps {
  pool: PoolId;
  address: Hex;
  deployedBlock: number;
  /** null: no endpoint configured — the history is what the snapshot or the device holds, unverified */
  rpc: Rpc | null;
  tree: TreeClient;
  store: HistoryStore;
  fetchSnapshot: (pool: PoolId) => Promise<FetchedSnapshot | null>;
  now?: () => number;
  /** how old a ready history may be before ensure() syncs again (STALE_MS) */
  staleMs?: number;
  onStatus?: (s: HistoryStatus) => void;
}

export class PoolHistory {
  deposits: DepositEvent[] = [];
  withdrawals: WithdrawalEvent[] = [];
  manifest: SnapshotManifest | null = null;
  state: SyncState | null = null;
  status: HistoryStatus = { kind: "idle" };
  private root: Hex | null = null;
  private index: HistoryIndex | null = null;
  private running: Promise<HistoryStatus> | null = null;
  private syncedAt = 0;
  /** where the current state came from: the device's copy may be dropped and reloaded once; a served snapshot's block must stand */
  private origin: "stored" | "snapshot" | "chain" = "chain";

  constructor(private readonly d: PoolHistoryDeps) {}

  private set(status: HistoryStatus): HistoryStatus {
    this.status = status;
    this.d.onStatus?.(status);
    return status;
  }

  private events(deposits: DepositEvent[], withdrawals: WithdrawalEvent[]) {
    this.deposits = deposits;
    this.withdrawals = withdrawals;
    this.index = null;
  }

  /** Loads and syncs once; a ready history answers at once unless it is older than staleMs (then it syncs again), a run in progress is shared. */
  ensure(): Promise<HistoryStatus> {
    if (this.status.kind === "ready") {
      const stale = (this.d.now ?? Date.now)() - this.syncedAt > (this.d.staleMs ?? STALE_MS);
      return stale ? this.refresh() : Promise.resolve(this.status);
    }
    return (this.running ??= this.run(false).finally(() => {
      this.running = null;
    }));
  }

  /** Resolves once no load or sync is running (a flow reads `verified` after this, never in the middle of a sync). */
  settled(): Promise<void> {
    return this.running ? this.running.then(() => undefined) : Promise.resolve();
  }

  /** Syncs the delta again and verifies. */
  refresh(): Promise<HistoryStatus> {
    return (this.running ??= this.run(true).finally(() => {
      this.running = null;
    }));
  }

  private async run(again: boolean): Promise<HistoryStatus> {
    try {
      if (!this.state || !again) {
        if (!this.state) await this.load();
      }
      if (this.d.rpc) {
        await this.sync(this.d.rpc);
        const status = await this.verify(this.d.rpc);
        // the device's copy the chain does not know (the fourth review round, 2026-11-03): dropped for what is served, once in this run
        if (status.kind === "ready" && !status.verified && this.origin === "stored") {
          await this.d.store.clear(this.d.pool);
          this.state = null;
          this.origin = "chain";
          await this.load();
          await this.sync(this.d.rpc);
          return await this.verify(this.d.rpc);
        }
        return status;
      }
      await this.persist();
      return this.set({
        kind: "ready",
        toBlock: this.state!.toBlock,
        leaves: this.state!.leaves,
        root: this.root!,
        verified: false,
        verifiedAt: 0,
        reason: "no RPC endpoint is configured",
      });
    } catch (e) {
      return this.set({ kind: "failed", reason: e instanceof Error ? e.message : "the history could not be loaded" });
    }
  }

  /** The device's copy, else the served snapshot, else an empty history from the deployed block. */
  private async load(): Promise<void> {
    const { pool, address, tree, store } = this.d;
    this.set({ kind: "loading", step: "stored" });
    const stored = await store.read(pool);
    // a device copy the chain refused last time is no start (the fourth review round, 2026-11-03): it had been reloaded as it was at
    // every start — one wrong eth_getLogs answer, and withdrawals on the device stayed refused until its site data was cleared
    if (stored && stored.state.verified === false) await store.clear(pool);
    if (stored && stored.state.verified !== false && stored.state.address.toLowerCase() === address.toLowerCase() && stored.layers.length) {
      const r = await tree.loadTree(pool, stored.layers);
      this.manifest = stored.manifest;
      this.state = stored.state;
      this.events(stored.deposits, stored.withdrawals);
      this.root = r.root;
      this.origin = "stored";
      return;
    }
    this.set({ kind: "loading", step: "snapshot" });
    const snap = await this.d.fetchSnapshot(pool);
    if (snap) {
      const checked = await verifySnapshot(snap.manifest, snap.texts, { pool: { id: pool, address } });
      if (!checked.ok) throw new Error(`the served snapshot does not hold: ${checked.problems.join("; ")}`);
      this.set({ kind: "loading", step: "tree" });
      const r = await tree.loadTree(pool, checked.snapshot.treeFile.layers);
      if (r.root !== snap.manifest.root.toLowerCase()) throw new Error("the served snapshot's layers do not hash to its root");
      this.manifest = snap.manifest;
      this.events(checked.snapshot.deposits, checked.snapshot.withdrawals);
      this.state = {
        pool,
        address,
        toBlock: snap.manifest.toBlock,
        blockHash: snap.manifest.blockHash,
        leaves: snap.manifest.leaves,
        checkpoints: snap.manifest.blockHash ? [{ blockNumber: snap.manifest.toBlock, blockHash: snap.manifest.blockHash }] : [],
      };
      this.root = r.root;
      this.origin = "snapshot";
      return;
    }
    // nothing served: the whole history comes from the chain
    this.set({ kind: "loading", step: "tree" });
    const r = await tree.buildTree(pool, []);
    this.manifest = null;
    this.events([], []);
    this.state = { pool, address, toBlock: this.d.deployedBlock - 1, blockHash: null, leaves: 0, checkpoints: [] };
    this.root = r.root;
    this.origin = "chain";
  }

  /** The checkpoints asked of the chain, a rollback when one fell, then the delta appended. */
  private async sync(rpc: Rpc): Promise<void> {
    const { pool, address, tree } = this.d;
    const state = this.state!;
    this.set({ kind: "loading", step: "sync" });
    if (state.checkpoints.length) {
      const reorg = await findReorg(rpc, state.checkpoints);
      if (!reorg.intact) {
        if (!reorg.rollbackTo) {
          // nothing of what we hold stands: the device's copy is dropped for what is served, once; a served snapshot whose
          // own block the chain does not confirm was made on another chain and is refused
          if (this.origin !== "stored") throw new Error("the snapshot's block is not on this chain");
          await this.d.store.clear(pool);
          this.state = null;
          await this.load();
          return this.sync(rpc);
        }
        const keepDeposits = eventsUpTo(this.deposits, reorg.rollbackTo.blockNumber);
        this.events(keepDeposits, eventsUpTo(this.withdrawals, reorg.rollbackTo.blockNumber));
        const r = await this.withTree(() => tree.truncateTree(pool, keepDeposits.length));
        this.root = r.root;
        this.state = {
          ...state,
          toBlock: reorg.rollbackTo.blockNumber,
          blockHash: reorg.rollbackTo.blockHash,
          leaves: keepDeposits.length,
          checkpoints: state.checkpoints.filter((c) => c.blockNumber <= reorg.rollbackTo!.blockNumber),
        };
      }
    }
    const current = this.state!;
    const head = await headBlockOf(rpc);
    // the delta is taken only when the pool's own count at the delta's block agrees with the leaves it would make (the review
    // round of 2026-11-02): an endpoint that caps eth_getLogs and answers short with no error would otherwise leave a short
    // history, persisted at an advanced block and past repair. A short answer halves the window and asks again; a chain that
    // counts fewer than this history holds, or a shortfall that stays, fails the sync with both counts — nothing persisted
    let window = current.window;
    let delta: Awaited<ReturnType<typeof syncDelta>>;
    for (let attempt = 1; ; attempt++) {
      delta = await syncDelta({
        rpc,
        address,
        fromBlock: current.toBlock,
        leaves: current.leaves,
        headBlock: head,
        window,
        onWindow: (w) => this.set({ kind: "loading", step: "sync", loaded: w.to - current.toBlock, total: head - 12 - current.toBlock }),
      });
      const counted = await nextIndexAt(rpc, address, delta.toBlock);
      const made = current.leaves + delta.deposits.length;
      if (counted === made) break;
      const detail = `the pool counts ${counted} deposits at block ${delta.toBlock}, the endpoint's logs make ${made}`;
      if (counted < made) throw new SyncError(`${detail}: this history is not the chain's`, "gap");
      const used = window ?? delta.window;
      if (attempt >= DELTA_ATTEMPTS || used <= MIN_WINDOW) throw new SyncError(`${detail}: the endpoint's logs come short (try another endpoint)`, "gap");
      window = Math.max(MIN_WINDOW, Math.floor(used / 2));
    }
    if (delta.deposits.length) {
      const r = await this.withTree(() =>
        tree.appendLeaves(
          pool,
          delta.deposits.map((d) => d.commitment),
        ),
      );
      this.root = r.root;
    }
    if (delta.deposits.length || delta.withdrawals.length) this.events([...this.deposits, ...delta.deposits], [...this.withdrawals, ...delta.withdrawals]);
    this.state = {
      ...current,
      toBlock: delta.toBlock,
      blockHash: delta.blockHash ?? current.blockHash,
      leaves: current.leaves + delta.deposits.length,
      checkpoints: mergeCheckpoints(current.checkpoints, delta.checkpoints),
      window: delta.window,
    };
  }

  /** The one check, then the device's copy written. */
  private async verify(rpc: Rpc): Promise<HistoryStatus> {
    const { address } = this.d;
    this.set({ kind: "loading", step: "verify" });
    const state = this.state!;
    // at the history's own block (the review round of 2026-11-02): read at `latest`, a deposit of the last twelve blocks had
    // made the count disagree with a history that was right up to its block
    const chain = await verifyAgainstChain(rpc, address, { root: BigInt(this.root!), size: state.leaves }, hexBlock(state.toBlock), { exact: true });
    const now = (this.d.now ?? Date.now)();
    this.syncedAt = now;
    this.state = { ...state, verifiedAt: now, verified: chain.ok };
    await this.persist();
    return this.set({
      kind: "ready",
      toBlock: state.toBlock,
      leaves: state.leaves,
      root: this.root!,
      verified: chain.ok,
      verifiedAt: now,
      ...(chain.ok
        ? {}
        : {
            reason:
              chain.reason === "leaf count"
                ? `the chain counts ${chain.nextIndex} deposits, this history ${state.leaves}`
                : chain.reason === "root not last"
                  ? "the pool's root at this history's block is another one"
                  : "the pool does not know this history's root",
          }),
    });
  }

  private async persist(): Promise<void> {
    const { pool, tree, store } = this.d;
    if (!this.state) return;
    const layers = await tree.layersOf(pool);
    await store.write(pool, { manifest: this.manifest, state: this.state, deposits: this.deposits, withdrawals: this.withdrawals, layers });
  }

  /** The deposit a commitment names, and whether the Withdrawal history holds the nullifier hash. */
  lookup(commitment: Hex, nullifierHash: Hex): DepositFacts | null {
    this.index ??= indexHistory(this.deposits, this.withdrawals);
    return depositFacts(this.index, commitment, nullifierHash);
  }

  /** Whether the synced Withdrawal events hold this transaction (a relayer's CONFIRMED is believed once they do; the tenth review round, C10-3). */
  hasWithdrawalTx(txHash: string): boolean {
    const h = txHash.toLowerCase();
    return this.withdrawals.some((w) => w.transactionHash.toLowerCase() === h);
  }

  /** The original's statistics: the count and the newest ten. */
  stats(): PoolStats {
    const latest = this.deposits
      .slice(-10)
      .reverse()
      .map((d) => ({ leafIndex: d.leafIndex, timestamp: d.timestamp }));
    return { deposits: this.deposits.length, latest };
  }

  pathFor(leafIndex: number): Promise<PathResult> {
    return this.withTree(() => this.d.tree.pathOf(this.d.pool, leafIndex));
  }

  /**
   * A tree call, repeated once after the tree is loaded again from the device's copy when the worker lost it (the review round of
   * 2026-11-03, C2-9): a crashed prover worker is replaced by a fresh one with no trees, and every path and sync had failed
   * from then until a reload of the page.
   */
  private async withTree<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // a tree whose path does not fold to its root (the fifth review round, 2026-11-03): the device's or a served copy with wrong
      // inner nodes under the right root word. Rebuilt once from the deposits the chain agreed with (by root and count), persisted,
      // and the call made again; before, the stored copy's verified flag stood and every withdrawal failed with the note blamed
      if (message.includes(TREE_INCONSISTENT)) {
        await this.d.store.clear(this.d.pool);
        const r = await this.d.tree.buildTree(
          this.d.pool,
          this.deposits.map((d) => d.commitment),
        );
        this.root = r.root;
        await this.persist();
        return await fn();
      }
      if (!/no tree for .* is loaded/.test(message)) throw e;
      const stored = await this.d.store.read(this.d.pool);
      if (!stored?.layers.length) throw e;
      const r = await this.d.tree.loadTree(this.d.pool, stored.layers);
      this.root = r.root;
      return await fn();
    }
  }

  currentRoot(): Hex | null {
    return this.root;
  }

  /** Whether the history is ready and the chain agreed with it (a withdrawal needs both; spec §7.4). */
  get verified(): boolean {
    return this.status.kind === "ready" && this.status.verified;
  }
}
