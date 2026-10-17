import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { hash2 } from "../src/poseidon";
import { MerkleLayers, MerkleTree, ZERO_LEAF, merkleProof } from "../src/merkle";
import { noteBody, noteCommitment, ownerCommitmentOf, encodeNote, decodeNote } from "../src/note";
import { nullifier, phantomNullifier } from "../src/nullifier";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey } from "../src/keys";
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

describe("merkle layers (one pass for the root and every path)", () => {
  it("gives the accumulator root for every aligned size and paths that fold back to it", () => {
    for (const n of [0, 4, 8, 12, 20, 64, 100]) {
      const leaves = Array.from({ length: n }, (_, i) => BigInt(1000 + i));
      const t = new MerkleTree(10);
      for (let i = 0; i < n; i += 4) t.insertGroup(leaves.slice(i, i + 4));
      const l = MerkleLayers.build(leaves, 10);
      expect(l.root).toBe(t.root);
      expect(l.layers.length).toBe(11);
      for (const i of [0, 1, n - 1, Math.floor(n / 2)].filter((i) => i >= 0 && i < n)) {
        const p = l.proof(i);
        expect(p).toEqual(merkleProof(leaves, i, 10));
        let cur = leaves[i];
        p.pathElements.forEach((sib, k) => (cur = p.pathIndices[k] ? hash2(sib, cur) : hash2(cur, sib)));
        expect(cur).toBe(t.root);
      }
    }
    expect(() => MerkleLayers.build([1n], 10).proof(1)).toThrow(/out of range/);
  });
  it("accepts layers computed elsewhere only when their shape fits the leaves", () => {
    const leaves = [c0, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF, 7n, 8n, 9n, ZERO_LEAF];
    const built = MerkleLayers.build(leaves, 10);
    const again = MerkleLayers.fromLayers(leaves, built.layers.slice(1), 10);
    expect(again.root).toBe(built.root);
    expect(again.proof(6)).toEqual(built.proof(6));
    expect(() => MerkleLayers.fromLayers(leaves, built.layers.slice(2), 10)).toThrow(/expected 10 upper layers/);
    expect(() => MerkleLayers.fromLayers(leaves.slice(0, 4), built.layers.slice(1), 10)).toThrow(/layer 1 has 4 nodes, expected 2/);
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

  it("takes the synced layers when the wallet has them and builds the same witness", () => {
    const layers = MerkleLayers.build(t.leaves, 32);
    expect(buildTxInputs({ ...spec, tree: layers })).toEqual(buildTxInputs(spec));
    expect(() => buildTxInputs({ ...spec, tree: MerkleLayers.build(t.leaves, 10) })).toThrow(/do not belong/);
    expect(() => buildTxInputs({ ...spec, tree: MerkleLayers.build([...t.leaves, ...t.leaves], 32) })).toThrow(/do not belong/);
  });

  it("refuses to spend a note under a foreign key or a wrong secret", () => {
    expect(() => buildTxInputs({ ...spec, inputs: [{ ...spend, spendKey: 12345n }, null] })).toThrow(/does not own/);
    expect(() => buildTxInputs({ ...spec, inputs: [{ ...spend, noteSecret: 1n }, null] })).toThrow(/does not open/);
  });

  it("inputs may have different owner keys: a deposited note's own and the spend key (audit c18; no circuit change)", () => {
    const secret5 = deriveNoteSecret(keys.noteKey, 5);
    const key5 = deriveOwnerKey(keys.spendKey, secret5);
    const deposited = { vaultId: VAULT, amount: ONE, ownerCommitment: ownerCommitmentOf(key5), noteSecret: secret5 };
    const main4 = { ...note0, noteSecret: deriveNoteSecret(keys.noteKey, 6) };
    const cmDep = noteCommitment(noteBody(deposited), 0n), cm4 = noteCommitment(noteBody(main4), 4n);
    const t2 = new MerkleTree(32);
    t2.insertLeaf(cmDep);
    t2.insertLeaf(cm4);
    const mixed: TxSpec = {
      leaves: t2.leaves,
      inputs: [{ ...deposited, spendKey: key5, leafIndex: 0 }, { ...main4, spendKey: keys.spendKey, leafIndex: 4 }],
      outputs: [out(2n * ONE), dummyOutput(VAULT, rnd), dummyOutput(VAULT, rnd)],
      withdrawal: null,
      outDataHash: [1n, 2n, 3n],
      txDomain: 99n,
    };
    const i = buildTxInputs(mixed);
    expect(i.inOwnerKey).toEqual([key5.toString(), keys.spendKey.toString()]);
    expect(i.nullifier).toEqual([nullifier(cmDep, key5).toString(), nullifier(cm4, keys.spendKey).toString()]);
    // each input under the other's key is refused
    expect(() => buildTxInputs({ ...mixed, inputs: [{ ...deposited, spendKey: keys.spendKey, leafIndex: 0 }, { ...main4, spendKey: key5, leafIndex: 4 }] })).toThrow(/does not own/);
    // alone, the deposited note's phantom is bound to its own key (PP-P02 holds: that key is secret)
    const single = buildTxInputs({ ...mixed, inputs: [{ ...deposited, spendKey: key5, leafIndex: 0 }, null], outputs: [out(ONE), dummyOutput(VAULT, rnd), dummyOutput(VAULT, rnd)] });
    expect(single.nullifier).toEqual([nullifier(cmDep, key5).toString(), phantomNullifier(nullifier(cmDep, key5), 1, key5).toString()]);
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
