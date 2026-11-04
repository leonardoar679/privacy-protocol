// The ninth review round (2026-11-04), how the wallet knows what is on chain: a spent mark's block is bounded by what the chain can be at,
// and a mark past it is lifted (D-2); a note recorded past the pool the endpoints agree on is dropped once they have caught up, a refund
// replayed in the tail waits for a proof, a pending Receive line the pool no longer shows fails (D-1); every endpoint's receipt agrees in
// full (D-4); two notes at one leaf are refused (D-9); one host is one host (D-10). The reviewer's probes (scratchpad review9/D P2, P3,
// P4, P10, P8 F11) became these cases, on its loopback pool (helpers/mockPool.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Hex, type PublicClient } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { nullifier } from "@privacy-wallet/protocol/nullifier";
import { FIELD } from "@privacy-wallet/protocol/field";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { prepareShield, recoverSwapRefunds, scanNotes, trackShieldCost, FINALIZED_LEAD_BLOCKS, PAST_POOL_GRACE_MS } from "../src/privateTx";
import { noteStore } from "../src/wallet/notes";
import { coreAbi } from "../src/privacyProtocol";
import { depositOwnerCommitment } from "../src/keys/ownerKeys";
import { refundPayload } from "../src/keys/swapKeys";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { minedTx, ReceiptDisputed, rpcUrlsOf, type Deployment } from "../src/chain";
import { runDiscovery, DISCOVERY_ID } from "../src/wallet/discovery";
import { agreedFinalizedRoot } from "../src/lightclient";
import { startPool, type Insert } from "./helpers/mockPool";

// the light client: the pool proven at finalized block 100 (`proven` leaves), every nullifier proven unspent there
const lc = vi.hoisted(() => ({ proven: 8 }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => ({ kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven }),
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const rootOf = (leaves: Map<number, bigint>, next: number) => {
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: pool.url, rpcUrls: [pool.url], fromBlock: 0n, erc20Vaults: [] });
function serve(inserts: Insert[], next: number) {
  pool.state.inserts = inserts;
  pool.state.next = next;
  pool.state.root = rootOf(new Map(inserts.map((i) => [i.leafIndex, i.commitment])), next);
}

beforeAll(async () => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => memoryStorage() }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  pool = await startPool({ core: CORE, inserts: [], next: 0, root: rootOf(new Map(), 0) });
});
afterAll(async () => {
  setActiveProvider(null);
  await pool.close();
});
beforeEach(() => {
  useCoreModule(null);
  noteStore.clear();
  lc.proven = 8;
  pool.state.spends = [];
  pool.state.deposits = [];
  pool.state.block = 0x80n;
});
afterEach(() => vi.useRealTimers());

describe("D-2: a spent mark at a block the chain cannot be at", () => {
  const seed = new Uint8Array(32).fill(7);
  const keys = deriveKeys(seed);
  const own: Note = {
    vaultId: BigInt(VAULT),
    amount: 3n * 10n ** 18n,
    ownerCommitment: ownerCommitmentOf(keys.spendKey),
    noteSecret: deriveNoteSecret(keys.noteKey, 0),
  };
  const C0 = noteCommitment(noteBody(own), 0n);
  const NF = nullifier(C0, keys.spendKey);
  const inserts = (): Insert[] => [
    {
      leafIndex: 0,
      commitment: C0,
      noteData: hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: own.amount, noteSecret: own.noteSecret, vaultId: own.vaultId })),
    },
    { leafIndex: 4, commitment: 123n, noteData: ("0x" + "ab".repeat(169)) as Hex },
  ];
  const at0 = () => noteStore.all().find((n) => n.leafIndex === 0)!;

  it("one lying scan naming a head of 1e15: the mark is bounded by the finalized block's lead, and the next honest scan lifts it", async () => {
    serve(inserts(), 8);
    pool.state.spends = [{ n0: NF, n1: FIELD - 1n - NF }];
    pool.state.block = 10n ** 15n;
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(at0()).toMatchObject({ spent: true, spentUnproven: true, spentAtBlock: 100 + FINALIZED_LEAD_BLOCKS });
    pool.state.spends = [];
    pool.state.block = 0x90n;
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(at0().spent).toBe(false);
    expect(noteStore.balance(BigInt(VAULT))).toBe(own.amount);
  });

  it("a mark made before this rule at a far block is lifted by an honest scan that no longer lists the spend", async () => {
    serve(inserts(), 8);
    await scanNotes({ masterSeed: seed, deployment: d() });
    noteStore.markSpent([0], { atBlock: 1e15 });
    pool.state.block = 0x90n;
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(at0().spent).toBe(false);
  });

  it("control: a mark at an ordinary block stands while every endpoint lists the spend", async () => {
    serve(inserts(), 8);
    pool.state.spends = [{ n0: NF, n1: FIELD - 1n - NF }];
    pool.state.block = 0x90n;
    await scanNotes({ masterSeed: seed, deployment: d() });
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(at0()).toMatchObject({ spent: true, spentAtBlock: 0x90 });
  });
});

