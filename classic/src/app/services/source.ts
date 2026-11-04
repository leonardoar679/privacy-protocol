// The app's services and the data source behind the screens (spec v3.0 §7.4–§7.7; V7 Stage 9): the JSON-RPC
// transport over the configured endpoints, the prover worker (lazily), each pool's history, the relayer directory, the
// wallet session, the records store, the contract and router facts — and ClassicSource over them, the interface the
// screens have read since Stage 3 (the mock keeps implementing it for the fixtures and the tests). The tests hand in
// scripted pieces through `overrides`.
import { config as readConfig, isLive, POOL_IDS, type ClassicConfig, type PoolId } from "../../config";
import type { Hex } from "../../history/events";
import type { Rpc } from "../../history/sync";
import { availabilityOf, type AvailabilityFacts, type ContractFact, type ProverFact, type RouterFact } from "../../model/availability";
import { formatNote, type ClassicNote } from "../../model/notes";
import { DEPLOYMENT, POOLS, poolFor, poolOf } from "../../model/pools";
import type { ClassicSource } from "../../model/source";
import type { Availability, ConnectionState, HistoryRow, NoteLookup, PoolStats, RelayerInfo } from "../../model/types";
import { fetchSnapshot as fetchSnapshotFromHost, type FetchedSnapshot } from "../../net/snapshot";
import { relayerTransport } from "../../net/relayer";
import { makeRpc } from "../../net/rpc";
import type { ProverClient } from "../../prover/client";
import { jobOf, type followJob, type RelayerTransport } from "../../relayer/client";
import type { waitForReceipt } from "../../wallet/connection";
import { CURATED_RELAYERS, type CuratedRelayer } from "../../relayer/curated";
import { historyStore, jobsStore, type HistoryStore, type JobsStore, memoryJobsStore } from "../../storage/historyDb";
import { prover as appProver } from "../prover";
import { checkPoolContract, routerInstanceState } from "./contract";
import { gasPriceWei } from "./gas";
import { PoolHistory, type HistoryStatus, type TreeClient } from "./history";
import { fromRelayerState, toHistoryRow, type JobRecord } from "./operations";
import { RelayerDirectory } from "./relayers";
import { WalletSession } from "./wallet";

/** What the flows and the source need of the prover worker (the ProverClient has it all). */
export type ProverLike = Pick<ProverClient, "warm" | "prove" | "verify" | "note"> & Partial<Pick<ProverClient, "close">> & TreeClient; // close: the flows stop the worker after a terminal record (the fifth review round, 2026-11-03)

export interface ClassicServices {
  config: ClassicConfig;
  rpc: Rpc | null;
  /** a second endpoint's word, read before a wallet-mode send (the fifth review round, 2026-11-03); null with one endpoint configured */
  secondOpinion: Rpc | null;
  prover: () => Promise<ProverLike>;
  histories: Map<PoolId, PoolHistory>;
  relayers: RelayerDirectory;
  relayerTransport: RelayerTransport;
  wallet: WalletSession;
  /** the device's records of its relayed and wallet-mode withdrawals (IndexedDB) */
  jobs: JobsStore;
  /** the page's records of its deposits, never persisted (the fourth review round, 2026-11-03; spec v3.0 §7.8 "never a deposit record"): a
   *  deposit row beside a withdrawal row on one device is the link the pool exists to hide */
  depositJobs: JobsStore;
  now: () => number;
  /** the facts the availability rows show, refreshed by `checkPool` */
  facts: Map<PoolId, { contract: ContractFact; router: RouterFact }>;
  proverFact: ProverFact;
  /** reads the pool's code and the router's instance state once (then cached for the page) */
  checkPool(pool: PoolId): Promise<void>;
  /** warms the prover and records the fact */
  warmProver(): Promise<void>;
  /** every change the screens should redraw for */
  onChange(listener: () => void): () => void;
  /** how a relayer's job is followed and a receipt awaited (the tests shorten the waits) */
  followOptions?: FollowOptions;
  receiptOptions?: ReceiptOptions;
}

