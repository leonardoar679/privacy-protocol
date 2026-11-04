// The eleventh review round (2026-11-04), A11-2 — a delivery lookup (the Swap screen's refund look, the order runner's recoverShield) is bound to
// the opening it began in, as a scan is: a lock and a REPLACE with another phrase while its pool reads are in flight had put the old wallet's
// note into the new wallet's store and journal for good. Against a mock JSON-RPC endpoint whose answers wait across the lock (the verifier's
// probe, scratchpad review11/VA va2).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData } from "@privacy-wallet/protocol/envelope";
import { coreAbi } from "@privacy-wallet/sdk/privacyProtocol";
import { recoverShieldDelivery, recoverSwapRefunds } from "@privacy-wallet/sdk/privateTx";
import type { DepositedLog, Deployment, NoteInsertedLog } from "@privacy-wallet/sdk/chain";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { decryptJournal, journalKey, type EncryptedJournal } from "@privacy-wallet/sdk/wallet/journal";
import { browserStorage, JOURNAL_KEY } from "@privacy-wallet/sdk/wallet/storage";

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const ETH_VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const seedA = sha256(utf8ToBytes("probe-wallet-A"));
const seedB = sha256(utf8ToBytes("probe-wallet-B"));
const keysA = deriveKeys(seedA);
const ocA = ownerCommitmentOf(keysA.spendKey);
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const COUNTER = 7;
const PAYLOAD = hex(dummyNoteData());
const ORDER = "0x" + "0d".repeat(32);
const AMOUNT = 990_000_000_000_000_000n;
const refundA: Note = { vaultId: BigInt(ETH_VAULT), amount: AMOUNT, ownerCommitment: ocA, noteSecret: deriveNoteSecret(keysA.noteKey, COUNTER) };
const cm = (n: Note, leaf: number) => noteCommitment(noteBody(n), BigInt(leaf));
const tx = (leaf: number): Hex => ("0x" + "33".repeat(31) + leaf.toString(16).padStart(2, "0")) as Hex;
const ins = (leafIndex: number, commitment: bigint, noteData: Hex = hex(dummyNoteData())): NoteInsertedLog => ({
  leafIndex,
  commitment,
  noteData,
  transactionHash: tx(leafIndex),
  blockNumber: 5n,
});
const dep = (vault: Address, leafIndex: number, amount: bigint, owner: bigint): DepositedLog => ({
  vault,
  ownerCommitment: owner,
  amount,
  leafIndex,
  transactionHash: tx(leafIndex),
});
const inserts = [ins(0, 0x1111n), ins(4, cm(refundA, 4), PAYLOAD), ins(5, 0x5555n), ins(6, 0x6666n), ins(7, 0x7777n)];
const deposits = [dep(ETH_VAULT, 4, AMOUNT, ocA)];
const next = 8;
const leaves: bigint[] = Array(next).fill(ZERO_LEAF);
for (const l of inserts) leaves[l.leafIndex] = l.commitment;
const t = new MerkleTree(TX_LEVELS);
for (let i = 0; i < next; i += 4) t.insertGroup(leaves.slice(i, i + 4));
const ROOT = t.root;

const EVENTS = parseAbi(["event Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex)"]);
const [NOTE_TOPIC] = encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted" });
const [DEPOSIT_TOPIC] = encodeEventTopics({ abi: EVENTS, eventName: "Deposited" });
const pad32 = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
const rpcLog = (address: Address, topics: Hex[], data: Hex, leaf: number) => ({
  address: address.toLowerCase(),
  topics,
  data,
  blockNumber: "0x5",
  blockHash: "0x" + "22".repeat(32),
  transactionHash: tx(leaf),
  transactionIndex: "0x0",
  logIndex: toHex(leaf),
  removed: false,
});
const noteLog = (l: NoteInsertedLog) =>
  rpcLog(
    CORE,
    encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: l.leafIndex } }) as Hex[],
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
    l.leafIndex,
  );
const depositLog = (d: DepositedLog) =>
  rpcLog(
    d.vault,
    [DEPOSIT_TOPIC as Hex, pad32(d.ownerCommitment)],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }], [d.amount, d.leafIndex]),
    d.leafIndex,
  );

