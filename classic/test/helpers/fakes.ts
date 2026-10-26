// Scripted pieces for the Stage 9 tests: a tree client over a real MerkleTree in this process, a prover that derives a
// note's hashes for real and answers a canned proof, a chain answering by method and selector, the history fixture as a
// served snapshot, a wallet provider, a relayer transport.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitmentOf, nullifierHashOf, toHex32 } from "../../src/crypto/hashes";
import { MerkleTree } from "../../src/crypto/tree";
import type { Hex, RawLog } from "../../src/history/events";
import type { SnapshotManifest, SnapshotTexts } from "../../src/history/snapshot";
import type { Rpc } from "../../src/history/sync";
import { SELECTORS } from "../../src/history/verify";
import { parseNote } from "../../src/model/notes";
import type { FetchedSnapshot } from "../../src/net/snapshot";
import type { CircuitInput } from "../../src/prover/input";
import type { PathResult, ProofResult, ProverProgress, TreeResult, WarmResult } from "../../src/prover/protocol";
import type { RelayerAnswer, RelayerTransport } from "../../src/relayer/client";
import type { ProverLike } from "../../src/app/services/source";
import type { Eip1193Provider } from "../../src/wallet/injected";

export const FIXTURE_DIR = join(__dirname, "..", "fixtures", "history", "first-1024", "eth-100");
export const POOL_100 = "0xa160cdab225685da1d56aa342ad8841c3b53f291" as const;
export const word = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");
export const hex32 = (x: bigint): Hex => `0x${word(x)}`;

export function fixtureSnapshot(): FetchedSnapshot {
  const read = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");
  return {
    manifest: JSON.parse(read("manifest.json")) as SnapshotManifest,
    texts: { "deposits.json": read("deposits.json"), "withdrawals.json": read("withdrawals.json"), "tree.json": read("tree.json") } as SnapshotTexts,
  };
}

/** The worker's tree protocol over a MerkleTree here. */
export function fakeTrees() {
  const trees = new Map<string, MerkleTree>();
  const result = (pool: string): TreeResult => ({ pool, leaves: trees.get(pool)!.size, root: toHex32(trees.get(pool)!.root) });
  const calls: string[] = [];
  const client = {
    async loadTree(pool: string, layers: string[][]) {
      calls.push("load");
      trees.set(pool, MerkleTree.fromLayers(layers.map((l) => l.map((h) => BigInt(h)))));
      return result(pool);
    },
    async buildTree(pool: string, leaves: string[], onProgress?: (p: ProverProgress) => void) {
      calls.push("build");
      onProgress?.({ step: "tree", loaded: leaves.length, total: leaves.length });
      trees.set(pool, MerkleTree.fromLeaves(leaves.map((h) => BigInt(h))));
      return result(pool);
    },
    async appendLeaves(pool: string, leaves: string[]) {
      calls.push("append");
      for (const l of leaves) trees.get(pool)!.insert(BigInt(l));
      return result(pool);
    },
    async truncateTree(pool: string, n: number) {
      calls.push("truncate");
      trees.set(pool, MerkleTree.fromLeaves(trees.get(pool)!.leaves().slice(0, n)));
      return result(pool);
    },
    async pathOf(pool: string, index: number): Promise<PathResult> {
      const p = trees.get(pool)!.path(index);
      return { ...result(pool), pathElements: p.pathElements.map(toHex32), pathIndices: p.pathIndices };
    },
    async layersOf(pool: string) {
      return trees
        .get(pool)!
        .toLayers()
        .map((l) => l.map(toHex32));
    },
  };
  return { client, trees, calls };
}

export interface FakeProverOptions {
  /** the commitment every valid note resolves to (so a fixture deposit can be "the user's"); real derivation otherwise */
  commitmentFor?: (note: string) => Hex | null;
  verified?: boolean;
}

/** A prover: the note's hashes for real (or as scripted), a canned proof whose public signals are the input's, the trees above. */
export function fakeProver(o: FakeProverOptions = {}) {
  const trees = fakeTrees();
  const proofs: CircuitInput[] = [];
  const prover: ProverLike & { proofs: CircuitInput[]; warmed: number } = {
    proofs,
    warmed: 0,
    async warm(): Promise<WarmResult> {
      prover.warmed++;
      return { workers: 2, wasmPages: 2000, fromCache: false, artifactsMs: 1, buildMs: 1 };
    },
    async prove(input: CircuitInput, onProgress?: (p: ProverProgress) => void): Promise<ProofResult> {
      proofs.push(input);
      onProgress?.({ step: "witness" });
      onProgress?.({ step: "proof" });
      return {
        proof: `0x${"ab".repeat(256)}`,
        publicSignals: [input.root, input.nullifierHash, input.recipient, input.relayer, input.fee, input.refund],
        verified: o.verified ?? true,
        witnessMs: 1,
        proofMs: 1,
        verifyMs: 1,
      };
    },
    async verify() {
      return o.verified ?? true;
    },
    async note(text: string) {
      const parsed = parseNote(text);
      if (!parsed.ok) return { ok: false as const };
      const scripted = o.commitmentFor?.(text) ?? null;
      return {
        ok: true as const,
        currency: parsed.note.currency,
        amount: parsed.note.amount,
        netId: parsed.note.netId,
        commitment: scripted ?? toHex32(commitmentOf(parsed.note)),
        nullifierHash: toHex32(nullifierHashOf(parsed.note)),
      };
    },
    ...trees.client,
  };
  return { prover, trees };
}