export type FollowOptions = Parameters<typeof followJob>[3];
export type ReceiptOptions = Parameters<typeof waitForReceipt>[2];

export interface ServiceOverrides {
  config?: ClassicConfig;
  rpc?: Rpc | null;
  secondOpinion?: Rpc | null;
  prover?: () => Promise<ProverLike>;
  historyStore?: HistoryStore;
  jobs?: JobsStore;
  /** the page's deposit records (a memory store unless a test passes one) */
  depositJobs?: JobsStore;
  fetchSnapshot?: (pool: PoolId) => Promise<FetchedSnapshot | null>;
  relayerTransport?: RelayerTransport;
  curated?: readonly CuratedRelayer[];
  wallet?: WalletSession;
  now?: () => number;
  /** at most this many relayer status requests in flight */
  relayerConcurrency?: number;
  followOptions?: FollowOptions;
  receiptOptions?: ReceiptOptions;
}

/**
 * The relayers the build names beside the curated list (VITE_CLASSIC_RELAYER_URLS — hosts the policy already allows): no
 * registry record, so the reward account is whatever their status says and the rules skip that one check. The local stack's
 * stand-in reaches the app this way; a release names none (spec v3.0 §7.5, §7.9). A curated host is not listed twice.
 */
export function configuredRelayers(config: ClassicConfig, curated: readonly CuratedRelayer[] = CURATED_RELAYERS): CuratedRelayer[] {
  const known = new Set(curated.map((r) => r.url.replace(/\/+$/, "").toLowerCase()));
  const out: CuratedRelayer[] = [];
  for (const raw of config.relayerUrls) {
    const url = raw.replace(/\/+$/, "");
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (!host || known.has(url.toLowerCase())) continue;
    known.add(url.toLowerCase());
    out.push({ ensName: host, relayerAddress: "", url, rewardAccount: "", stakeTorn: "0", feePercent: 0, version: "", currentQueue: 0 });
  }
  return out;
}

