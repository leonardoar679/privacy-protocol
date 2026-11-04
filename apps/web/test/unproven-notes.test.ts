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
import { RpcDisagreement } from "@privacy-wallet/sdk/chain";
import { startMockCore } from "./helpers/mockRpc";
import { nullifier } from "@privacy-wallet/protocol/nullifier";

/** The leaves the light client proves at the latest finalized block (null: no light client for this chain); the spent bits it proves (spentAll: null = no proof) and that block. */
const proof = vi.hoisted(() => ({ leaves: null as number | null, asked: [] as number[], spentAll: null as boolean | null, spentBlock: 32n }));
vi.mock("@privacy-wallet/sdk/verifiedReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/verifiedReads")>()),
  verifyTree: async () =>
    proof.leaves === null
      ? { kind: "unavailable", reason: "no light client for this chain" }
      : { kind: "verified", proof: { blockNumber: 1n, slot: 1, nextLeafIndex: proof.leaves, root: 0n }, leaves: proof.leaves },
  provenSpent: async (_d: unknown, nullifiers: bigint[]) => {
    proof.asked.push(nullifiers.length);
    return proof.spentAll === null || !nullifiers.length
      ? null
      : { blockNumber: proof.spentBlock, blocks: nullifiers.map(() => proof.spentBlock), spent: nullifiers.map(() => proof.spentAll!) };
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
const NULLIFIERS = [0, 4].map((leaf) => nullifier(events[leaf].commitment, keys.spendKey));

let mock: Awaited<ReturnType<typeof startMockCore>>;
/** a second endpoint serving the same pool (the third review round: the spent bits must agree across endpoints) */
let other: Awaited<ReturnType<typeof startMockCore>>;
/** a pool with this wallet's second own note (counter 1) at leaf 8, in the tail no proof covers yet */
let tailed: Awaited<ReturnType<typeof startMockCore>>;
const own2: Note = { vaultId: BigInt(VAULT), amount: 2n * 10n ** 18n, ownerCommitment: main, noteSecret: deriveNoteSecret(keys.noteKey, 1) };
const deployment = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: mock.url, rpcUrls: [mock.url], fromBlock: 0n, erc20Vaults: [] });
const leaves = () =>
  noteStore
    .all()
    .map((n) => n.leafIndex)
    .sort((a, b) => a - b);
