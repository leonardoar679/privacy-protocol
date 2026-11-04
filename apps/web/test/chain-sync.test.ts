// Tree sync and note discovery (packages/sdk/src/chain.ts, packages/sdk/src/privateTx.ts): the wallet rebuilds the
// core's Merkle tree from NoteInserted events exactly as MerkleAccumulator inserts groups (a deposit
// = commitment + 3 empty leaves, a transaction = 3 commitments + 1 empty), refuses a view whose root
// is not the core's, and finds its own notes by opening the payloads encrypted to its view key —
// against a local mock JSON-RPC server with synthetic events (two real envelopes — a note of ours and a private transfer
// someone sent us, which the scan reports as received — and dummies elsewhere).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, toFunctionSelector, toHex, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { coreAbi } from "@privacy-wallet/sdk/privacyProtocol";
import { clientFor, deploymentFromEnv, noteInsertedLogsQuorum, syncTree, syncTreeQuorum, txDomainOf, type Deployment } from "@privacy-wallet/sdk/chain";
import { scanNotes } from "@privacy-wallet/sdk/privateTx";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { nullifier } from "@privacy-wallet/protocol/nullifier";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const seed = utf8ToBytes("chain-sync-test-seed");
const keys = deriveKeys(seed);
const view = viewKeyPair(keys.viewKey);
const oc = ownerCommitmentOf(keys.spendKey);
const toHexBytes = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

