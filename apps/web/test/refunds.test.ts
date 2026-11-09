// Swap refunds back into the wallet (PP-S09, packages/sdk/src/refunds.ts + scanNotes / recoverSwapRefunds): an
// escrow's refund() re-shields with the order's committed payload, which is random, so discovery cannot
// see it. The journal keeps that payload; an insert carrying it becomes a note only if its commitment
// recomputes from the vault's Deposited amount, this wallet's owner commitment and the refund secret.
// Against a local mock JSON-RPC server: our refund, a second refund of the same order, someone's
// transaction that copied the public payload, someone else's deposit, and endpoints that disagree.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { deriveRefundNote, refundPayload } from "@privacy-wallet/sdk/keys/swapKeys";
import { coreAbi } from "@privacy-wallet/sdk/privacyProtocol";
import { hasRefundCandidates, matchCommittedDeposits, refundClaims, usedCounters } from "@privacy-wallet/sdk/refunds";
import { recoverSwapRefunds, scanNotes } from "@privacy-wallet/sdk/privateTx";
import type { DepositedLog, Deployment, NoteInsertedLog } from "@privacy-wallet/sdk/chain";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const ETH_VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000c0de1");
const seed = sha256(utf8ToBytes("refund-recovery-test-seed")); // 32 bytes: the keystore holds it
const keys = deriveKeys(seed);
const oc = ownerCommitmentOf(keys.spendKey);
const OTHER_OC = 0x0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0badn;
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const COUNTER = 7;
const PAYLOAD = hex(dummyNoteData()); // the order's committed refund payload (random bytes, as deriveRefundNote makes it)
const ORDER = "0x" + "0d".repeat(32);
const claim = { orderId: ORDER, noteData: PAYLOAD, counter: COUNTER };
const refundNote = (vault: Address, amount: bigint, counter = COUNTER): Note => ({ vaultId: BigInt(vault), amount, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, counter) });
const cm = (n: Note, leaf: number) => noteCommitment(noteBody(n), BigInt(leaf));
const tx = (leaf: number): Hex => ("0x" + "33".repeat(31) + leaf.toString(16).padStart(2, "0")) as Hex;
const ins = (leafIndex: number, commitment: bigint, noteData: Hex = hex(dummyNoteData())): NoteInsertedLog => ({ leafIndex, commitment, noteData, transactionHash: tx(leafIndex), blockNumber: 5n });
const dep = (vault: Address, leafIndex: number, amount: bigint, owner = oc): DepositedLog => ({ vault, ownerCommitment: owner, amount, leafIndex, transactionHash: tx(leafIndex) });

describe("matching refunds: the payload makes a candidate, the commitment makes a note", () => {
  const AMOUNT = 997_000_000_000_000_000n;
  const first = refundNote(ETH_VAULT, AMOUNT);
  const later = refundNote(ETH_VAULT, 3_000_000n); // a provider refund that arrived after the first refund()
  const logs = [ins(0, 0x1111n), ins(4, cm(first, 4), PAYLOAD), ins(8, 0x8888n, PAYLOAD), ins(12, cm(later, 12), PAYLOAD)];
  const deposits = [dep(ETH_VAULT, 0, 5n, OTHER_OC), dep(ETH_VAULT, 4, AMOUNT), dep(ETH_VAULT, 12, 3_000_000n)];

  it("recovers every refund of the order, with the vault's amount; a copied payload in a transaction output is not ours", () => {
    const r = matchCommittedDeposits(keys, logs, deposits, [claim]);
    expect(r.map((x) => [x.leafIndex, x.note.amount])).toEqual([[4, AMOUNT], [12, 3_000_000n]]);
    expect(r[0]).toMatchObject({ orderId: ORDER, counter: COUNTER, note: first, txHash: tx(4) });
  });
  it("an endpoint that lies about the amount, the vault or the owner gets nothing accepted; neither does another secret", () => {
    expect(matchCommittedDeposits(keys, logs, [dep(ETH_VAULT, 4, AMOUNT + 1n)], [claim])).toEqual([]);
    expect(matchCommittedDeposits(keys, logs, [dep(USDC_VAULT, 4, AMOUNT)], [claim])).toEqual([]);
    expect(matchCommittedDeposits(keys, logs, [dep(ETH_VAULT, 4, AMOUNT, OTHER_OC)], [claim])).toEqual([]);
    expect(matchCommittedDeposits(keys, logs, deposits, [{ ...claim, counter: COUNTER + 1 }])).toEqual([]);
    expect(matchCommittedDeposits(deriveKeys(utf8ToBytes("someone else")), logs, deposits, [claim])).toEqual([]);
  });
  it("a refund into another vault (an ERC-20 order) is recovered in that vault", () => {
    const usdc = refundNote(USDC_VAULT, 1_000_000_000n);
    expect(matchCommittedDeposits(keys, [ins(4, cm(usdc, 4), PAYLOAD)], [dep(USDC_VAULT, 4, 1_000_000_000n)], [claim])[0].note.vaultId).toBe(BigInt(USDC_VAULT));
  });
  it("the deposits are read only when an insert carries a journaled payload", () => {
    expect(hasRefundCandidates(logs, [claim])).toBe(true);
    expect(hasRefundCandidates([ins(0, 1n)], [claim])).toBe(false);
    expect(hasRefundCandidates(logs, [])).toBe(false);
  });
  it("claims come from the journaled orders that kept their payload", () => {
    const s = (o: Partial<StoredSwap>) => ({ orderId: ORDER, attemptId: "0x01", refundCounter: COUNTER, provider: "thorchain", policy: "best-privacy", request: {}, params: {}, endpoint: "0x", createdAt: 0, state: "funded", ...o }) as StoredSwap;
    expect(refundClaims([s({ refundNoteData: PAYLOAD }), s({ orderId: "0x02" })])).toEqual([{ ...claim, kind: "refund" }]);
  });
});