export function createServices(o: ServiceOverrides = {}): ClassicServices {
  const config = o.config ?? readConfig();
  const rpc = o.rpc !== undefined ? o.rpc : config.rpcUrls.length ? makeRpc(config.rpcUrls) : null;
  // the endpoints after the first, asked once more before a wallet-mode send (the fifth review round, 2026-11-03)
  const secondOpinion =
    o.secondOpinion !== undefined ? o.secondOpinion : o.rpc !== undefined ? null : config.rpcUrls.length >= 2 ? makeRpc(config.rpcUrls.slice(1)) : null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  const store = o.historyStore ?? historyStore();
  const prover = o.prover ?? (() => appProver() as Promise<ProverLike>);
  const fetchSnapshot = o.fetchSnapshot ?? ((pool: PoolId) => fetchSnapshotFromHost(config.dataBase, pool));
  const now = o.now ?? (() => Date.now());
  const treeClient: TreeClient = {
    loadTree: (pool, layers) => prover().then((p) => p.loadTree(pool, layers)),
    buildTree: (pool, leaves, onProgress) => prover().then((p) => p.buildTree(pool, leaves, onProgress)),
    appendLeaves: (pool, leaves) => prover().then((p) => p.appendLeaves(pool, leaves)),
    truncateTree: (pool, leaves) => prover().then((p) => p.truncateTree(pool, leaves)),
    pathOf: (pool, index) => prover().then((p) => p.pathOf(pool, index)),
    layersOf: (pool) => prover().then((p) => p.layersOf(pool)),
  };
  const histories = new Map<PoolId, PoolHistory>(
    POOLS.map((p) => [
      p.id,
      // a development chain (VITE_CLASSIC_DEPLOYED_BLOCK) places the pools at its own block; mainnet's deployed blocks otherwise
      new PoolHistory({
        pool: p.id,
        address: p.address,
        deployedBlock: config.deployedBlock ?? p.deployedBlock,
        rpc,
        tree: treeClient,
        store,
        fetchSnapshot,
        now,
        onStatus: changed,
      }),
    ]),
  );
  const transport = o.relayerTransport ?? relayerTransport();
  const relayers = new RelayerDirectory({
    // the curated list — unless a development chain switched it off: it must not ask mainnet's relayers — plus the build's own
    curated: o.curated ?? [...(config.curatedRelayers ? CURATED_RELAYERS : []), ...configuredRelayers(config)],
    transport,
    netId: config.chainId,
    pools: POOLS.map((p) => ({ address: p.address, amount: p.amount })),
    now,
    onChange: changed,
    concurrency: o.relayerConcurrency ?? 2,
  });
  const wallet = o.wallet ?? new WalletSession({ router: DEPLOYMENT.router.address as Hex, expectedChainId: config.chainId, onChange: changed });
  const facts = new Map<PoolId, { contract: ContractFact; router: RouterFact }>(POOL_IDS.map((id) => [id, { contract: "unknown", router: "unknown" }]));
  const checks = new Map<PoolId, Promise<void>>();
  const services: ClassicServices = {
    config,
    rpc,
    secondOpinion,
    prover,
    histories,
    relayers,
    relayerTransport: transport,
    wallet,
    jobs: o.jobs ?? jobsStore(),
    depositJobs: o.depositJobs ?? memoryJobsStore(),
    now,
    facts,
    proverFact: "idle",
    ...(o.followOptions ? { followOptions: o.followOptions } : {}),
    ...(o.receiptOptions ? { receiptOptions: o.receiptOptions } : {}),
    checkPool(pool) {
      let run = checks.get(pool);
      if (!run) {
        run = (async () => {
          if (!rpc) return;
          facts.set(pool, { contract: "checking", router: "checking" });
          changed();
          const p = poolOf(pool);
          const pin = DEPLOYMENT.pools[pool];
          const [contract, router] = await Promise.all([
            checkPoolContract(rpc, p, { runtimeSha256: pin.runtime.sha256, verifier: pin.verifier, levels: pin.levels, denominationWei: pin.denominationWei })
              .then((r): ContractFact => (r.ok ? "verified" : "differs"))
              .catch((): ContractFact => "unknown"),
            routerInstanceState(rpc, DEPLOYMENT.router.instanceRegistry as Hex, p.address)
              .then((s): RouterFact => s)
              .catch((): RouterFact => "unknown"),
          ]);
          facts.set(pool, { contract, router });
          changed();
        })();
        checks.set(pool, run);
      }
      return run;
    },
    async warmProver() {
      if (services.proverFact === "ready" || services.proverFact === "loading") return;
      services.proverFact = "loading";
      changed();
      try {
        await (await prover()).warm();
        services.proverFact = "ready";
      } catch {
        services.proverFact = "failed";
      }
      changed();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return services;
}

const historyFact = (status: HistoryStatus): AvailabilityFacts["history"] =>
  status.kind === "ready"
    ? { kind: "ready", toBlock: status.toBlock, verified: status.verified }
    : status.kind === "loading"
      ? { kind: "loading" }
      : status.kind === "failed"
        ? { kind: "failed" }
        : { kind: "idle" };

export function factsOf(s: ClassicServices, pool: PoolId): AvailabilityFacts {
  const f = s.facts.get(pool) ?? { contract: "unknown" as const, router: "unknown" as const };
  return {
    rpcConfigured: s.rpc !== null,
    contract: f.contract,
    router: f.router,
    relayersOnline: s.relayers.onlineCount(),
    history: historyFact(s.histories.get(pool)?.status ?? { kind: "idle" }),
    prover: s.proverFact,
    wallet: s.wallet.state as ConnectionState,
  };
}

/**
 * A deposit whose receipt did not arrive in time, or is still awaited, is read again when the history is read (the fourth review
 * round, 2026-11-03): an underpriced deposit mined later had left a "Failed" row for a deposit that exists. Through the connected
 * wallet (the tenth review round, C10-12): the app's endpoint asked for the deposit's own hash had learned this IP made it.
 */
async function refreshDepositJobs(s: ClassicServices): Promise<void> {
  const rpc = receiptRpcOf(s);
  if (!rpc) return;
  for (const job of await s.depositJobs.list()) {
    if (
      job.kind !== "deposit" ||
      !job.txHash ||
      !(job.state === "SOURCE_CONFIRMING" || (job.state === "FAILED" && /not mined in time|never came/.test(job.failedReason ?? "")))
    )
      continue;
    try {
      const receipt = (await rpc("eth_getTransactionReceipt", [job.txHash])) as { status?: string; blockNumber?: string } | null;
      if (!receipt?.blockNumber) continue;
      const ok = receipt.status === "0x1";
      const { failedReason: _dropped, ...rest } = job;
      void _dropped;
      await s.depositJobs.put({ ...rest, state: ok ? "COMPLETED" : "FAILED", updatedAt: s.now(), ...(ok ? {} : { failedReason: "the transaction reverted" }) });
    } catch {
      // the endpoint did not answer: the record stays as it is
    }
  }
}

/**
 * A relayed withdrawal whose page is gone is asked about again when the history is read (the review round of 2026-11-03, C2-8). The
 * relayer's CONFIRMED completes the record only once the pool's synced Withdrawal events hold its transaction (the tenth review round,
 * C10-3): a relayer that answered CONFIRMED and sent nothing had the record read "Confirmed" — and a user discards a note withdrawn.
 * Until then the row reads "reported by the relayer". The relayer's free text is kept short and plain (C10-15).
 */
const OPEN_RELAYED = new Set(["SUBMITTING", "SOURCE_CONFIRMING", "RECOVERY_REQUIRED"]);
async function refreshRelayedJobs(s: ClassicServices): Promise<void> {
  for (const job of await s.jobs.list()) {
    if (job.kind !== "withdrawal" || !job.relayerUrl || !job.relayerJobId || !OPEN_RELAYED.has(job.state)) continue;
    try {
      const j = await jobOf(s.relayerTransport, job.relayerUrl, job.relayerJobId); // never a submission: the job is read, nothing sent
      const txHash = (j.txHash as Hex | null) ?? job.txHash;
      let next = fromRelayerState(j.status);
      if (next === "COMPLETED") {
        const h = s.histories.get(job.pool);
        if (h && txHash) await h.ensure().catch(() => undefined);
        if (!(h && txHash && h.hasWithdrawalTx(txHash))) next = job.state === "SUBMITTING" ? "SOURCE_CONFIRMING" : job.state;
      }
      await s.jobs.put({
        ...job,
        relayerState: j.status,
        txHash,
        state: next,
        updatedAt: s.now(),
        ...(j.failedReason ? { failedReason: plainText(j.failedReason) } : {}),
      });
    } catch {
      // the relayer did not answer: the record stays as it is
    }
  }
}

/**
 * Receipts of the user's own transactions through the connected wallet's provider (the tenth review round, C10-12): the app's endpoint
 * asked for a deposit's own hash had learned that this IP made that deposit; the wallet's node sent it and knows it already. The app's
 * endpoint answers only a call the wallet does not.
 */
export function receiptRpcOf(s: ClassicServices): Rpc | null {
  const own = s.wallet.receiptRpc();
  const app = s.rpc;
  if (!own) return app;
  if (!app) return own;
  return async (method, params) => {
    try {
      return await own(method, params);
    } catch {
      return app(method, params);
    }
  };
}

/** A relayer's or a wallet's free text as the records keep it: one line, printable, at most 160 characters (the tenth review round, C10-15). */
export const plainText = (s: string): string => {
  const line = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

/**
 * A wallet-mode withdrawal whose receipt did not come in time is read again when the history is read, through the connected wallet (the
 * tenth review round, C10-15): nothing had read it again, and the row had stayed "the relayer's answer did not arrive" for good.
 */
async function refreshWalletWithdrawals(s: ClassicServices): Promise<void> {
  const rpc = receiptRpcOf(s);
  if (!rpc) return;
  for (const job of await s.jobs.list()) {
    if (job.kind !== "withdrawal" || job.via !== "wallet" || !job.txHash || !(job.state === "SOURCE_CONFIRMING" || job.state === "RECOVERY_REQUIRED")) continue;
    try {
      const receipt = (await rpc("eth_getTransactionReceipt", [job.txHash])) as { status?: string; blockNumber?: string } | null;
      if (!receipt?.blockNumber) continue;
      const ok = receipt.status === "0x1";
      const { failedReason: _dropped, ...rest } = job;
      void _dropped;
      await s.jobs.put({ ...rest, state: ok ? "COMPLETED" : "FAILED", updatedAt: s.now(), ...(ok ? {} : { failedReason: "the transaction reverted" }) });
    } catch {
      // the wallet did not answer: the record stays as it is
    }
  }
}

/** The screens' data over the services. A lookup derives the note's hashes in the worker; the note itself stays in memory. */
export function sourceOf(s: ClassicServices): ClassicSource {
  const rows = async (): Promise<HistoryRow[]> => {
    await refreshRelayedJobs(s);
    await refreshWalletWithdrawals(s);
    await refreshDepositJobs(s);
    const jobs = [...(await s.jobs.list()), ...(await s.depositJobs.list())].sort((a, b) => a.createdAt - b.createdAt);
    return jobs.map((job: JobRecord) => toHistoryRow(job)).reverse();
  };
  return {
    async stats(pool): Promise<PoolStats> {
      const h = s.histories.get(pool)!;
      await h.ensure();
      return h.stats();
    },
    async lookup(note: ClassicNote): Promise<NoteLookup> {
      if (note.netId !== s.config.chainId) return { kind: "other-network", netId: note.netId };
      const pool = poolFor(note.currency, note.amount, note.netId);
      if (!pool) return { kind: "unknown-pool" };
      const h = s.histories.get(pool.id)!;
      await h.ensure();
      const derived = await (await s.prover()).note(formatNote(note));
      if (!derived.ok) return { kind: "invalid" };
      let facts = h.lookup(derived.commitment, derived.nullifierHash);
      // a miss is a statement about the history (the tenth review round, C10-2): a verified one is synced again once and read again; a
      // failed or unverified one says the note could not be checked — "The note is invalid" had been said of valid notes in both
      if (!facts && h.verified) {
        await h.refresh();
        facts = h.lookup(derived.commitment, derived.nullifierHash);
      }
      if (facts) return { kind: "found", pool: pool.id, facts };
      const st = h.status;
      if (st.kind === "ready" && st.verified) return { kind: "no-deposit", toBlock: st.toBlock };
      return st.kind === "ready" ? { kind: "history-unverified" } : { kind: "history-unavailable" };
    },
    async relayers(): Promise<RelayerInfo[]> {
      return s.relayers.onlineCount() === null ? s.relayers.refresh() : s.relayers.list();
    },
    refreshRelayers(): Promise<RelayerInfo[]> {
      return s.relayers.refresh();
    },
    async gasPriceWei(): Promise<bigint> {
      if (!s.rpc) throw new Error("no RPC endpoint is configured");
      return gasPriceWei(s.rpc);
    },
    async availability(pool): Promise<Availability> {
      void s.checkPool(pool);
      return availabilityOf(pool, factsOf(s, pool));
    },
    history: rows,
    async clearHistory(): Promise<void> {
      await s.jobs.clear();
      await s.depositJobs.clear();
    },
  };
}

/** Whether any function of any pool is switched live in this build. */
export const anyLive = (c: ClassicConfig): boolean => POOL_IDS.some((p) => isLive(c, p, "deposit") || isLive(c, p, "withdraw"));
