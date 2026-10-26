// The Classic history (spec v3.0 §7.4; V7 Stage 7): the pools' events decoded from raw logs the chain returned; the
// committed snapshot fixture (the 100 ETH pool's first 1,024 deposits, its root equal to the pool's own getLastRoot() at
// that block) held to its manifest, rehashed layer by layer, and refused when tampered; the delta sync over a scripted
// chain — windows sized by the endpoint's refusals, a gap caught, a moving window redone, checkpoints kept, a reorg found
// and rolled back; the chain verification's three answers; the frontier walk equal to the tree's root; a note's facts
// and its spent state from the history alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashLeftRight } from "../src/crypto/hashes";
import { LEVELS, MerkleTree, zeros } from "../src/crypto/tree";
import {
  checkContinuity,
  decodeDeposit,
  decodeLogs,
  decodeWithdrawal,
  LogDecodeError,
  TOPICS,
  type DepositEvent,
  type Hex,
  type RawLog,
} from "../src/history/events";
import { buildSnapshot, pinOf, treeFile, treeFromFile, verifySnapshot, type SnapshotManifest, type SnapshotTexts } from "../src/history/snapshot";
import { depositFacts, indexHistory, isSpentOnChain, withdrawalOf } from "../src/history/spent";
import {
  CONFIRMATIONS,
  eventsUpTo,
  findReorg,
  KEEP_CHECKPOINTS,
  MAX_WINDOW,
  mergeCheckpoints,
  MIN_WINDOW,
  syncDelta,
  SyncError,
  type Rpc,
} from "../src/history/sync";
import { frontierOf, readFrontier, rootFromFrontier, SELECTORS, verifyAgainstChain } from "../src/history/verify";
import logs from "./fixtures/history/logs.json";

const FIXTURE = join(__dirname, "fixtures", "history", "first-1024", "eth-100");
const POOL = "0xa160cdab225685da1d56aa342ad8841c3b53f291" as const;
const read = (name: string) => readFileSync(join(FIXTURE, name), "utf8");
const manifest = JSON.parse(read("manifest.json")) as SnapshotManifest;
const texts: SnapshotTexts = { "deposits.json": read("deposits.json"), "withdrawals.json": read("withdrawals.json"), "tree.json": read("tree.json") };
const deposits = JSON.parse(texts["deposits.json"]) as DepositEvent[];
const word = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");
const hex32 = (x: bigint): Hex => `0x${word(x)}`;

describe("the pools' events", () => {
  it("decodes the Deposit the chain returned: the commitment in the topic, the leaf index and the timestamp in the data", () => {
    const d = decodeDeposit(logs.deposit as RawLog);
    expect(d).toEqual({
      leafIndex: 27544,
      commitment: "0x1074a5c5493989f0bdf801d88770d82e6b9c084d39abcaf3ea2da0613da67474",
      timestamp: 0x62a73016,
      blockNumber: 14956023,
      transactionHash: logs.deposit.transactionHash.toLowerCase(),
      logIndex: Number.parseInt(logs.deposit.logIndex, 16),
    });
    expect(TOPICS.Deposit).toBe("0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196");
  });

  it("decodes the Withdrawal: the relayer in the topic, the recipient, the nullifier hash and the fee in the data", () => {
    const w = decodeWithdrawal(logs.withdrawal as RawLog);
    expect(w.relayer).toBe("0x07c3aa37347c8102a24e5bfb261cf420aa4512fe");
    expect(w.to).toBe("0x07c3aa37347c8102a24e5bfb261cf420aa4512fe");
    expect(w.nullifierHash).toBe("0x14c9a4c91058f2b4b287e65b61f266dbbfce317b41ba4eb197e4096308712276");
    expect(w.fee).toBe("0");
    expect(w.blockNumber).toBe(14954229);
    expect(TOPICS.Withdrawal).toBe("0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931");
  });

  it("a window of logs: both kinds in chain order, removed logs and other contracts skipped; a wrong topic refused", () => {
    const other = { ...logs.deposit, address: "0x0000000000000000000000000000000000000001" };
    const removed = { ...logs.withdrawal, removed: true };
    const { deposits: ds, withdrawals: ws } = decodeLogs([logs.deposit as RawLog, removed as RawLog, other as RawLog, logs.withdrawal as RawLog], POOL);
    expect(ds.length).toBe(1);
    expect(ws.length).toBe(1);
    expect(() => decodeDeposit(logs.withdrawal as RawLog)).toThrow(LogDecodeError);
    expect(() => decodeWithdrawal({ ...logs.withdrawal, data: "0x00" } as RawLog)).toThrow(/word/);
    checkContinuity(ds, 27544);
    expect(() => checkContinuity(ds, 27543)).toThrow(/leaf 27543 expected/);
  });
});