// ---- the scan, end to end against a mock JSON-RPC server -----------------------------------------
const AMOUNT = 990_000_000_000_000_000n;
const ours = refundNote(ETH_VAULT, AMOUNT);
// leaf 0: someone's deposit; leaf 4: our order's refund; leaves 8..10: a transaction whose first output copied our public payload
const inserts: NoteInsertedLog[] = [ins(0, 0x1111n), ins(4, cm(ours, 4), PAYLOAD), ins(8, 0x8888n, PAYLOAD), ins(9, 0x9999n), ins(10, 0xaaaan)];
const deposits: DepositedLog[] = [dep(ETH_VAULT, 0, 5n, OTHER_OC), dep(ETH_VAULT, 4, AMOUNT)];
/** The chain the mock serves: its events and the tree the core would hold over them (groups of four). */
function chainOf(ins: NoteInsertedLog[], deps: DepositedLog[]) {
  const next = Math.ceil((Math.max(...ins.map((l) => l.leafIndex)) + 1) / 4) * 4;
  const leaves: bigint[] = Array(next).fill(ZERO_LEAF);
  for (const l of ins) leaves[l.leafIndex] = l.commitment;
  const t = new MerkleTree(TX_LEVELS);
  for (let i = 0; i < next; i += 4) t.insertGroup(leaves.slice(i, i + 4));
  return { inserts: ins, deposits: deps, next, root: t.root };
}
const scenarioA = chainOf(inserts, deposits);
let chain = scenarioA;

const EVENTS = parseAbi(["event Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex)"]);
const [NOTE_TOPIC] = encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted" });
const [DEPOSIT_TOPIC] = encodeEventTopics({ abi: EVENTS, eventName: "Deposited" });
const pad32 = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
const rpcLog = (address: Address, topics: Hex[], data: Hex, leaf: number) => ({ address: address.toLowerCase(), topics, data, blockNumber: "0x5", blockHash: "0x" + "22".repeat(32), transactionHash: tx(leaf), transactionIndex: "0x0", logIndex: toHex(leaf), removed: false });
const noteLog = (l: NoteInsertedLog) => rpcLog(CORE, encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: l.leafIndex } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]), l.leafIndex);
const depositLog = (d: DepositedLog) => rpcLog(d.vault, [DEPOSIT_TOPIC as Hex, pad32(d.ownerCommitment)], encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }], [d.amount, d.leafIndex]), d.leafIndex);