describe("D-1: notes recorded past the pool", () => {
  const FAR = 2 ** 31;
  it("a Protect receipt from the connected wallet's provider that names a far leaf: dropped once the endpoints have had the time to catch up", async () => {
    const seed = session.state().seed!;
    const p = prepareShield({ masterSeed: seed, deployment: d(), amount: 10n ** 18n });
    const HASH = ("0x" + "ab".repeat(32)) as Hex;
    const fakeLog = {
      address: CORE.toLowerCase(),
      topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: FAR } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [noteCommitment(noteBody(p.note), BigInt(FAR)), p.noteData]),
      blockNumber: "0x10",
      blockHash: "0x" + "22".repeat(32),
      transactionHash: HASH,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
    const receipt = {
      transactionHash: HASH,
      transactionIndex: "0x0",
      blockHash: "0x" + "22".repeat(32),
      blockNumber: "0x10",
      from: "0x" + "11".repeat(20),
      to: CORE.toLowerCase(),
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      contractAddress: null,
      logs: [fakeLog],
      logsBloom: "0x" + "00".repeat(256),
      status: "0x1",
      type: "0x2",
    };
    setActiveProvider({
      request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : method === "eth_getTransactionReceipt" ? receipt : null),
    } as never);
    expect((await trackShieldCost(p, HASH)).leafIndex).toBe(FAR);
    // the real deposit lands at leaf 0; a scan right away keeps the far note (the endpoints may lag the wallet's provider)
    serve([{ leafIndex: 0, commitment: noteCommitment(noteBody(p.note), 0n), noteData: p.noteData }], 4);
    lc.proven = 4;
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(
      noteStore
        .all()
        .map((n) => n.leafIndex)
        .sort((a, b) => a - b),
    ).toEqual([0, FAR]);
    // past the grace the far note is gone: the deposit counts once
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PAST_POOL_GRACE_MS + 1000);
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(noteStore.all().map((n) => n.leafIndex)).toEqual([0]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(p.note.amount);
  });

  it("a refund replayed by a lying quorum at a tail leaf waits for a proof, as a scan's own find does", async () => {
    const seed = session.state().seed!;
    const keys = deriveKeys(seed);
    const counter = 5;
    const secret = deriveNoteSecret(keys.noteKey, counter);
    const oc = depositOwnerCommitment(keys, secret);
    const payload = refundPayload(seed, counter);
    const amount = 7n * 10n ** 17n;
    const note: Note = { vaultId: BigInt(VAULT), amount, ownerCommitment: oc, noteSecret: secret };
    const ins = (leaf: number): Insert => ({ leafIndex: leaf, commitment: noteCommitment(noteBody(note), BigInt(leaf)), noteData: payload });
    const REPLAY = 1000;
    serve([ins(0), ins(REPLAY)], REPLAY + 4);
    pool.state.deposits = [
      { vault: VAULT, ownerCommitment: oc, amount, leafIndex: 0 },
      { vault: VAULT, ownerCommitment: oc, amount, leafIndex: REPLAY },
    ];
    lc.proven = 4;
    const found = await recoverSwapRefunds({
      masterSeed: seed,
      deployment: d(),
      refunds: [{ orderId: "0x01", noteData: payload, counter, kind: "refund", ownerCommitment: oc }],
    });
    expect(found.map((f) => f.leafIndex)).toEqual([0]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(amount);
  });

  it("a pending Receive line the pool no longer shows fails once the endpoints are honest again", async () => {
    const seed = session.state().seed!;
    const keys = deriveKeys(seed);
    const fake: Note = { vaultId: BigInt(VAULT), amount: 1000n * 10n ** 18n, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: 555n };
    const LEAF = 1000;
    const payload = hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: fake.amount, noteSecret: fake.noteSecret, vaultId: fake.vaultId }));
    serve(
      [
        { leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex },
        { leafIndex: LEAF, commitment: noteCommitment(noteBody(fake), BigInt(LEAF)), noteData: payload },
      ],
      LEAF + 4,
    );
    lc.proven = 4;
    const action = { id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never;
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    const line = () => (session.journal().activity ?? []).find((x) => x.id === `receive:${LEAF}`);
    expect(line()).toMatchObject({ status: "pending" });
    serve([{ leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex }], 4);
    // a view that does not reach the line's leaf may only lag (the tenth review round, B10-3): within the grace a recorded note gets, it waits
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session });
    expect(line()?.status).toBe("pending");
    await runDiscovery(action, { masterSeed: seed, deployment: d(), session, now: () => Date.now() + PAST_POOL_GRACE_MS + 1000 });
    expect(line()?.status).toBe("failed");
    expect(noteStore.balance(BigInt(VAULT))).toBe(0n);
  });
});

