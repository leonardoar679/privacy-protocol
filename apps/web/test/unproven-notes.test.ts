// A note past the pool proven at the latest finalized block (audit round 2, r24). An RPC quorum can answer one more
// NoteInserted in the tail no proof covers yet, made out to a published privacy address and encrypted to its view key: it
// entered the balance as received ("Private Receive … completed"), and nothing removed it once the real chain was served
// again — every spend that picked it failed until a restore. Now a transfer received there waits, out of the balance,
// until a scan proves its leaf; and a stored note at a proven leaf that holds another commitment is dropped.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { useCoreModule } from "@privacy-wallet/sdk/core";
import { scanNotes } from "@privacy-wallet/sdk/privateTx";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { startMockCore } from "./helpers/mockRpc";

/** The leaves the light client proves at the latest finalized block (null: no light client for this chain). */
const proof = vi.hoisted(() => ({ leaves: null as number | null, asked: [] as number[] }));
vi.mock("@privacy-wallet/sdk/verifiedReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/verifiedReads")>()),
  verifyTree: async () =>
    proof.leaves === null
      ? { kind: "unavailable", reason: "no light client for this chain" }
      : { kind: "verified", proof: { blockNumber: 1n, slot: 1, nextLeafIndex: proof.leaves, root: 0n }, leaves: proof.leaves },
  provenSpent: async (_d: unknown, nullifiers: bigint[]) => {
    proof.asked.push(nullifiers.length);
    return null;
  },
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const seed = sha256(utf8ToBytes("unproven-notes-test-seed"));
const keys = deriveKeys(seed);
const view = viewKeyPair(keys.viewKey);
const main = ownerCommitmentOf(keys.spendKey);
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const plain = (n: Note) => ({ amount: n.amount, noteSecret: n.noteSecret, vaultId: n.vaultId });

// leaf 0: a protect of this wallet (counter 0); leaf 4: a transfer received (a secret no counter gives)
const own: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: main, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const received: Note = { vaultId: BigInt(VAULT), amount: 50n * 10n ** 18n, ownerCommitment: main, noteSecret: 777n };
const events: Record<number, { commitment: bigint; noteData: Hex }> = {
  0: { commitment: noteCommitment(noteBody(own), 0n), noteData: hex(encryptNoteData(view.publicKey, plain(own))) },
  4: { commitment: noteCommitment(noteBody(received), 4n), noteData: hex(encryptNoteData(view.publicKey, plain(received))) },
};
const tree = new MerkleTree(TX_LEVELS);
for (const leaf of [0, 4]) tree.insertGroup([events[leaf].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);

let mock: Awaited<ReturnType<typeof startMockCore>>;
const deployment = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: mock.url, rpcUrls: [mock.url], fromBlock: 0n, erc20Vaults: [] });
const leaves = () =>
  noteStore
    .all()
    .map((n) => n.leafIndex)
    .sort((a, b) => a - b);
beforeAll(async () => {
  mock = await startMockCore({ core: CORE, events, nextLeafIndex: 8, root: tree.root });
});
afterAll(() => mock.close());
beforeEach(() => {
  useCoreModule(null);
  noteStore.clear();
  proof.leaves = null;
});

describe("notes past the pool the light client proved (audit round 2, r24)", () => {
  it("a transfer received past the proven pool waits, out of the balance, until the scan whose proof covers its leaf adds it", async () => {
    proof.leaves = 4; // the received note's leaf is in the tail no proof covers yet
    const first = await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(leaves(), "this wallet's own note only").toEqual([0]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(own.amount);
    expect(first.received).toEqual([]);
    expect(first.pending).toEqual([expect.objectContaining({ leafIndex: 4, amount: received.amount })]);
    expect(first.proven).toBe(4);
    proof.leaves = 8;
    const second = await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(leaves()).toEqual([0, 4]);
    expect(second.received).toEqual([expect.objectContaining({ leafIndex: 4, amount: received.amount })]);
    expect(second.pending).toEqual([]);
  });

  it("where no light client applies, the reads rest on the RPC quorum as before: the transfer is received at once", async () => {
    const r = await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(leaves()).toEqual([0, 4]);
    expect(r.received).toEqual([expect.objectContaining({ leafIndex: 4 })]);
    expect(r).toMatchObject({ pending: [], proven: null });
  });

  it("a scan proves only the notes the endpoint calls unspent: the spent ones of a wallet's history are not proven again (audit round 2, n44)", async () => {
    proof.leaves = 8;
    await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(proof.asked.at(-1), "both unspent: both proven").toBe(2);
    noteStore.clear();
    mock.state.spent = true;
    try {
      await scanNotes({ masterSeed: seed, deployment: deployment() });
      expect(proof.asked.at(-1), "both spent: none").toBe(0);
      expect(noteStore.all().every((n) => n.spent)).toBe(true);
    } finally {
      mock.state.spent = false;
    }
  });

  it("a stored note at a proven leaf that holds another commitment is dropped; one past the proven pool is left", async () => {
    const phantom: Note = { vaultId: BigInt(VAULT), amount: 7n * 10n ** 18n, ownerCommitment: main, noteSecret: 4242n };
    noteStore.add({ note: phantom, leafIndex: 1, noteData: "0x", spent: false, label: "change" }); // the leaf a receipt named: it holds no such note
    noteStore.add({ note: phantom, leafIndex: 9, noteData: "0x", spent: false }); // past the proven pool
    proof.leaves = 8;
    await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(leaves()).toEqual([0, 4, 9]);
    expect(noteStore.balance(BigInt(VAULT))).toBe(own.amount + received.amount + phantom.amount);
  });
});
