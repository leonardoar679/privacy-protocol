// A pool's history in the app (spec v3.0 §7.4; V7 Stage 9): what the device kept, else the served snapshot, then the
// delta from the chain, then the one check — the recomputed root a root the pool knows and the leaf count its
// nextIndex. The tree lives in the prover worker (loaded from persisted layers, appended, asked for a path, built again
// when a worker lost it); the events live here for lookups and the statistics; both are kept in the app's own IndexedDB.
// A note never enters this module: a lookup takes a commitment and a nullifier hash the worker derived.
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
  /**
   * the first configured endpoint alone, asked the root and the count when a second is configured (the eleventh review round's critique of
   * C11-12): `rpc` fails over, and the second endpoint had answered for the first, then agreed with itself
   */
  firstOpinion?: Rpc | null;
  /**
   * the endpoints after the first (the eleventh review round, 2026-11-04, C11-12): asked the root and the count at the history's own block, which
   * single out no user. A disagreement or a silence leaves the history unverified for the page: the device's copy is kept, and both are asked
   * again at the next sync. Every sync asks both: a withdrawal never verifies a history on the first endpoint's word alone (the critique — a
   * lying first endpoint had its forged root submitted); a relayed one whose root aged out is refused instead, and a relayed one holds its
   * pool's history from syncing until it ends — and IN_FLIGHT_HOLD_MS past an end before its relayer's outcome (hold, holdFor; flows.ts)
   */
  secondOpinion?: Rpc | null;
  /**
   * until when this pool's history is held by the device's own records — an unsettled relayed withdrawal of this page, an earlier one or
   * another tab (the critique of the critique of C11-9: the hold had lived in one page's memory, and a reload synced at once): read at every
   * run, before anything is asked of the endpoints
   */
  heldFrom?: () => Promise<number>;
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
  /** relayed withdrawals running on this pool (hold) */
  private holds = 0;
  /** held until then as well: a relayed withdrawal that ended before its relayer's outcome (holdFor) */
  private heldUntil = 0;
  /** and until then by the device's records, as read at the last run (heldFrom) */
  private recordsUntil = 0;
  /** marked stale by a refused withdrawal, until the next sync (markStale) */
  private stale = false;
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

  /**
   * Loads and syncs once; a ready history answers at once unless it is older than staleMs (then it syncs again), a run in progress is shared.
   * While held, a ready history answers as it is and one not loaded yet loads, asking the endpoints nothing (run); the device's records are
   * read again at each run, so a hold of theirs ends there once its withdrawal settled.
   */
  ensure(): Promise<HistoryStatus> {
    if (this.heldHere() && this.status.kind === "ready") return this.running ?? Promise.resolve(this.status);
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

  /** Syncs the delta again and verifies (while held, nothing new starts: see ensure). */
  refresh(): Promise<HistoryStatus> {
    if (this.heldHere() && this.status.kind === "ready") return this.running ?? Promise.resolve(this.status);
    return (this.running ??= this.run(true).finally(() => {
      this.running = null;
    }));
  }

  /**
   * Holds the history from syncing until the returned release is called (the eleventh review round's critique of C11-9): a relayed
   * withdrawal's own record writes had re-run the statistics, whose ensure() synced a stale history with both endpoints — the second
   * endpoint asked the proof's root between the Withdraw click and the submission. Releasing twice is harmless.
   */
  hold(): () => void {
    this.holds++;
    let held = true;
    return () => {
      if (held) this.holds--;
      held = false;
    };
  }

  /**
   * Held `ms` longer from now, whatever holds are released meanwhile (the critique of the critique of C11-9): a relayed withdrawal that ended
   * before its relayer's outcome — its answer lost, its job no longer followed — may still be published, and the sync right after the flow had
   * asked the second endpoint its root first.
   */
  holdFor(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, (this.d.now ?? Date.now)() + ms);
  }

  /** This page's own hold: a withdrawal running on it, or one that ended unsettled (holdFor). */
  private heldHere(): boolean {
    return this.holds > 0 || (this.d.now ?? Date.now)() < this.heldUntil;
  }

  /** Held by this page, or by the device's records as last read. */
  private held(): boolean {
    return this.heldHere() || (this.d.now ?? Date.now)() < this.recordsUntil;
  }

  /** Whether the history is held now: a withdrawal on it, or an unsettled relayed one (Check on chain then asks the first endpoint alone). */
  isHeld(): boolean {
    return this.held();
  }

  /**
   * A held history's status: the device's copy with its own verdict — both endpoints agreed with it when it was stored —, anything else
   * unverified until the hold ends; it syncs at the first ensure() after (syncedAt is left as it is).
   */
  private heldStatus(): HistoryStatus {
    const state = this.state!;
    const verified = this.origin === "stored" && state.verified === true;
    return this.set({
      kind: "ready",
      toBlock: state.toBlock,
      leaves: state.leaves,
      root: this.root!,
      verified,
      verifiedAt: state.verifiedAt ?? 0,
      ...(verified ? {} : { reason: "the history is not synced while a relayed withdrawal's outcome is not known yet: it is synced after" }),
    });
  }

  /** The next ensure() syncs again: a withdrawal refused because the pool's roots moved on (flows.ts) is tried again on a fresh history. */
  markStale(): void {
    this.syncedAt = 0;
    this.stale = true;
  }

  /** Whether a refusal marked the history stale and no sync has run since (the next withdrawal syncs first: flows.ts withdrawalFlow). */
  needsSync(): boolean {
    return this.stale;
  }

  private async run(again: boolean): Promise<HistoryStatus> {
    try {
      if (!this.state || !again) {
        if (!this.state) await this.load();
      }
      // the device's records read again (the critique: a page already open when another started a relayed withdrawal had synced during it); a
      // read that fails keeps the last one
      if (this.d.rpc && this.d.heldFrom) this.recordsUntil = await this.d.heldFrom().catch(() => this.recordsUntil);
      // held: a ready history as it is, else what the device holds, the endpoints asked nothing (the critique: a page reloaded during an
      // unsettled relayed withdrawal's hold had synced at once — or, held before it loaded, never loaded at all)
      if (this.d.rpc && this.held()) return this.status.kind === "ready" ? this.status : this.heldStatus();
      if (this.d.rpc) {
        await this.sync(this.d.rpc);
        const status = await this.verify(this.d.rpc);
        // the device's copy the chain does not know (the fourth review round, 2026-11-03): dropped for what is served, once in this run — on the
        // first endpoint's refusal only; the second endpoint's disagreement or silence is this page's (the critique of C11-12)
        if (this.state?.verified === false && this.origin === "stored") {
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
      // a copy this device built from its leaves loads as it is; one from before that rule is hashed once (the eleventh review round, C11-2):
      // a snapshot's layers had been stored as served, one leaf swapped under the real inner nodes verified, and loaded so at every start
      const r = stored.state.hashed
        ? await tree.loadTree(pool, stored.layers)
        : await tree.buildTree(
            pool,
            stored.deposits.map((d) => d.commitment),
          );
      this.manifest = stored.manifest;
      this.state = { ...stored.state, hashed: true };
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
      // the tree is built from the snapshot's leaves, never loaded from its layers (the eleventh review round, C11-2): the layers were checked
      // against the leaves' list and the root word only — no hashing —, so one deposit's commitment swapped under the real inner nodes and
      // root passed the chain's check too, and its note read "no deposit" for good. About n hashes, once: the device keeps its own copy
      const r = await tree.buildTree(
        pool,
        checked.snapshot.deposits.map((d) => d.commitment),
      );
      if (r.root !== snap.manifest.root.toLowerCase()) throw new Error("the served snapshot's deposits do not hash to its root");
      this.manifest = snap.manifest;
      this.events(checked.snapshot.deposits, checked.snapshot.withdrawals);
      this.state = {
        pool,
        address,
        toBlock: snap.manifest.toBlock,
        blockHash: snap.manifest.blockHash,
        leaves: snap.manifest.leaves,
        checkpoints: snap.manifest.blockHash ? [{ blockNumber: snap.manifest.toBlock, blockHash: snap.manifest.blockHash }] : [],
        hashed: true,
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
    this.state = { pool, address, toBlock: this.d.deployedBlock - 1, blockHash: null, leaves: 0, checkpoints: [], hashed: true };
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
        const keepWithdrawals = eventsUpTo(this.withdrawals, reorg.rollbackTo.blockNumber);
        // the tree cut first, the events after: a tree built again meanwhile is the one of the deposits held (reloadTree)
        const r = await this.withTree(() => tree.truncateTree(pool, keepDeposits.length));
        this.events(keepDeposits, keepWithdrawals);
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
    const held = { root: BigInt(this.root!), size: state.leaves };
    const second = this.d.secondOpinion ?? null;
    // with a second endpoint, the first is asked alone (the critique of C11-12): the failover had let the second answer for it
    const first = second ? (this.d.firstOpinion ?? rpc) : rpc;
    // at the history's own block (the review round of 2026-11-02): read at `latest`, a deposit of the last twelve blocks had
    // made the count disagree with a history that was right up to its block
    let chain: Awaited<ReturnType<typeof verifyAgainstChain>> | null;
    try {
      chain = await verifyAgainstChain(first, address, held, hexBlock(state.toBlock), { exact: true });
    } catch (e) {
      // one endpoint configured: its silence fails the run, as before; with two, the history is unverified for the page
      if (!second) throw e;
      chain = null;
    }
    // the second endpoint's word on the same block (C11-12): one lying endpoint had alone decided what a note was found or missing
    const seconded =
      chain?.ok && second ? await verifyAgainstChain(second, address, held, hexBlock(state.toBlock), { exact: true }).catch(() => null) : undefined;
    const now = (this.d.now ?? Date.now)();
    this.syncedAt = now;
    this.stale = false;
    const ok = !!chain?.ok && (seconded === undefined || !!seconded?.ok);
    // the copy's own verdict is the first endpoint's answer; its silence, or the second endpoint's disagreement or silence, is this page's — the
    // copy is kept unmarked, and both are asked again at the next sync (the critique of C11-12: a second endpoint that was down had the copy
    // dropped, and every tree hashed again, at every start)
    const verdict = chain === null ? undefined : !chain.ok ? false : ok ? true : undefined;
    this.state = { ...state, verifiedAt: now, verified: verdict };
    await this.persist();
    return this.set({
      kind: "ready",
      toBlock: state.toBlock,
      leaves: state.leaves,
      root: this.root!,
      verified: ok,
      verifiedAt: now,
      ...(ok
        ? {}
        : {
            reason:
              chain === null
                ? "the first RPC endpoint did not answer: the history is checked again at the next sync"
                : !chain.ok
                  ? chain.reason === "leaf count"
                    ? `the chain counts ${chain.nextIndex} deposits, this history ${state.leaves}`
                    : chain.reason === "root not last"
                      ? "the pool's root at this history's block is another one"
                      : "the pool does not know this history's root"
                  : seconded === null
                    ? "the second RPC endpoint did not answer: the history is checked again at the next sync"
                    : "the second RPC endpoint does not agree with this history at its block",
          }),
    });
  }

  private async persist(): Promise<void> {
    const { pool, tree, store } = this.d;
    if (!this.state) return;
    // through withTree (the critique of the eleventh review round's C11-6): a worker retired by a close holds no tree, and the history had failed here
    const layers = await this.withTree(() => tree.layersOf(pool));
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

  /**
   * The synced Withdrawal event a predicate on its nullifier hash names, if any (the eleventh review round, C11-1, VC-N1) — newest first, and
   * from `fromBlock` on (the critique: a record's keyed digest had been computed for every event of the pool at every History read, a second on
   * a phone for 50,000). The events are in block order: a snapshot's are refused otherwise, and a sync appends.
   */
  findWithdrawal(named: (nullifierHash: string) => boolean, txHash?: string, fromBlock?: number, relayer?: string): WithdrawalEvent | null {
    const h = txHash?.toLowerCase();
    const paid = relayer?.toLowerCase();
    for (let i = this.withdrawals.length - 1; i >= 0; i--) {
      const w = this.withdrawals[i];
      if (fromBlock !== undefined && w.blockNumber < fromBlock) break;
      // paid to this relayer when one is named (the critique: the note's later withdrawal through another had completed a record it never made)
      if (paid !== undefined && w.relayer !== null && w.relayer.toLowerCase() !== paid) continue;
      if ((h === undefined || w.transactionHash.toLowerCase() === h) && named(w.nullifierHash)) return w;
    }
    return null;
  }

  /** The original's statistics: the count and the newest ten. */
  stats(): PoolStats {
    const latest = this.deposits
      .slice(-10)
      .reverse()
      .map((d) => ({ leafIndex: d.leafIndex, timestamp: d.timestamp }));
    return { deposits: this.deposits.length, latest, verified: this.verified };
  }

  pathFor(leafIndex: number): Promise<PathResult> {
    return this.withTree(() => this.d.tree.pathOf(this.d.pool, leafIndex));
  }

  /**
   * A tree call, repeated once after the tree is loaded again when the worker lost it (the review round of 2026-11-03, C2-9): a crashed prover
   * worker is replaced by a fresh one with no trees — as is a worker a close retired (the eleventh review round's critique of C11-6) — and
   * every path and sync had failed from then until a reload of the page.
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
      await this.reloadTree();
      return await fn();
    }
  }

  /**
   * This history's tree again, in a worker that holds none: the device's copy when it is this history's own — hashed here, the same count, the
   * same root once loaded — else built from the deposits the history holds (the critique of C11-6 and C11-2: only a device copy had been
   * reloaded, so a first load whose worker a close retired lost its tree for good; and a copy is trusted only once this device hashed it).
   */
  private async reloadTree(): Promise<void> {
    const { pool, tree, store } = this.d;
    const stored = await store.read(pool).catch(() => null);
    if (stored?.state.hashed && stored.layers.length && stored.state.leaves === this.deposits.length) {
      const r = await tree.loadTree(pool, stored.layers);
      if (r.root === this.root) return;
    }
    const r = await tree.buildTree(
      pool,
      this.deposits.map((d) => d.commitment),
    );
    this.root = r.root;
  }

  currentRoot(): Hex | null {
    return this.root;
  }

  /** Whether the history is ready and the chain agreed with it (a withdrawal needs both; spec §7.4). */
  get verified(): boolean {
    return this.status.kind === "ready" && this.status.verified;
  }
}