describe("D-9: two notes at one leaf", () => {
  it("are refused at the read: the scan stops, nothing is recorded", async () => {
    const seed = new Uint8Array(32).fill(3);
    serve([{ leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex }], 4);
    pool.state.inserts = [...pool.state.inserts, { leafIndex: 0, commitment: 12n, noteData: ("0x" + "12".repeat(169)) as Hex }];
    await expect(scanNotes({ masterSeed: seed, deployment: d() })).rejects.toThrow(/two NoteInserted events at leaf 0/);
    expect(noteStore.all()).toEqual([]);
  });
});

describe("D-4: every endpoint's receipt, in full", () => {
  const RECIPIENT = getAddress("0x" + "42".repeat(20));
  const HASH = ("0x" + "77".repeat(32)) as Hex;
  const claimEv = parseAbiItem("event WithdrawalClaimCreated(address indexed recipient, uint256 amount)");
  const spendLog = {
    address: CORE,
    topics: encodeEventTopics({ abi: coreAbi, eventName: "ShieldedTransaction" }) as Hex[],
    data: encodeAbiParameters(Array(5).fill({ type: "uint256" }), [11n, 12n, 0n, 0n, 0n]),
  };
  const claimLog = {
    address: VAULT,
    topics: encodeEventTopics({ abi: [claimEv], eventName: "WithdrawalClaimCreated", args: { recipient: RECIPIENT } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [10n ** 18n]),
  };
  const receipt = (blockNumber: bigint, logs: { address: string; topics: Hex[]; data: Hex }[]) => ({
    status: "success" as const,
    blockHash: ("0x" + "b1".repeat(32)) as Hex,
    blockNumber,
    transactionHash: HASH,
    logs,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
  });
  const endpoint = (r: ReturnType<typeof receipt>) => ({ waitForTransactionReceipt: async () => r }) as unknown as PublicClient;
  it("another block number, or a vault's claim one endpoint drops or adds: disputed, never the first endpoint's word", async () => {
    await expect(minedTx(endpoint(receipt(1n, [spendLog])), HASH, CORE, [endpoint(receipt(150n, [spendLog, claimLog]))])).rejects.toBeInstanceOf(
      ReceiptDisputed,
    );
    await expect(minedTx(endpoint(receipt(150n, [spendLog, claimLog])), HASH, CORE, [endpoint(receipt(150n, [spendLog]))])).rejects.toBeInstanceOf(
      ReceiptDisputed,
    );
    const m = await minedTx(endpoint(receipt(150n, [spendLog, claimLog])), HASH, CORE, [endpoint(receipt(150n, [spendLog, claimLog]))]);
    expect(m).toMatchObject({ blockNumber: 150, claims: [{ vault: VAULT, recipient: RECIPIENT, amount: 10n ** 18n }] });
  });
});

describe("D-10: one host is one host", () => {
  it("the endpoints are each counted once, and two ports of one beacon host do not pass the first-use rule", async () => {
    expect(rpcUrlsOf({ rpcUrl: "https://a.example", rpcUrls: ["https://a.example", "https://a.example", "https://b.example"] })).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    // however it is spelled (the tenth review round, B10-12): a trailing slash or the host's case is no second endpoint; the path's case is the path's
    expect(
      rpcUrlsOf({
        rpcUrl: "x",
        rpcUrls: ["https://A.example/", "https://a.example", " https://a.example// ", "https://a.example/Key/", "https://a.example/key"],
      }),
    ).toEqual(["https://A.example/", "https://a.example/Key/", "https://a.example/key"]);
    const fetchFn = (async () => new Response("{}")) as unknown as typeof fetch;
    await expect(agreedFinalizedRoot(["https://beacon.example", "https://beacon.example:8443"], fetchFn)).rejects.toThrow(/two beacon APIs on different hosts/);
  });
});