describe("the snapshot fixture (the 100 ETH pool's first 1,024 deposits)", () => {
  it("is held to its manifest, rehashed layer by layer, and its root is the one the chain's archive answered for its block", async () => {
    const r = await verifySnapshot(manifest, texts, { rehash: true, pool: { id: "eth-100", address: POOL } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.tree.size).toBe(1024);
    expect(r.snapshot.deposits.length).toBe(1024);
    expect(r.snapshot.withdrawals.length).toBe(manifest.files["withdrawals.json"].count);
    expect(hex32(r.snapshot.tree.root)).toBe(manifest.root);
    expect(manifest.toBlock).toBe(10734277);
    expect(manifest.verified?.method).toMatch(/getLastRoot\(\) at block 10734277/);
    expect(manifest.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    // the withdrawals all precede the snapshot's block, the deposits sit in it in order
    expect(r.snapshot.withdrawals.every((w) => w.blockNumber >= manifest.deployedBlock && w.blockNumber <= manifest.toBlock)).toBe(true);
    expect(r.snapshot.deposits[0].blockNumber).toBe(9162622);
  });

  it("refuses a file that does not hash to the manifest, a tampered root, another pool, a broken leaf order", async () => {
    const tampered = { ...texts, "deposits.json": texts["deposits.json"].replace("9162622", "9162623") };
    const r1 = await verifySnapshot(manifest, tampered);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.problems.join()).toMatch(/deposits\.json does not hash/);
    const r2 = await verifySnapshot({ ...manifest, root: hex32(1n) }, texts);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.problems.join()).toMatch(/root is not the manifest's/);
    const r3 = await verifySnapshot(manifest, texts, { pool: { id: "eth-1", address: POOL } });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.problems.join()).toMatch(/another pool/);
    const swapped = [...deposits];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    const swappedText = JSON.stringify(swapped);
    const r4 = await verifySnapshot(
      { ...manifest, files: { ...manifest.files, "deposits.json": await pinOf(swappedText, swapped.length) } },
      { ...texts, "deposits.json": swappedText },
    );
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.problems.join()).toMatch(/leaf 0 expected/);
  });

  it("builds the same files again from the events; the tree file round-trips", async () => {
    const built = await buildSnapshot({
      pool: "eth-100",
      address: POOL,
      deployedBlock: manifest.deployedBlock,
      toBlock: manifest.toBlock,
      blockHash: manifest.blockHash,
      deposits,
      withdrawals: JSON.parse(texts["withdrawals.json"]),
      generatedAt: manifest.generatedAt,
    });
    expect(built.manifest.root).toBe(manifest.root);
    expect(built.manifest.files).toEqual(manifest.files);
    expect(built.texts["tree.json"]).toBe(texts["tree.json"]);
    const tree = treeFromFile(treeFile(built.tree));
    expect(tree.root).toBe(built.tree.root);
    expect(tree.path(1023)).toEqual(built.tree.path(1023));
    expect(() => treeFromFile({ ...treeFile(built.tree), leaves: 1023 })).toThrow(/leaf count/);
  }, 30_000);
});

