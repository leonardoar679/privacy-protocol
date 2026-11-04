// The eleventh review round (2026-11-04), slice 2a after its diff critique (T3): H11-5 — a scan's findings are one change of the note store. What
// recordFound adds or marks, and the counters the scan saw (its observeCounter loop), each reach the journal in one write: the store had emitted
// at every note and every counter, and the session serialised, encrypted and wrote the whole growing journal each time — about 2n writes for a
// scan that found n notes. review11-notes.test.ts drives noteStore.batch alone, so a build whose scan called the store directly again
// (BATCH_SCAN) passed every SDK test; here one real scanNotes reads a pool holding sixteen notes this seed opens, and the device's store counts
// every write of JOURNAL_KEY.
// Offline: the JSON-RPC endpoint is an in-process fetch answering what helpers/mockPool.ts answers over loopback (the core's logs, its leaf count
// and root) — no socket; chain 31337 has no light client. The pool sync, the payload opening, the scan, the session and its journal are the real
// code's.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, toFunctionSelector, toHex, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { nullifier } from "@privacy-wallet/protocol/nullifier";
import { configure, defaultConfig } from "../src/config";
import { useCoreModule } from "../src/core";
import { coreAbi } from "../src/privacyProtocol";
import { COUNTER_RESERVE, scanNotes } from "../src/privateTx";
import { depositOwnerCommitment, ownerKeyOf } from "../src/keys/ownerKeys";
import { memoryStorage, JOURNAL_KEY, type KeyValueStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { seedToPhrase } from "../src/wallet/keystore";
import { noteStore } from "../src/wallet/notes";
import { decryptJournal, journalKey, type EncryptedJournal, type JournalData } from "../src/wallet/journal";
import type { Deployment } from "../src/chain";

/** the notes this seed opens in the pool: one write per note would be 16, two would be 32 — the batches' one to three are neither */
const N = 16;
const PASSWORD = "a strong password";
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const keys = deriveKeys(SEED);
const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const RPC = "http://127.0.0.1:1";
const deployment: Deployment = { chainId: 31337, core: CORE, ethVault: VAULT, rpcUrl: RPC, rpcUrls: [RPC], fromBlock: 0n, erc20Vaults: [] };
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

// the pool: this seed's note k (counter k) at leaf 2k — a deposit made out to its own owner commitment, or a change note made out to the privacy
// address's —, and someone else's at 2k + 1 (a payload no key of this wallet opens)
interface Insert {
  leafIndex: number;
  commitment: bigint;
  noteData: Hex;
}
const ours = Array.from({ length: N }, (_, k) => {
  const noteSecret = deriveNoteSecret(keys.noteKey, k);
  const owner = k % 2 === 0 ? depositOwnerCommitment(keys, noteSecret) : ownerCommitmentOf(keys.spendKey);
  const note: Note = { vaultId: BigInt(VAULT), amount: BigInt(k + 1) * 10n ** 17n, ownerCommitment: owner, noteSecret };
  const leafIndex = 2 * k;
  const commitment = noteCommitment(noteBody(note), BigInt(leafIndex));
  const noteData = hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: note.amount, noteSecret, vaultId: note.vaultId }));
  return { leafIndex, commitment, noteData, nullifier: nullifier(commitment, ownerKeyOf(keys, note)!) };
});
const INSERTS: Insert[] = ours.flatMap((o, k) => [o, { leafIndex: 2 * k + 1, commitment: 0xf00000n + BigInt(k), noteData: hex(dummyNoteData()) }]);
const NEXT = 2 * N;
const rootOf = (inserts: Insert[], next: number): bigint => {
  const leaves = new Map(inserts.map((l) => [l.leafIndex, l.commitment]));
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
const ROOT = rootOf(INSERTS, NEXT);
/** what the endpoint answers besides the notes: the pool's spends (a transact's two nullifiers) and its head */
const pool = { spends: [] as [bigint, bigint][], block: 0x40n };

// the endpoint (helpers/mockPool.ts's answers): NoteInserted and ShieldedTransaction logs filtered by address and topic0 like a node, the core's
// nextLeafIndex and currentRoot, the head; anything else is an error, and no request leaves for any other URL
const SHIELDED = encodeEventTopics({ abi: coreAbi, eventName: "ShieldedTransaction" })[0];
const SEL = { next: toFunctionSelector("nextLeafIndex()"), root: toFunctionSelector("currentRoot()") };
const pad32 = (v: bigint): Hex => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
const logAt = (logIndex: number, transactionHash: string) => ({
  address: CORE.toLowerCase(),
  blockNumber: "0x5",
  blockHash: "0x" + "22".repeat(32),
  transactionHash,
  transactionIndex: "0x0",
  logIndex: toHex(logIndex),
  removed: false,
});
const noteLog = (l: Insert) => ({
  ...logAt(l.leafIndex, "0x" + "33".repeat(28) + l.leafIndex.toString(16).padStart(8, "0")),
  topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: l.leafIndex } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
});
const spendLog = ([n0, n1]: [bigint, bigint], i: number) => ({
  ...logAt(1000 + i, "0x" + "55".repeat(31) + i.toString(16).padStart(2, "0")),
  topics: [SHIELDED],
  data: encodeAbiParameters(Array(5).fill({ type: "uint256" }), [n0, n1, 0n, 0n, 0n]),
});
interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}
function answer(req: RpcRequest) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const refused = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });
  switch (req.method) {
    case "eth_chainId":
      return ok(toHex(deployment.chainId));
    case "eth_blockNumber":
      return ok(toHex(pool.block));
    case "eth_getLogs": {
      const f = (req.params[0] ?? {}) as { address?: string | string[]; topics?: (string | string[] | null)[] };
      const at = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a) => a.toLowerCase());
      const t0 = f.topics?.[0];
      const wanted = (topic: string) => !t0 || (Array.isArray(t0) ? t0 : [t0]).some((t) => t.toLowerCase() === topic.toLowerCase());
      const logs = [...INSERTS.map(noteLog), ...pool.spends.map(spendLog)];
      return ok(logs.filter((l) => (!at.length || at.includes(l.address)) && wanted(l.topics[0] as string)));
    }
    case "eth_call": {
      const data = (req.params[0] as { data: string }).data;
      if (data.startsWith(SEL.next)) return ok(pad32(BigInt(NEXT)));
      if (data.startsWith(SEL.root)) return ok(pad32(ROOT));
      return refused(-32000, "mock: unknown call");
    }
    default:
      return refused(-32601, `mock: ${req.method} unsupported`);
  }
}
const realFetch = globalThis.fetch;
const rpcFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(RPC)) throw new TypeError(`offline: this test answers ${RPC} only, not ${url}`);
  const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { headers: { "content-type": "application/json" } });
};