beforeAll(async () => {
  mock = await startMockCore({ core: CORE, events, nextLeafIndex: 8, root: tree.root });
  other = await startMockCore({ core: CORE, events, nextLeafIndex: 8, root: tree.root });
  const tailEvents = { ...events, 8: { commitment: noteCommitment(noteBody(own2), 8n), noteData: hex(encryptNoteData(view.publicKey, plain(own2))) } };
  const tailTree = new MerkleTree(TX_LEVELS);
  for (const leaf of [0, 4, 8]) tailTree.insertGroup([tailEvents[leaf as 0 | 4 | 8].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
  tailed = await startMockCore({ core: CORE, events: tailEvents, nextLeafIndex: 12, root: tailTree.root });
});
afterAll(() => {
  mock.close();
  other.close();
  tailed.close();
});
beforeEach(() => {
  useCoreModule(null);
  noteStore.clear();
  proof.leaves = null;
  proof.spentAll = null;
  proof.spentBlock = 32n;
  mock.state.spent = false;
  other.state.spent = false;
  // the wallet's nullifiers (both notes are the privacy address's: the spend key's): what `spent` marks through the pool's events
  mock.state.allNullifiers = NULLIFIERS;
  other.state.allNullifiers = NULLIFIERS;
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

  it("a scan proves what the endpoints call unspent and the spent marks not yet proven — never the proven history of spent notes (audit round 2, n44; the third review round, 2026-11-03)", async () => {
    proof.leaves = 8;
    await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(proof.asked.at(-1), "both unspent: both proven").toBe(2);
    noteStore.clear();
    mock.state.spent = true;
    proof.spentAll = true;
    try {
      await scanNotes({ masterSeed: seed, deployment: deployment() });
      expect(proof.asked.at(-1), "both spent, new to the store: both marks proven once").toBe(2);
      expect(
        noteStore.all().every((n) => n.spent && n.spentUnproven === undefined),
        "and final",
      ).toBe(true);
      await scanNotes({ masterSeed: seed, deployment: deployment() });
      expect(proof.asked.at(-1), "a wallet's spent history is not proven again").toBe(0);
    } finally {
      mock.state.spent = false;
    }
  });

  it("this wallet's own note in the unproven tail waits too (the third review round, 2026-11-03): a protect's opening is public, so the quorum could replay it there; it enters when the proof covers its leaf, never as received", async () => {
    const d = { ...deployment(), rpcUrl: tailed.url, rpcUrls: [tailed.url] };
    proof.leaves = 8;
    const first = await scanNotes({ masterSeed: seed, deployment: d });
    expect(leaves(), "the received note at 4 is proven; the own note at 8 is in the tail").toEqual([0, 4]);
    expect(first.pending, "an own note is never a transfer received").toEqual([]);
    expect(noteStore.nextCounter(), "its counter is still observed").toBe(2);
    proof.leaves = 12;
    const second = await scanNotes({ masterSeed: seed, deployment: d });
    expect(leaves()).toEqual([0, 4, 8]);
    expect(second.received).toEqual([]);
    expect(noteStore.all().find((n) => n.leafIndex === 8)).toMatchObject({ counter: 1, spent: false });
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

describe("the spent bits come from every endpoint and are proven both ways (the third review round, 2026-11-03)", () => {
  const two = (): Deployment => ({ ...deployment(), rpcUrls: [mock.url, other.url] });
  it("one endpoint's false 'spent' fails the scan instead of hiding the note: the endpoints must agree, and nothing is written", async () => {
    other.state.spent = true;
    await expect(scanNotes({ masterSeed: seed, deployment: two() })).rejects.toBeInstanceOf(RpcDisagreement);
    expect(noteStore.all()).toEqual([]);
    other.state.spent = false;
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(noteStore.all().map((n) => n.spent)).toEqual([false, false]);
  });
  it("a spent mark the quorum makes waits for its proof at the block it was seen at (16): a finalized chain before that decides nothing; at or past it without the spend lifts the mark; with the spend confirms it", async () => {
    mock.state.spent = true;
    other.state.spent = true;
    proof.leaves = 8;
    proof.spentAll = false;
    proof.spentBlock = 8n; // finalized before the read: undecided
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(noteStore.all().map((n) => [n.spent, n.spentUnproven, n.spentAtBlock])).toEqual([
      [true, true, 16],
      [true, true, 16],
    ]);
    expect(proof.asked.at(-1), "both marks proven (none unspent)").toBe(2);
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(
      noteStore.all().every((n) => n.spent && n.spentUnproven),
      "still undecided: finalized 8 < 16",
    ).toBe(true);
    proof.spentBlock = 16n; // the finalized chain reaches the block of the read and has no such spend: the quorum lies, or the block was dropped
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(
      noteStore.all().map((n) => n.spent),
      "lifted",
    ).toEqual([false, false]);
    expect(noteStore.all().every((n) => n.spentUnproven === undefined && n.spentAtBlock === undefined)).toBe(true);
    proof.spentAll = true; // the proof confirms the spends
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(noteStore.all().map((n) => [n.spent, n.spentUnproven])).toEqual([
      [true, undefined],
      [true, undefined],
    ]);
    expect(proof.asked.at(-1), "proven marks are not proven again (n44)").toBe(2);
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(proof.asked.at(-1), "nothing left to prove").toBe(0);
  });
  it("without a light client, a mark the quorum no longer makes is lifted (a dropped block); a proven mark is never lifted on the quorum's word", async () => {
    mock.state.spent = true;
    other.state.spent = true;
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(noteStore.all().map((n) => [n.spent, n.spentUnproven])).toEqual([
      [true, true],
      [true, true],
    ]);
    mock.state.spent = false;
    other.state.spent = false;
    noteStore.confirmSpent([0]); // as the light client would have
    await scanNotes({ masterSeed: seed, deployment: two() });
    expect(noteStore.all().find((n) => n.leafIndex === 0)!.spent, "a proven mark stands").toBe(true);
    expect(noteStore.all().find((n) => n.leafIndex === 4)!.spent, "an unproven one is lifted").toBe(false);
  });
});