export interface ScriptedChainOptions {
  head: number;
  /** eth_getLogs answers, in order of the calls (the last one repeats) */
  logs?: RawLog[][];
  nextIndex?: number;
  knownRoot?: boolean;
  lastRoot?: Hex;
  receipts?: Record<string, { status: "0x1" | "0x0"; blockNumber: string } | null>;
  gasPrice?: string;
  code?: string;
  calls?: Record<string, string>;
  /** block hashes the chain answers (the fixture's own for its block), others derived from the number */
  blockHashes?: Record<number, Hex>;
}

/** A chain answering by method, with the view selectors of the pools and the registry. */
export function scriptedChain(o: ScriptedChainOptions) {
  const seen: { method: string; params: unknown[] }[] = [];
  let logCalls = 0;
  const rpc: Rpc = async (method, params) => {
    seen.push({ method, params });
    switch (method) {
      case "eth_blockNumber":
        return `0x${o.head.toString(16)}`;
      case "eth_getBlockByNumber": {
        const n = Number.parseInt((params[0] as string).slice(2), 16);
        return { number: `0x${n.toString(16)}`, hash: o.blockHashes?.[n] ?? hex32(BigInt(n) * 7_919n) };
      }
      case "eth_getLogs": {
        const list = o.logs ?? [[]];
        return list[Math.min(logCalls++, list.length - 1)];
      }
      case "eth_gasPrice":
        return o.gasPrice ?? "0x2cb417800";
      case "eth_getCode":
        return o.code ?? "0x6001";
      case "eth_getTransactionReceipt":
        return o.receipts?.[(params[0] as string).toLowerCase()] ?? null;
      case "eth_call": {
        const data = (params[0] as { data: string }).data;
        const sel = data.slice(0, 10);
        if (o.calls?.[sel]) return o.calls[sel];
        if (sel === SELECTORS.nextIndex) return `0x${word(o.nextIndex ?? 0)}`;
        if (sel === SELECTORS.isKnownRoot) return `0x${word(o.knownRoot === false ? 0 : 1)}`;
        if (sel === SELECTORS.getLastRoot) return o.lastRoot ?? hex32(1n);
        if (sel === SELECTORS.isSpent) return `0x${word(0)}`;
        throw new Error(`no answer for selector ${sel}`);
      }
      default:
        throw new Error(`no answer for ${method}`);
    }
  };
  return { rpc, seen };
}

/** A Deposit log as a pool emits it. */
export function depositLog(pool: Hex, leaf: number, commitment: bigint, block: number): RawLog {
  return {
    address: pool,
    topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196", hex32(commitment)],
    data: `0x${word(leaf)}${word(1_700_000_000 + leaf)}`,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: hex32(BigInt(block) * 7_919n),
    transactionHash: hex32(BigInt(leaf) + 99n),
    logIndex: "0x0",
  };
}

/** A wallet: one account on a chain, the transactions it was asked to send, a hash per send. */
export function fakeWalletProvider(account: Hex, chainId = 1) {
  const sent: unknown[] = [];
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  let n = 0;
  const provider: Eip1193Provider & { sent: unknown[]; listeners: typeof listeners } = {
    sent,
    listeners,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (method === "eth_sendTransaction") {
        sent.push((params as unknown[])[0]);
        return hex32(BigInt(1000 + n++));
      }
      throw new Error(`no answer for ${method}`);
    },
    on(event, l) {
      (listeners[event] ??= []).push(l);
    },
    removeListener(event, l) {
      listeners[event] = (listeners[event] ?? []).filter((x) => x !== l);
    },
  };
  return provider;
}

/** A relayer: its status, a job id for every withdrawal, the job through the given states. */
export function fakeRelayerTransport(status: unknown, jobStates: string[] = ["QUEUED", "SENT", "MINED", "CONFIRMED"]) {
  const posted: unknown[] = [];
  let polls = 0;
  const t: RelayerTransport & { posted: unknown[] } = {
    posted,
    async getJson(url): Promise<RelayerAnswer> {
      if (url.endsWith("/v1/status")) return { status: 200, body: status };
      if (/\/v1\/jobs\//.test(url)) {
        const state = jobStates[Math.min(polls++, jobStates.length - 1)];
        return {
          status: 200,
          body: {
            id: "job-1",
            type: "TORNADO_WITHDRAW",
            status: state,
            txHash: state === "QUEUED" ? null : hex32(777n),
            confirmations: state === "CONFIRMED" ? 4 : 0,
            failedReason: null,
          },
        };
      }
      return { status: 404, body: null };
    },
    async postJson(url, body): Promise<RelayerAnswer> {
      posted.push({ url, body });
      return { status: 200, body: { id: "job-1" } };
    },
  };
  return t;
}