function mockRpc(deps: () => DepositedLog[], seen: { depositReads: number }) {
  const handle = (req: { id: number; method: string; params: any[] }) => {
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId": return res("0x7a69");
      case "eth_blockNumber": return res("0x10");
      case "eth_getLogs": {
        const t0 = req.params[0].topics?.[0];
        const topics: unknown[] = Array.isArray(t0) ? t0 : [t0]; // the notes and the spends come in one read (the sixth review round)
        if (topics.includes(NOTE_TOPIC)) return res(chain.inserts.map(noteLog));
        if (topics.includes(DEPOSIT_TOPIC)) { seen.depositReads++; const vaults = [req.params[0].address].flat().map((a: string) => a.toLowerCase()); return res(deps().filter((d) => vaults.includes(d.vault.toLowerCase())).map(depositLog)); }
        return res([]);
      }
      case "eth_call": {
        const data: string = req.params[0].data;
        if (data.startsWith(toFunctionSelector("nextLeafIndex()"))) return res(pad32(BigInt(chain.next)));
        if (data.startsWith(toFunctionSelector("currentRoot()"))) return res(pad32(chain.root));
        if (data.startsWith(toFunctionSelector("isNullifierSpent(uint256)"))) return res(pad32(0n));
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
      }
      default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
    }
  };
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); });
  });
}

const seen = { depositReads: 0 };
const lying = { depositReads: 0 };
let honest: Server, liar: Server, deployment: Deployment, liarUrl = "";
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; };
beforeAll(async () => {
  honest = mockRpc(() => chain.deposits, seen);
  liar = mockRpc(() => chain.deposits.map((d) => (d.leafIndex === 4 ? { ...d, amount: d.amount * 2n } : d)), lying);
  const url = await listen(honest);
  liarUrl = await listen(liar);
  deployment = { chainId: 31337, core: CORE, ethVault: ETH_VAULT, rpcUrl: url, rpcUrls: [url], fromBlock: 0n, erc20Vaults: [] };
});
afterAll(async () => { await new Promise<void>((r) => honest.close(() => r())); await new Promise<void>((r) => liar.close(() => r())); });
// the Forget closes the note store until the next unlock (the tenth review round, D-1); these cases scan with no wallet unlocked, so the
// store is opened again, empty
afterEach(() => { session.forget(); noteStore.load({ notes: [], noteCounter: 0 }); seen.depositReads = 0; chain = scenarioA; });

async function walletWithOrder(state = "funded") {
  await session.create("a strong password", seed);
  session.acknowledgePhrase();
  session.update((j) => { j.swaps.push({ orderId: ORDER, attemptId: "0x01", refundCounter: COUNTER, refundNoteData: PAYLOAD, provider: "thorchain", policy: "best-privacy", request: {}, params: {}, endpoint: "0x", createdAt: 0, state }); });
}

describe("a refunded order reaches the wallet (PP-S09)", () => {
  it("a rescan records the refund note with the vault's amount and leaves the order to its runner, which closes it once the escrow reads empty (the twelfth review round, C12-1); again, nothing new", async () => {
    await walletWithOrder();
    const r = await scanNotes({ masterSeed: seed, deployment });
    expect(r).toEqual({ scanned: 5, found: 1, added: 1, spent: 0, refunds: 1, received: [], pending: [], proven: null, leaves: expect.any(Number) }); // a refund is not a transfer received
    const note = noteStore.all().find((n) => n.leafIndex === 4)!;
    expect(note).toMatchObject({ label: "swap refund", counter: COUNTER, spent: false, note: ours });
    expect(noteStore.balance(BigInt(ETH_VAULT))).toBe(AMOUNT);
    const s = session.journal().swaps[0];
    expect(s.state).toBe("funded");
    expect(session.journal().schedule.some((a) => a.id === `order-tick:${ORDER}`), "its runner reads it now").toBe(true);
    expect(s.refunds).toEqual([{ leafIndex: 4, vault: ETH_VAULT.toLowerCase(), amount: AMOUNT.toString() }]);
    expect(await scanNotes({ masterSeed: seed, deployment })).toEqual({ scanned: 5, found: 1, added: 0, spent: 0, refunds: 1, received: [], pending: [], proven: null, leaves: expect.any(Number) });
    expect(session.journal().swaps[0].refunds!.length).toBe(1);
  });
  it("without a journaled order the vault deposits are never read (no extra request, nothing found)", async () => {
    expect(await scanNotes({ masterSeed: seed, deployment })).toEqual({ scanned: 5, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null, leaves: expect.any(Number) });
    expect(seen.depositReads).toBe(0);
  });
  it("right after the executor reports a refund, recoverSwapRefunds records it without a payload scan; a completed order keeps its state", async () => {
    await walletWithOrder("completed");
    const r = await recoverSwapRefunds({ masterSeed: seed, deployment });
    expect(r.map((x) => [x.orderId, x.leafIndex, x.note.amount])).toEqual([[ORDER, 4, AMOUNT]]);
    expect(noteStore.balance(BigInt(ETH_VAULT))).toBe(AMOUNT);
    expect(session.journal().swaps[0]).toMatchObject({ state: "completed", refunds: [{ leafIndex: 4 }] });
  });
  it("endpoints that disagree on the vault deposits are refused, not averaged; one lying endpoint alone gets no note accepted", async () => {
    await walletWithOrder();
    await expect(scanNotes({ masterSeed: seed, deployment: { ...deployment, rpcUrls: [deployment.rpcUrl, liarUrl] } })).rejects.toThrow(/disagree on the vault deposits/);
    const alone = await scanNotes({ masterSeed: seed, deployment: { ...deployment, rpcUrl: liarUrl, rpcUrls: [liarUrl] } });
    expect(alone.refunds).toBe(0);
    expect(noteStore.balance(BigInt(ETH_VAULT))).toBe(0n);
  });
});