// the device's store, counting: every journal handed to it, in order, as stored (encrypted) — by one write or inside several at once
const disk = memoryStorage();
const written: string[] = [];
const store: KeyValueStorage = {
  get: (k) => disk.get(k),
  set: (k, v) => {
    if (k === JOURNAL_KEY) written.push(v);
    disk.set(k, v);
  },
  remove: (k) => disk.remove(k),
  setMany: (entries) => {
    for (const [k, v] of entries) if (k === JOURNAL_KEY && v !== null) written.push(v);
    disk.setMany!(entries);
  },
};
const journals = (): JournalData[] => written.map((blob) => decryptJournal(journalKey(SEED), JSON.parse(blob) as EncryptedJournal)!);

/** A restore from the phrase on a device without this wallet's journal: the store empty, its counters held until one complete scan (PP-P03). */
async function restoredFromPhrase(): Promise<void> {
  session.forget();
  await session.restoreFromPhrase(seedToPhrase(SEED), PASSWORD);
  session.acknowledgePhrase();
}
/** The wallet made on this device, its journal current: nothing held. */
async function created(): Promise<void> {
  session.forget();
  await session.create(PASSWORD, SEED);
  session.acknowledgePhrase();
}
const scan = () => scanNotes({ masterSeed: session.state().seed!, deployment });

beforeAll(() => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => store }));
  useCoreModule(null); // the TypeScript reference opens the payloads and hashes the tree
  globalThis.fetch = rpcFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("one scan, a constant number of journal writes (H11-5)", () => {
  it("a restore's first scan records the sixteen notes this seed opens in three journal writes — its findings, the counters it saw, the hold's release — never one or two per note", async () => {
    await restoredFromPhrase();
    pool.spends = [];
    pool.block = 0x40n;
    written.length = 0;
    expect(await scan()).toEqual({ scanned: 2 * N, found: N, added: N, spent: 0, refunds: 0, received: [], pending: [], proven: null, leaves: NEXT });
    const notes = ours.map((o, k) => [o.leafIndex, k]); // each at its leaf, with the counter its secret derives from
    const each = journals().map((j) => ({ notes: j.notes.map((n) => [n.leafIndex, n.counter]), noteCounter: j.noteCounter, held: j.countersHeld === true }));
    expect(each).toEqual([
      { notes, noteCounter: 0, held: true }, // recordFound: every note found, one change of the store
      { notes, noteCounter: N, held: true }, // the observeCounter loop: counters 0…15 seen, one change
      { notes, noteCounter: N + COUNTER_RESERVE, held: false }, // the complete scan releases the restore's hold, past the reserve
    ]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(136n * 10n ** 17n);
    // control: the same restore and scan with the store's batch a pass-through — recordFound's and the counters' calls made one by one, as the
    // BATCH_SCAN build makes them — write once per note found, once per counter raised and once at the release: the count above would see it
    await restoredFromPhrase();
    written.length = 0;
    const direct = vi.spyOn(noteStore, "batch").mockImplementation((fn) => fn());
    try {
      await scan();
    } finally {
      direct.mockRestore();
    }
    expect(written, "control: two writes per note, and the release").toHaveLength(2 * N + 1);
    expect(journals()[0].notes, "control: the first of them holds one note").toHaveLength(1);
  });

  it("a rescan that finds every one of those notes spent marks the sixteen in one journal write; the counters it sees again raise nothing and write nothing", async () => {
    await created();
    pool.spends = [];
    pool.block = 0x40n;
    await scan(); // the notes recorded, counters 0…15 seen
    expect(noteStore.unspent()).toHaveLength(N);
    // eight transacts by block 0x41, each spending two of the notes
    pool.spends = Array.from({ length: N / 2 }, (_, i): [bigint, bigint] => [ours[2 * i].nullifier, ours[2 * i + 1].nullifier]);
    pool.block = 0x41n;
    written.length = 0;
    expect(await scan()).toEqual({ scanned: 2 * N, found: N, added: 0, spent: N, refunds: 0, received: [], pending: [], proven: null, leaves: NEXT });
    const each = journals().map((j) => ({ notes: j.notes.map((n) => [n.leafIndex, n.spent, n.spentUnproven, n.spentAtBlock]), noteCounter: j.noteCounter }));
    // every mark in one change, each unproven (no light client on this chain) at the block the spends were read at; the counter as it was
    expect(each).toEqual([{ notes: ours.map((o) => [o.leafIndex, true, true, 0x41]), noteCounter: N }]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(0n);
  });
});