// leaf 0: a real deposit of OURS with its payload encrypted to our view key; leaves 4..6: a transaction's outputs — leaf 5
// a private transfer to us (its secret is the sender's, not derived from our seed), 4 and 6 dummy-shaped payloads
const ourNote: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const sentToUs: Note = { vaultId: BigInt(VAULT), amount: 3n * 10n ** 17n, ownerCommitment: oc, noteSecret: 0x5e17d0b5n };
const leaves: Record<number, { commitment: bigint; noteData: Hex }> = {
  0: { commitment: noteCommitment(noteBody(ourNote), 0n), noteData: toHexBytes(encryptNoteData(view.publicKey, { amount: ourNote.amount, noteSecret: ourNote.noteSecret, vaultId: ourNote.vaultId })) },
  4: { commitment: 0x4444n, noteData: toHexBytes(dummyNoteData()) },
  5: { commitment: noteCommitment(noteBody(sentToUs), 5n), noteData: toHexBytes(encryptNoteData(view.publicKey, { amount: sentToUs.amount, noteSecret: sentToUs.noteSecret, vaultId: sentToUs.vaultId })) },
  6: { commitment: 0x6666n, noteData: toHexBytes(dummyNoteData()) },
};
const NEXT = 8;
const tree = new MerkleTree(TX_LEVELS);
tree.insertGroup([leaves[0].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
tree.insertGroup([leaves[4].commitment, leaves[5].commitment, leaves[6].commitment, ZERO_LEAF]);
let rootToReport: bigint = tree.root;
let spentFlag = false;

const selNext = toFunctionSelector("nextLeafIndex()");
const selRoot = toFunctionSelector("currentRoot()");
const pad32 = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
function logFor(leafIndex: number, l: { commitment: bigint; noteData: Hex }) {
  return {
    address: CORE.toLowerCase(), topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
    blockNumber: "0x5", blockHash: "0x" + "22".repeat(32), transactionHash: ("0x" + "33".repeat(31) + leafIndex.toString(16).padStart(2, "0")) as Hex, transactionIndex: "0x0", logIndex: toHex(leafIndex), removed: false,
  };
}
function spendLogFor(n0: bigint, n1: bigint) {
  return {
    address: CORE.toLowerCase(), topics: encodeEventTopics({ abi: coreAbi, eventName: "ShieldedTransaction" }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [n0, n1, 0n, 0n, 0n]),
    blockNumber: "0x7", blockHash: "0x" + "22".repeat(32), transactionHash: ("0x" + "55".repeat(32)) as Hex, transactionIndex: "0x0", logIndex: "0x9", removed: false,
  };
}
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res("0x7a69");
    case "eth_blockNumber": return res("0x10");
    case "eth_getLogs": {
      // the notes, and — when the pool spent ours — the spend event that consumed their nullifiers: the scan's spent bit comes from it,
      // never from a per-nullifier isNullifierSpent read (the sixth review round, 2026-11-03)
      const spends = spentFlag ? [spendLogFor(nullifier(leaves[0].commitment, keys.spendKey), nullifier(leaves[5].commitment, keys.spendKey))] : [];
      return res([...Object.entries(leaves).map(([i, l]) => logFor(Number(i), l)), ...spends]);
    }
    case "eth_call": {
      const data: string = req.params[0].data;
      if (data.startsWith(selNext)) return res(pad32(BigInt(NEXT)));
      if (data.startsWith(selRoot)) return res(pad32(rootToReport));
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
    }
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let deployment: Deployment;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  deployment = { chainId: 31337, core: CORE, ethVault: VAULT, rpcUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, rpcUrls: [`http://127.0.0.1:${(server.address() as { port: number }).port}`], fromBlock: 0n };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("shielded tree sync", () => {
  it("rebuilds the leaves and root the core holds from NoteInserted events (batched JSON-RPC)", async () => {
    const state = await syncTree(clientFor(deployment), deployment);
    expect(state.nextLeafIndex).toBe(NEXT);
    expect(state.leaves).toEqual(tree.leaves);
    expect(state.root).toBe(tree.root);
    expect(state.leaves[1]).toBe(ZERO_LEAF);
    expect(state.leaves[7]).toBe(ZERO_LEAF);
  });
  it("refuses a view that does not reproduce the core's current root (missing events / reorg)", async () => {
    rootToReport = tree.root ^ 1n;
    try {
      await expect(syncTree(clientFor(deployment), deployment)).rejects.toThrow(/does not match the core's current root/);
    } finally {
      rootToReport = tree.root;
    }
  });
  it("binds transactions to the chain and core (txDomain) exactly like the reference", () => {
    expect(txDomainOf(deployment)).toBe(txDomain(31337n, BigInt(CORE)));
    expect(txDomainOf({ ...deployment, chainId: 1 })).not.toBe(txDomainOf(deployment));
  });
});

describe("private read layer: endpoint quorum (plan §38, Rule 6)", () => {
  // a second endpoint with a self-consistent but STALE view: only the first group, nextLeafIndex 4,
  // a root that matches that view — a single-endpoint wallet would accept it
  const staleTree = new MerkleTree(TX_LEVELS);
  staleTree.insertGroup([leaves[0].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
  function handleStale(req: { id: number; method: string; params: any[] }) {
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "eth_getLogs") return res([logFor(0, leaves[0])]);
    if (req.method === "eth_call") {
      const data: string = req.params[0].data;
      if (data.startsWith(selNext)) return res(pad32(4n));
      if (data.startsWith(selRoot)) return res(pad32(staleTree.root));
    }
    return handle(req);
  }
  let stale: Server;
  let staleUrl = "";
  beforeAll(async () => {
    stale = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handleStale) : handleStale(j))); });
    });
    await new Promise<void>((r) => stale.listen(0, "127.0.0.1", r));
    staleUrl = `http://127.0.0.1:${(stale.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => stale.close(() => r())));

  it("agreeing endpoints give the tree; a stale endpoint is detected instead of trusted", async () => {
    const twoGood = { ...deployment, rpcUrls: [deployment.rpcUrl, deployment.rpcUrl] };
    const state = await syncTreeQuorum(twoGood);
    expect(state.root).toBe(tree.root);
    expect((await noteInsertedLogsQuorum(twoGood)).length).toBe(4);

    const mixed = { ...deployment, rpcUrls: [deployment.rpcUrl, staleUrl] };
    await expect(syncTreeQuorum(mixed)).rejects.toThrow(/RPC endpoints disagree on the tree/);
    await expect(noteInsertedLogsQuorum(mixed)).rejects.toThrow(/RPC endpoints disagree on the note events/);
    // alone, the stale endpoint passes its own root check: that is exactly why one endpoint is not enough
    const staleOnly = { ...deployment, rpcUrl: staleUrl, rpcUrls: [staleUrl] };
    expect((await syncTreeQuorum(staleOnly)).nextLeafIndex).toBe(4);
  });
  it("reads the endpoint list from the environment (comma-separated), falling back to the single URL", () => {
    expect(deploymentFromEnv({ VITE_RPC_URLS: " http://a.test , http://b.test", VITE_CORE: CORE, VITE_ETH_VAULT: VAULT })?.rpcUrls).toEqual(["http://a.test", "http://b.test"]);
    expect(deploymentFromEnv({ VITE_RPC_URL: "http://c.test", VITE_CORE: CORE, VITE_ETH_VAULT: VAULT })?.rpcUrls).toEqual(["http://c.test"]);
    expect(deploymentFromEnv({ VITE_CORE: CORE, VITE_ETH_VAULT: VAULT })).toBeNull();
  });
});

describe("note discovery from chain (spec §12 envelope)", () => {
  it("finds exactly the notes encrypted to our view key — ours, and a transfer received, reported once — unspent, and is idempotent", async () => {
    noteStore.markSpent(noteStore.all().map((n) => n.leafIndex));
    const before = noteStore.all().length;
    const r = await scanNotes({ masterSeed: seed, deployment });
    expect(r).toEqual({
      scanned: 4,
      found: 2,
      added: 2,
      spent: 0,
      refunds: 0,
      received: [{ leafIndex: 5, vaultId: BigInt(VAULT), amount: 3n * 10n ** 17n, txHash: "0x" + "33".repeat(31) + "05" }],
      pending: [], // no light client on this chain: nothing waits for a proof (audit round 2, r24)
      proven: null,
    });
    const mine = noteStore.all().slice(before);
    expect(mine.map((n) => n.leafIndex)).toEqual([0, 5]);
    expect(mine[0].note).toEqual(ourNote);
    expect(mine[1].note).toEqual(sentToUs);
    expect(mine.every((n) => !n.spent && n.label === "discovered")).toBe(true);
    expect(mine[0].counter, "our seed made it").toBe(0);
    expect(mine[1].counter, "the sender's secret: no counter of ours").toBeUndefined();
    expect(noteStore.balance(BigInt(VAULT))).toBe(13n * 10n ** 17n);
    const again = await scanNotes({ masterSeed: seed, deployment });
    expect(again).toEqual({ scanned: 4, found: 2, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null });
    expect(noteStore.all().length).toBe(before + 2);
  });
  it("marks a discovered note spent when the pool's spend events say so — no per-nullifier read; another wallet finds nothing", async () => {
    spentFlag = true;
    try {
      const r = await scanNotes({ masterSeed: seed, deployment });
      expect(r.spent).toBe(2);
      expect(noteStore.all().find((n) => n.leafIndex === 0 && n.label === "discovered")?.spent).toBe(true);
      expect(noteStore.balance(BigInt(VAULT))).toBe(0n);
    } finally {
      spentFlag = false;
    }
    const other = await scanNotes({ masterSeed: utf8ToBytes("someone else"), deployment });
    expect(other).toEqual({ scanned: 4, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null });
  });
});
