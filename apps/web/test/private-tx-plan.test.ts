// Withdrawal planning (packages/sdk/src/privateTx.ts): from the session note store and the synced leaves,
// pick ≤ 2 notes, keep the change as a new note of ours, pad with dummies, bind the payload hashes
// and the tx domain — and produce a witness the reference builder accepts (every note opens its
// leaf, value conserved). Pure: no network, no worker.
import { describe, it, expect, beforeEach } from "vitest";
import { utf8ToBytes } from "@noble/hashes/utils";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { decryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { NOTE_DATA_BYTES, noteDataHash, txDomain } from "@privacy-wallet/protocol/payload";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { placeholderNoteData, planWithdrawal } from "@privacy-wallet/sdk/privateTx";
import { olderNotes } from "@privacy-wallet/sdk/wallet/privacyTiming";

const seed = utf8ToBytes("frontend-plan-test-seed");
const keys = deriveKeys(seed);
const oc = ownerCommitmentOf(keys.spendKey);
const VAULT = BigInt("0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469");
const DOMAIN = txDomain(31337n, 0xc0ffeen);
const hexToBytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));

function freshStore() {
  // the store is a session singleton: spend everything it still holds so each test starts clean
  noteStore.markSpent(noteStore.all().map((n) => n.leafIndex));
}

describe("placeholder payloads", () => {
  it("have the spec §12 size and version byte and are unique", () => {
    const a = placeholderNoteData(), b = placeholderNoteData();
    expect(hexToBytes(a).length).toBe(NOTE_DATA_BYTES);
    expect(hexToBytes(a)[0]).toBe(0x01);
    expect(a).not.toBe(b);
    expect(noteDataHash(hexToBytes(a))).not.toBe(noteDataHash(hexToBytes(b)));
  });
});

describe("withdrawal planning", () => {
  beforeEach(freshStore);

  it("'Delay for more privacy' (spec v2.0 §14.1): given the older notes only, the plan spends the older note, not the younger smallest one", () => {
    const old: Note = { vaultId: VAULT, amount: 2n * 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 10) };
    const young: Note = { vaultId: VAULT, amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 11) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(old), 0n));
    tree.insertLeaf(noteCommitment(noteBody(young), 1n));
    noteStore.add({ note: old, leafIndex: 0, noteData: placeholderNoteData(), spent: false, addedAt: Date.now() - 3 * 86400_000 });
    noteStore.add({ note: young, leafIndex: 1, noteData: placeholderNoteData(), spent: false, addedAt: Date.now() });
    const half = 5n * 10n ** 17n;
    expect(planWithdrawal(seed, tree.leaves, VAULT, half, 0xb0bn, DOMAIN).spent.map((n) => n.leafIndex), "by default: the smallest sufficient note").toEqual([1]);
    const plan = planWithdrawal(seed, tree.leaves, VAULT, half, 0xb0bn, DOMAIN, undefined, olderNotes(VAULT, 0));
    expect(plan.spent.map((n) => n.leafIndex)).toEqual([0]);
    expect(plan.change?.note.amount).toBe(15n * 10n ** 17n);
    expect(BigInt(buildTxInputs(plan.spec).root as string)).toBe(tree.root);
  });

  it("one note covers it: withdrawal + change note to us + two dummies; the witness builds against the synced leaves", () => {
    const note: Note = { vaultId: VAULT, amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(note), 0n));
    noteStore.add({ note, leafIndex: 0, noteData: placeholderNoteData(), spent: false, label: "shield" });
    const plan = planWithdrawal(seed, tree.leaves, VAULT, 4n * 10n ** 17n, 0xb0bn, DOMAIN);
    expect(plan.spent.map((n) => n.leafIndex)).toEqual([0]);
    expect(plan.spec.withdrawal).toEqual({ vault: VAULT, amount: 4n * 10n ** 17n, recipient: 0xb0bn });
    expect(plan.change?.note.amount).toBe(6n * 10n ** 17n);
    expect(plan.change?.note.ownerCommitment).toBe(oc);
    expect(plan.spec.outputs[0]).toBe(plan.change!.note);
    expect(plan.spec.outputs[1].amount).toBe(0n);
    expect(plan.spec.outputs[2].amount).toBe(0n);
    expect(plan.spec.outputs[1].ownerCommitment).not.toBe(oc); // dummies belong to nobody
    expect(plan.spec.outDataHash[0]).toBe(noteDataHash(hexToBytes(plan.noteData[0])));
    expect(plan.spec.txDomain).toBe(DOMAIN);
    const inputs = buildTxInputs(plan.spec); // throws if the note does not open leaf 0 or value is not conserved
    expect(BigInt(inputs.root as string)).toBe(tree.root);
    expect(inputs.mode).toBe("1");
    expect((inputs.inIsReal as string[])).toEqual(["1", "0"]);
  });

  it("two notes when one is not enough; no change when exact; refuses what the balance cannot cover", () => {
    const n1: Note = { vaultId: VAULT, amount: 5n * 10n ** 17n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 1) };
    const n2: Note = { vaultId: VAULT, amount: 7n * 10n ** 17n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 2) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(n1), 0n));
    tree.insertGroup([noteCommitment(noteBody(n2), 4n), ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
    noteStore.add({ note: n1, leafIndex: 0, noteData: placeholderNoteData(), spent: false });
    noteStore.add({ note: n2, leafIndex: 4, noteData: placeholderNoteData(), spent: false });
    const plan = planWithdrawal(seed, tree.leaves, VAULT, 12n * 10n ** 17n, 0xb0bn, DOMAIN);
    expect(plan.spent.map((n) => n.leafIndex).sort()).toEqual([0, 4]);
    expect(plan.change).toBeUndefined(); // exact: nothing to keep
    expect(plan.spec.inputs[1]).not.toBeNull();
    const inputs = buildTxInputs(plan.spec);
    expect((inputs.inIsReal as string[])).toEqual(["1", "1"]);
    expect((inputs.nullifier as string[])[0]).not.toBe((inputs.nullifier as string[])[1]);
    expect(() => planWithdrawal(seed, tree.leaves, VAULT, 13n * 10n ** 17n, 0xb0bn, DOMAIN)).toThrow(/insufficient shielded balance/);
  });

  it("a note the store misreports (wrong leaf) is caught by the witness builder, never proved", () => {
    const note: Note = { vaultId: VAULT, amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 3) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(note), 0n));
    noteStore.add({ note, leafIndex: 1, noteData: placeholderNoteData(), spent: false }); // wrong index
    const plan = planWithdrawal(seed, tree.leaves, VAULT, 10n ** 17n, 0xb0bn, DOMAIN);
    expect(() => buildTxInputs(plan.spec)).toThrow(/does not open leaf/);
  });
});