/** A scripted chain: blocks with hashes, Deposit and Withdrawal logs at given blocks, a window cap the endpoint refuses above. */
function scriptedChain({
  head,
  maxWindow,
  deposits: ds,
  withdrawals: ws = [],
}: {
  head: number;
  maxWindow: number;
  deposits: { block: number; leaf: number; commitment: bigint }[];
  withdrawals?: { block: number; nullifierHash: bigint }[];
}) {
  const hashes = new Map<number, Hex>();
  const hashOf = (n: number): Hex => hashes.get(n) ?? (`0x${word(BigInt(n) * 1_000_003n)}` as Hex);
  const calls: string[] = [];
  const movedOnce = new Set<number>();
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getBlockByNumber") {
      const n = Number.parseInt((params[0] as string).slice(2), 16);
      return n > head ? null : { number: `0x${n.toString(16)}`, hash: hashOf(n) };
    }
    if (method === "eth_getLogs") {
      const f = params[0] as { fromBlock: string; toBlock: string };
      const from = Number.parseInt(f.fromBlock, 16);
      const to = Number.parseInt(f.toBlock, 16);
      if (to - from + 1 > maxWindow) throw new Error(`ranges over ${maxWindow} blocks are not supported`);
      const out: RawLog[] = [];
      for (const d of ds)
        if (d.block >= from && d.block <= to)
          out.push({
            address: POOL,
            topics: [TOPICS.Deposit, hex32(d.commitment)],
            data: `0x${word(d.leaf)}${word(1_700_000_000 + d.leaf)}`,
            blockNumber: `0x${d.block.toString(16)}`,
            // a log of the window's last block reports a stale hash once, as a chain moving under the window would
            blockHash: d.block === to && !movedOnce.has(to) && (movedOnce.add(to), true) ? `0x${word(7n)}` : hashOf(d.block),
            transactionHash: `0x${word(BigInt(d.leaf) + 99n)}`,
            logIndex: "0x0",
          });
      for (const w of ws)
        if (w.block >= from && w.block <= to)
          out.push({
            address: POOL,
            topics: [TOPICS.Withdrawal, `0x${word(0xabcn)}`],
            data: `0x${word(0xdefn)}${word(w.nullifierHash)}${word(0n)}`,
            blockNumber: `0x${w.block.toString(16)}`,
            blockHash: hashOf(w.block),
            transactionHash: `0x${word(w.nullifierHash + 1n)}`,
            logIndex: "0x1",
          });
      return out;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, hashes, hashOf };
}

describe("the delta sync", () => {
  const ds = [
    { block: 1_000_500, leaf: 5, commitment: 11n },
    { block: 1_001_200, leaf: 6, commitment: 12n },
    { block: 1_003_000, leaf: 7, commitment: 13n },
    { block: 1_003_000, leaf: 8, commitment: 14n },
    { block: 1_004_900, leaf: 9, commitment: 15n },
  ];

  it("sizes its windows to the endpoint (halving on a refusal, growing after two successes), keeps every event in order and a checkpoint per window, stops 12 blocks short of the head", async () => {
    const chain = scriptedChain({ head: 1_005_000, maxWindow: 1_000, deposits: ds, withdrawals: [{ block: 1_002_000, nullifierHash: 77n }] });
    const spans: number[] = [];
    const sizes: number[] = [];
    const r = await syncDelta({
      rpc: chain.rpc,
      address: POOL,
      fromBlock: 1_000_000,
      leaves: 5,
      onWindow: (w) => {
        spans.push(w.to - w.from + 1);
        sizes.push(w.window);
      },
    });
    expect(r.toBlock).toBe(1_005_000 - CONFIRMATIONS);
    expect(r.deposits.map((d) => d.leafIndex)).toEqual([5, 6, 7, 8, 9]);
    expect(r.deposits.map((d) => d.commitment)).toEqual([11n, 12n, 13n, 14n, 15n].map(hex32));
    expect(r.withdrawals.map((w) => w.nullifierHash)).toEqual([hex32(77n)]);
    // every request the endpoint answered spanned at most its cap; the size was halved from 500,000 down to 976 first
    expect(Math.max(...spans)).toBeLessThanOrEqual(1_000);
    expect(sizes[0]).toBe(976);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1_952); // grown once after two successes, clipped by the target
    expect(r.window).toBeGreaterThanOrEqual(MIN_WINDOW);
    expect(r.windows).toBe(spans.length);
    expect(r.windows).toBeGreaterThanOrEqual(4);
    expect(r.checkpoints.length).toBe(Math.min(r.windows, KEEP_CHECKPOINTS));
    expect(r.checkpoints.at(-1)).toEqual({ blockNumber: r.toBlock, blockHash: chain.hashOf(r.toBlock) });
    expect(r.blockHash).toBe(chain.hashOf(r.toBlock));
    expect(chain.calls.filter((c) => c === "eth_getBlockByNumber").length).toBeGreaterThanOrEqual(r.windows);
  });

  it("nothing to sync inside the confirmation depth; a gap in the leaves is refused; a window the chain moved under is redone", async () => {
    const chain = scriptedChain({ head: 1_000_010, maxWindow: MAX_WINDOW, deposits: [] });
    const r = await syncDelta({ rpc: chain.rpc, address: POOL, fromBlock: 1_000_000, leaves: 5 });
    expect(r).toEqual({ deposits: [], withdrawals: [], toBlock: 1_000_000, blockHash: null, checkpoints: [], windows: 0, window: MAX_WINDOW });
    const gap = scriptedChain({ head: 1_005_000, maxWindow: MAX_WINDOW, deposits: [{ block: 1_000_500, leaf: 6, commitment: 11n }] });
    await expect(syncDelta({ rpc: gap.rpc, address: POOL, fromBlock: 1_000_000, leaves: 5 })).rejects.toThrow(/leaf 5 expected/);
    await expect(syncDelta({ rpc: gap.rpc, address: POOL, fromBlock: 1_000_000, leaves: 5 })).rejects.toBeInstanceOf(Error);
    // the moving window: a deposit in the window's last block reports a stale hash the first time
    const moving = scriptedChain({ head: 1_000_000 + CONFIRMATIONS + 100, maxWindow: MAX_WINDOW, deposits: [{ block: 1_000_100, leaf: 5, commitment: 11n }] });
    const m = await syncDelta({ rpc: moving.rpc, address: POOL, fromBlock: 1_000_000, leaves: 5 });
    expect(m.deposits.length).toBe(1);
    expect(moving.calls.filter((c) => c === "eth_getLogs").length).toBe(2);
  });

  it("an endpoint error that is not a range refusal surfaces as a sync error; a too-small window is never halved below the floor", async () => {
    const rpc: Rpc = async (method) => {
      if (method === "eth_blockNumber") return "0xf4240";
      throw new Error("service temporarily unavailable");
    };
    await expect(syncDelta({ rpc, address: POOL, fromBlock: 999_000, leaves: 0, window: MIN_WINDOW })).rejects.toThrow(SyncError);
  });

  it("checkpoints merge oldest first and keep the newest 24; a reorg is found by the newest checkpoint that still stands; the rollback keeps the events up to it", async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ blockNumber: 100 + i, blockHash: hex32(BigInt(i)) }));
    const fresh = Array.from({ length: 10 }, (_, i) => ({ blockNumber: 200 + i, blockHash: hex32(BigInt(100 + i)) }));
    const merged = mergeCheckpoints(old, fresh);
    expect(merged.length).toBe(KEEP_CHECKPOINTS);
    expect(merged[0].blockNumber).toBe(106);
    expect(merged.at(-1)?.blockNumber).toBe(209);
    const chain = scriptedChain({ head: 1_000, maxWindow: 10, deposits: [] });
    const cps = [100, 200, 300].map((n) => ({ blockNumber: n, blockHash: chain.hashOf(n) }));
    expect(await findReorg(chain.rpc, cps)).toEqual({ intact: true });
    chain.hashes.set(300, hex32(1n));
    expect(await findReorg(chain.rpc, cps)).toEqual({ intact: false, rollbackTo: cps[1] });
    chain.hashes.set(200, hex32(2n));
    chain.hashes.set(100, hex32(3n));
    expect(await findReorg(chain.rpc, cps)).toEqual({ intact: false, rollbackTo: null });
    const events = [{ blockNumber: 150 }, { blockNumber: 200 }, { blockNumber: 201 }];
    expect(eventsUpTo(events, 200)).toEqual([{ blockNumber: 150 }, { blockNumber: 200 }]);
  });
});

