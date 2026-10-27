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
import type { followJob, RelayerTransport } from "../../relayer/client";
import type { waitForReceipt } from "../../wallet/connection";
import { CURATED_RELAYERS, type CuratedRelayer } from "../../relayer/curated";
import { historyStore, jobsStore, type HistoryStore, type JobsStore } from "../../storage/historyDb";
import { prover as appProver } from "../prover";
import { checkPoolContract, routerInstanceState } from "./contract";
import { gasPriceWei } from "./gas";
import { PoolHistory, type HistoryStatus, type TreeClient } from "./history";
import { toHistoryRow, type JobRecord } from "./operations";
import { RelayerDirectory } from "./relayers";
import { WalletSession } from "./wallet";

/** What the flows and the source need of the prover worker (the ProverClient has it all). */
export type ProverLike = Pick<ProverClient, "warm" | "prove" | "verify" | "note"> & TreeClient;

export interface ClassicServices {
  config: ClassicConfig;
  rpc: Rpc | null;
  prover: () => Promise<ProverLike>;
  histories: Map<PoolId, PoolHistory>;
  relayers: RelayerDirectory;
  relayerTransport: RelayerTransport;
  wallet: WalletSession;
  jobs: JobsStore;
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
  prover?: () => Promise<ProverLike>;
  historyStore?: HistoryStore;
  jobs?: JobsStore;
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
    prover,
    histories,
    relayers,
    relayerTransport: transport,
    wallet,
    jobs: o.jobs ?? jobsStore(),
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

/** The screens' data over the services. A lookup derives the note's hashes in the worker; the note itself stays in memory. */
export function sourceOf(s: ClassicServices): ClassicSource {
  const rows = async (): Promise<HistoryRow[]> => {
    const jobs = await s.jobs.list();
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
      const facts = h.lookup(derived.commitment, derived.nullifierHash);
      return facts ? { kind: "found", pool: pool.id, facts } : { kind: "no-deposit" };
    },
    async relayers(): Promise<RelayerInfo[]> {
      return s.relayers.onlineCount() === null ? s.relayers.refresh() : s.relayers.list();
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
  };
}

/** Whether any function of any pool is switched live in this build. */
export const anyLive = (c: ClassicConfig): boolean => POOL_IDS.some((p) => isLive(c, p, "deposit") || isLive(c, p, "withdraw"));
