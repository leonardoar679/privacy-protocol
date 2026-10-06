import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { hash2 } from "../src/poseidon";
import { MerkleTree, ZERO_LEAF, merkleProof } from "../src/merkle";
import { noteBody, noteCommitment, ownerCommitmentOf, encodeNote, decodeNote } from "../src/note";
import { nullifier, phantomNullifier } from "../src/nullifier";
import { deriveKeys, deriveNoteSecret } from "../src/keys";
import { noteDataHash, testNoteData, txDomain, NOTE_DATA_BYTES } from "../src/payload";
import { buildTxInputs, dummyOutput, type SpendNote, type TxSpec } from "../src/txInputs";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../circuits/vectors/primitives.json", import.meta.url)), "utf8"),
);
const v = (s: string) => BigInt(s);
const keys = deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed"));
const oc = ownerCommitmentOf(keys.spendKey);
const VAULT = 0xabn;
const ONE = 10n ** 18n;
const note0 = { vaultId: VAULT, amount: ONE, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const c0 = noteCommitment(noteBody(note0), 0n);

describe("primitives == primitives.json", () => {
  it("keys, owner commitment, note, nullifier, phantom", () => {
    expect(keys.spendKey).toBe(v(vectors.keys.spendKey));
    expect(oc).toBe(v(vectors.sampleNote.ownerCommitment));
    expect(note0.noteSecret).toBe(v(vectors.sampleNote.noteSecret));
    expect(noteBody(note0)).toBe(v(vectors.sampleNote.body));
    expect(c0).toBe(v(vectors.sampleNote.commitment));
    const nf = nullifier(c0, keys.spendKey);
    expect(nf).toBe(v(vectors.sampleNote.nullifier));
    expect(phantomNullifier(nf, 1, keys.spendKey)).toBe(v(vectors.sampleNote.phantom));
  });
  it("payload binding and txDomain", () => {
    const nd = testNoteData(7n);
    expect(nd.length).toBe(NOTE_DATA_BYTES);
    expect(noteDataHash(nd)).toBe(v(vectors.noteDataExample.hash));
    expect(txDomain(31337n, 0xcafen)).toBe(v(vectors.txDomainExample.txDomain));
  });
});

describe("merkle accumulator (4-aligned groups)", () => {
  it("reproduces the vector roots and agrees with merkleProof", () => {
    const t = new MerkleTree(10);
    expect(t.root).toBe(v(vectors.tree.emptyRoot));
    t.insertLeaf(c0);
    expect(t.root).toBe(v(vectors.tree.rootAfterDeposit));
    expect(merkleProof(t.leaves, 0, 10).root).toBe(t.root);
    const outs = vectors.tree.outputs.map(v);
    t.insertGroup([outs[0], outs[1], outs[2], ZERO_LEAF]);
    expect(t.root).toBe(v(vectors.tree.rootAfterTx));
    expect(t.nextIndex).toBe(8);
    expect(merkleProof(t.leaves, 5, 10).root).toBe(t.root);
  });
  it("paths fold back to the root", () => {
    const leaves = [c0, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF, 7n, 8n, 9n, ZERO_LEAF];
    const { root, pathElements, pathIndices } = merkleProof(leaves, 6, 10);
    let cur = 9n;
    pathElements.forEach((sib, i) => (cur = pathIndices[i] ? hash2(sib, cur) : hash2(cur, sib)));
    expect(cur).toBe(root);
  });
});

describe("note record encoding", () => {
  it("round-trips the 121-byte record", () => {
    const b = encodeNote(note0, 42);
    expect(b.length).toBe(121);
    const d = decodeNote(b);
    expect(d.leafIndex).toBe(42);
    expect(d.note).toEqual(note0);
  });
});

describe("buildTxInputs", () => {
  const t = new MerkleTree(32);
  t.insertLeaf(c0);
  const spend: SpendNote = { ...note0, spendKey: keys.spendKey, leafIndex: 0 };
  const rnd = (() => { let i = 100; return () => deriveNoteSecret(keys.noteKey, i++); })();
  const out = (amount: bigint) => ({ vaultId: VAULT, amount, ownerCommitment: oc, noteSecret: rnd() });
  const spec: TxSpec = {
    leaves: t.leaves,
    inputs: [spend, null],
    outputs: [out(6n * 10n ** 17n), out(4n * 10n ** 17n), dummyOutput(VAULT, rnd)],
    withdrawal: null,
    outDataHash: [1n, 2n, 3n],
    txDomain: 99n,
  };

  it("emits the real nullifier for slot 0 and a key-bound phantom for slot 1", () => {
    const i = buildTxInputs(spec);
    const nf0 = nullifier(c0, keys.spendKey);
    expect(i.nullifier).toEqual([nf0.toString(), phantomNullifier(nf0, 1, keys.spendKey).toString()]);
    expect(i.inIsReal).toEqual(["1", "0"]);
    expect(i.inOwnerKey).toEqual([keys.spendKey.toString(), "0"]);
    expect((i.inPathElements as string[][])[0].length).toBe(32);
  });

  it("refuses to spend a note under a foreign key or a wrong secret", () => {
    expect(() => buildTxInputs({ ...spec, inputs: [{ ...spend, spendKey: 12345n }, null] })).toThrow(/does not own/);
    expect(() => buildTxInputs({ ...spec, inputs: [{ ...spend, noteSecret: 1n }, null] })).toThrow(/does not open/);
  });

  it("refuses value or asset violations", () => {
    expect(() => buildTxInputs({ ...spec, outputs: [out(6n * 10n ** 17n), out(5n * 10n ** 17n), dummyOutput(VAULT, rnd)] })).toThrow(/not conserved/);
    expect(() => buildTxInputs({ ...spec, outputs: [{ ...out(ONE), vaultId: 0xcdn }, dummyOutput(VAULT, rnd), dummyOutput(VAULT, rnd)] })).toThrow(/asset/);
  });

  it("dummy outputs are unique (PP-P01)", () => {
    const a = noteBody(dummyOutput(VAULT, rnd));
    const b = noteBody(dummyOutput(VAULT, rnd));
    expect(a).not.toBe(b);
  });
});