describe("the history against the chain", () => {
  const tree = treeFromFile(JSON.parse(texts["tree.json"]));
  const callRpc =
    (answers: Record<string, string>): Rpc =>
    async (method, params) => {
      if (method !== "eth_call") throw new Error(method);
      const data = (params[0] as { data: string }).data;
      const selector = data.slice(0, 10);
      const answer = answers[selector];
      if (!answer) throw new Error(`no answer for ${selector}`);
      return answer;
    };

  it("ok when the leaf count is nextIndex and the root is known (or the last root); the two reasons otherwise", async () => {
    const root = hex32(tree.root);
    const ok = await verifyAgainstChain(
      callRpc({ [SELECTORS.nextIndex]: `0x${word(1024)}`, [SELECTORS.getLastRoot]: root, [SELECTORS.isKnownRoot]: `0x${word(1)}` }),
      POOL,
      tree,
    );
    expect(ok).toEqual({ ok: true, root, leaves: 1024, nextIndex: 1024, lastRoot: root, known: true });
    const lastOnly = await verifyAgainstChain(
      callRpc({ [SELECTORS.nextIndex]: `0x${word(1024)}`, [SELECTORS.getLastRoot]: root, [SELECTORS.isKnownRoot]: `0x${word(0)}` }),
      POOL,
      tree,
    );
    expect(lastOnly.ok).toBe(true);
    const count = await verifyAgainstChain(
      callRpc({ [SELECTORS.nextIndex]: `0x${word(1025)}`, [SELECTORS.getLastRoot]: root, [SELECTORS.isKnownRoot]: `0x${word(1)}` }),
      POOL,
      tree,
    );
    expect(count.ok).toBe(false);
    expect(count.reason).toBe("leaf count");
    const unknown = await verifyAgainstChain(
      callRpc({ [SELECTORS.nextIndex]: `0x${word(1024)}`, [SELECTORS.getLastRoot]: hex32(5n), [SELECTORS.isKnownRoot]: `0x${word(0)}` }),
      POOL,
      tree,
    );
    expect(unknown.reason).toBe("root unknown");
    expect(SELECTORS.isSpent).toBe("0xe5285dcc");
    expect(SELECTORS.getLastRoot).toBe("0xba70f757");
  });

  it("the frontier walk is the contract's: filledSubtrees plus the last leaf hash to the root, for the fixture and for every small tree", () => {
    const frontier = frontierOf(tree);
    expect(frontier.length).toBe(LEVELS);
    expect(rootFromFrontier(frontier, 1023, tree.leaf(1023)!)).toBe(tree.root);
    expect(rootFromFrontier(frontier, 1022, tree.leaf(1023)!)).not.toBe(tree.root);
    const small = new MerkleTree();
    for (let k = 0; k < 9; k++) {
      small.insert(BigInt(1000 + k));
      expect(rootFromFrontier(frontierOf(small), k, BigInt(1000 + k)), `after leaf ${k}`).toBe(small.root);
    }
    // index 0: every level hashes the running node with the empty subtree
    expect(rootFromFrontier(zeros().slice(0, LEVELS), 0, 42n)).toBe(new MerkleTree([42n]).root);
    expect(hashLeftRight(zeros()[0], zeros()[0])).toBe(zeros()[1]);
  });

  it("reads the frontier with 22 calls", async () => {
    const frontier = frontierOf(tree);
    let calls = 0;
    const rpc: Rpc = async (_m, params) => {
      calls++;
      const data = (params[0] as { data: string }).data;
      if (data.startsWith(SELECTORS.filledSubtrees)) return hex32(frontier[Number(BigInt("0x" + data.slice(10)))]);
      if (data === SELECTORS.nextIndex) return `0x${word(1024)}`;
      if (data === SELECTORS.getLastRoot) return hex32(tree.root);
      throw new Error(data);
    };
    const f = await readFrontier(rpc, POOL);
    expect(calls).toBe(22);
    expect(f).toEqual({ filledSubtrees: frontier, nextIndex: 1024, lastRoot: hex32(tree.root) });
  });
});