describe("a wallet restored from its phrase alone: no journal (PP-P03, journal-free refunds)", () => {
  it("the refund payload is the seed's, per counter: deterministic, envelope-shaped, distinct; the order commits to it", () => {
    const p7 = refundPayload(seed, 7);
    expect(p7).toBe(refundPayload(seed, 7));
    expect((p7.length - 2) / 2).toBe(169);
    expect(p7.slice(0, 4)).toBe("0x01");
    expect(refundPayload(seed, 8)).not.toBe(p7);
    expect(refundPayload(sha256(utf8ToBytes("another seed")), 7)).not.toBe(p7);
    expect(deriveRefundNote(seed, 7).noteData).toBe(p7);
  });
  it("finds its own counters by their note secrets, in batches, and stops at the first batch with none", () => {
    const s = (c: number) => deriveNoteSecret(keys.noteKey, c);
    const m = usedCounters(keys.noteKey, [s(3), s(1500), 12345n], 1024);
    expect([...m.entries()]).toEqual([[s(3), 3], [s(1500), 1500]]);
    expect(usedCounters(keys.noteKey, [s(3000)], 1024).size, "a counter a whole empty batch beyond the last hit is not reached").toBe(0);
  });
  it("a rescan finds the wallet's own note and its refund without the journal, and the counter moves past both", async () => {
    // leaf 0: our note made with counter 5 (its envelope opens with our view key); leaf 4: a refund at counter 9, payload from the seed
    const own: Note = { vaultId: BigInt(ETH_VAULT), amount: 3n * 10n ** 17n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 5) };
    const envelope = hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: own.amount, noteSecret: own.noteSecret, vaultId: own.vaultId }));
    const refund = refundNote(ETH_VAULT, 4n * 10n ** 17n, 9);
    chain = chainOf([ins(0, cm(own, 0), envelope), ins(4, cm(refund, 4), refundPayload(seed, 9))], [dep(ETH_VAULT, 0, own.amount), dep(ETH_VAULT, 4, refund.amount)]);
    expect(session.isUnlocked(), "no journal: nothing journaled names the refund").toBe(false);
    expect(noteStore.nextCounter()).toBe(0);
    const r = await scanNotes({ masterSeed: seed, deployment });
    expect(r).toEqual({ scanned: 2, found: 2, added: 2, spent: 0, refunds: 1, received: [], pending: [], proven: null, leaves: expect.any(Number) }); // the wallet's own note (a counter) and its refund
    expect(noteStore.all().map((n) => [n.leafIndex, n.label, n.counter])).toEqual([[0, "discovered", 5], [4, "swap refund", 9]]);
    expect(noteStore.nextCounter(), "a counter used again would derive a note secret used again (PP-P03)").toBe(10);
    expect(noteStore.allocateCounter()).toBe(10);
  });
});
