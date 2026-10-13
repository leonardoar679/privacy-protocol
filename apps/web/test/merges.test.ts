// Multi-note merges (src/sdk/privateTx.ts): the 2-input circuit spends at most two notes, so a spend
// that needs more first merges pairs with private self-transfers, each paying the relayer fee. The
// schedule accounts for those fees; a merge plan is a valid 2-in/3-out witness whose merged note is
// ours and whose fee note is the relayer's. Pure: no network, no worker.
import { describe, it, expect, beforeEach } from "vitest";
import { utf8ToBytes } from "@noble/hashes/utils";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { decryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import { mergeSchedule, placeholderNoteData, planMerge } from "../src/sdk/privateTx";

const seed = utf8ToBytes("frontend-merge-test-seed");
const keys = deriveKeys(seed);
const oc = ownerCommitmentOf(keys.spendKey);
const VAULT = BigInt("0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469");
const DOMAIN = txDomain(31337n, 0xc0ffeen);
const E = 10n ** 18n;
const hexToBytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));

describe("merge schedule (fees included)", () => {
  const notes = [0, 1, 2, 3].map((i) => ({ id: `n${i}`, amount: (3n * E) / 10n }));
  it("needs two merges to cover 1.0 from four 0.3 notes at a 0.002 fee, and names the pairs largest-first", () => {
    const fee = (2n * E) / 1000n;
    const s = mergeSchedule(notes, E + fee, fee);
    expect(s.ok).toBe(true);
    expect(s.pairs.length).toBe(2);
    expect(s.pairs[0]).toEqual(["n0", "n1"]);
    expect(s.pairs[1][0]).toBe("n0+n1"); // the merged note carries on
  });
  it("no merge when two notes already cover the amount", () => {
    expect(mergeSchedule(notes, (5n * E) / 10n, 0n)).toEqual({ pairs: [], ok: true });
  });
  it("fails honestly when fees eat the balance", () => {
    const fee = (3n * E) / 10n; // a fee the size of a note
    expect(mergeSchedule(notes, E, fee).ok).toBe(false);
    expect(mergeSchedule(notes, 2n * E, 0n).ok).toBe(false); // more than the whole balance
  });
});

describe("merge plan", () => {
  beforeEach(() => noteStore.markSpent(noteStore.all().map((n) => n.leafIndex)));
  it("spends two of our notes into one merged note (minus the fee note) that the reference witness builder accepts", () => {
    const relayer = deriveKeys(utf8ToBytes("merge relayer"));
    const relayerView = viewKeyPair(relayer.viewKey);
    const fee = { ownerCommitment: ownerCommitmentOf(relayer.spendKey), viewPub: relayerView.publicKey, amount: (2n * E) / 1000n };
    const n1: Note = { vaultId: VAULT, amount: (3n * E) / 10n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 11) };
    const n2: Note = { vaultId: VAULT, amount: (3n * E) / 10n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 12) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(n1), 0n));
    tree.insertGroup([noteCommitment(noteBody(n2), 4n), ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
    const a: OwnedNote = { note: n1, leafIndex: 0, noteData: placeholderNoteData(), spent: false };
    const b: OwnedNote = { note: n2, leafIndex: 4, noteData: placeholderNoteData(), spent: false };
    noteStore.add(a); noteStore.add(b);
    const plan = planMerge(seed, tree.leaves, VAULT, a, b, DOMAIN, fee);
    expect(plan.merged.note.amount).toBe((6n * E) / 10n - fee.amount);
    expect(plan.merged.note.ownerCommitment).toBe(oc);
    expect(plan.spec.withdrawal).toBeNull();
    expect(plan.spec.inputs[1]).not.toBeNull();
    expect(plan.fee?.outputIndex).toBe(1);
    expect(decryptNoteData(viewKeyPair(keys.viewKey), hexToBytes(plan.noteData[0]))?.amount).toBe(plan.merged.note.amount); // we can rediscover the merged note
    expect(decryptNoteData(relayerView, hexToBytes(plan.noteData[1]))?.amount).toBe(fee.amount); // the relayer its fee
    const inputs = buildTxInputs(plan.spec);
    expect(inputs.mode).toBe("0");
    expect((inputs.outAmount as string[]).map(BigInt)).toEqual([plan.merged.note.amount, fee.amount, 0n]);
    expect((inputs.inIsReal as string[])).toEqual(["1", "1"]);
    expect(() => planMerge(seed, tree.leaves, VAULT, a, b, DOMAIN, { ...fee, amount: E })).toThrow(/do not even cover/);
  });
});