describe("a note's facts from the history", () => {
  const withdrawals = JSON.parse(texts["withdrawals.json"]) as { nullifierHash: Hex }[];
  const index = indexHistory(deposits, JSON.parse(texts["withdrawals.json"]));

  it("the deposit by commitment, the deposits since, spent when the Withdrawal history holds the nullifier hash — and nothing for an unknown commitment", () => {
    const spentHash = withdrawals[0].nullifierHash;
    const facts = depositFacts(index, deposits[10].commitment, spentHash);
    expect(facts).toEqual({
      leafIndex: 10,
      timestamp: deposits[10].timestamp,
      blockNumber: deposits[10].blockNumber,
      txHash: deposits[10].transactionHash,
      depositsSince: 1013,
      spent: true,
    });
    expect(depositFacts(index, deposits[1023].commitment, hex32(1n))?.depositsSince).toBe(0);
    expect(depositFacts(index, deposits[1023].commitment, hex32(1n))?.spent).toBe(false);
    expect(depositFacts(index, hex32(123n), hex32(1n))).toBeNull();
    expect(withdrawalOf(index, spentHash)?.nullifierHash).toBe(spentHash);
    expect(withdrawalOf(index, hex32(1n))).toBeNull();
  });

  it("the on-chain read asks isSpent(bytes32) and nothing else", async () => {
    const seen: string[] = [];
    const rpc: Rpc = async (method, params) => {
      seen.push(`${method} ${(params[0] as { data: string }).data}`);
      return `0x${word(1)}`;
    };
    expect(await isSpentOnChain(rpc, POOL, withdrawals[0].nullifierHash)).toBe(true);
    expect(seen).toEqual([`eth_call ${SELECTORS.isSpent}${withdrawals[0].nullifierHash.slice(2)}`]);
    await expect(isSpentOnChain(rpc, POOL, "0x12" as Hex)).rejects.toThrow(/32 bytes/);
  });
});