// every answer waits while `gate` is set: the reads are in flight across the lock and the REPLACE
let gate: Promise<void> | null = null;
let release: () => void = () => {};
function mockRpc() {
  const handle = (req: { id: number; method: string; params: any[] }) => {
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId":
        return res("0x7a69");
      case "eth_blockNumber":
        return res("0x10");
      case "eth_getLogs": {
        const t0 = req.params[0].topics?.[0];
        const topics: unknown[] = Array.isArray(t0) ? t0 : [t0];
        if (topics.includes(NOTE_TOPIC)) return res(inserts.map(noteLog));
        if (topics.includes(DEPOSIT_TOPIC)) return res(deposits.map(depositLog));
        return res([]);
      }
      case "eth_call": {
        const data: string = req.params[0].data;
        if (data.startsWith(toFunctionSelector("nextLeafIndex()"))) return res(pad32(BigInt(next)));
        if (data.startsWith(toFunctionSelector("currentRoot()"))) return res(pad32(ROOT));
        if (data.startsWith(toFunctionSelector("isNullifierSpent(uint256)"))) return res(pad32(0n));
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
      }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
    }
  };
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (gate) await gate;
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)));
    });
  });
}

let server: Server, deployment: Deployment;
beforeAll(async () => {
  server = mockRpc();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  deployment = { chainId: 31337, core: CORE, ethVault: ETH_VAULT, rpcUrl: url, rpcUrls: [url], fromBlock: 0n, erc20Vaults: [] };
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

import { scanNotes } from "@privacy-wallet/sdk/privateTx";

describe("a delivery lookup across a lock and a REPLACE (A11-2)", () => {
  it("never writes the old wallet's note into the new wallet: the lookup stops, B's store and journal hold none of it", async () => {
    await session.create("a strong password", seedA);
    session.acknowledgePhrase();
    gate = new Promise<void>((r) => (release = r));
    const pending = recoverShieldDelivery({ masterSeed: session.state().seed!, deployment, orderId: ORDER, shield: { noteData: PAYLOAD, counter: COUNTER } });
    await new Promise((r) => setTimeout(r, 200));
    session.lock();
    await session.create("another password", seedB, { replace: true });
    session.acknowledgePhrase();
    gate = null;
    release();
    await expect(pending).rejects.toThrow(/the wallet locked during the/);
    expect(
      noteStore.all().some((n) => n.leafIndex === 4),
      "nothing in B's store",
    ).toBe(false);
    const jB0 = decryptJournal(journalKey(seedB), JSON.parse(browserStorage().get(JOURNAL_KEY)!) as EncryptedJournal)!;
    expect(
      jB0.notes.some((n) => n.leafIndex === 4),
      "nothing in B's journal",
    ).toBe(false);
    // B's own scan of the same pool finds nothing of A's: the note is A's, made out to A's owner commitment
    await scanNotes({ masterSeed: session.state().seed!, deployment });
    const after = noteStore.all().filter((n) => n.leafIndex === 4);
    expect(after).toEqual([]);
    session.forget();
    noteStore.load({ notes: [], noteCounter: 0 });
  });

  it("a lock alone: the lookup stops, the closed store takes nothing, and A's own scan after the unlock records the note", async () => {
    await session.create("a strong password", seedA);
    session.acknowledgePhrase();
    gate = new Promise<void>((r) => (release = r));
    const pending = recoverShieldDelivery({ masterSeed: session.state().seed!, deployment, orderId: ORDER, shield: { noteData: PAYLOAD, counter: COUNTER } });
    await new Promise((r) => setTimeout(r, 200));
    session.lock();
    gate = null;
    release();
    await expect(pending).rejects.toThrow(/the wallet locked during the/);
    expect(noteStore.all(), "the closed store took nothing (NF-2)").toEqual([]);
    expect(await session.unlock("a strong password")).toBe(true);
    // the same lookup in the opening it began in records the delivery, as before
    await recoverShieldDelivery({ masterSeed: session.state().seed!, deployment, orderId: ORDER, shield: { noteData: PAYLOAD, counter: COUNTER } });
    expect(noteStore.all().some((n) => n.leafIndex === 4)).toBe(true);
    session.forget();
    noteStore.load({ notes: [], noteCounter: 0 });
  });
});