describe("withdrawal planning with a relayer fee note (private submission)", () => {
  beforeEach(freshStore);
  it("adds the relayer's fee note as output 1, encrypted to the relayer, and keeps value conserved", () => {
    const relayer = deriveKeys(utf8ToBytes("some relayer seed"));
    const relayerView = viewKeyPair(relayer.viewKey);
    const fee = { ownerCommitment: ownerCommitmentOf(relayer.spendKey), viewPub: relayerView.publicKey, amount: 2n * 10n ** 15n };
    const note: Note = { vaultId: VAULT, amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 9) };
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(note), 0n));
    noteStore.add({ note, leafIndex: 0, noteData: placeholderNoteData(), spent: false });
    const plan = planWithdrawal(seed, tree.leaves, VAULT, 4n * 10n ** 17n, 0xb0bn, DOMAIN, fee);
    expect(plan.fee?.outputIndex).toBe(1);
    expect(plan.fee?.note.amount).toBe(fee.amount);
    expect(plan.fee?.note.ownerCommitment).toBe(fee.ownerCommitment);
    expect(plan.change?.note.amount).toBe(10n ** 18n - 4n * 10n ** 17n - fee.amount);
    expect(plan.spec.outputs[1]).toBe(plan.fee!.note);
    // the relayer can open its fee payload and verify the opening it is given
    const opened = decryptNoteData(relayerView, hexToBytes(plan.noteData[1]));
    expect(opened).toEqual({ amount: fee.amount, noteSecret: plan.fee!.note.noteSecret, vaultId: VAULT });
    expect(decryptNoteData(viewKeyPair(keys.viewKey), hexToBytes(plan.noteData[1]))).toBeNull(); // not ours
    expect(noteBody({ vaultId: VAULT, amount: fee.amount, ownerCommitment: fee.ownerCommitment, noteSecret: plan.fee!.note.noteSecret })).toBe(noteBody(plan.spec.outputs[1]));
    const inputs = buildTxInputs(plan.spec); // value conserved incl. the fee, every note opens its leaf
    expect(BigInt(inputs.root as string)).toBe(tree.root);
    expect((inputs.outAmount as string[]).map(BigInt)).toEqual([plan.change!.note.amount, fee.amount, 0n]);
    // without enough for amount + fee the plan is refused
    expect(() => planWithdrawal(seed, tree.leaves, VAULT, 10n ** 18n - fee.amount + 1n, 0xb0bn, DOMAIN, fee)).toThrow(/insufficient shielded balance/);
  });
});
