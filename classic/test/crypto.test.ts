// The Classic cryptography against its vectors (spec v3.0 §7.3; V7 Stage 6): the note's commitment and nullifier hash
// (vectors/notes.json, cross-checked against circomlibjs 0.1.2), the empty leaf and the twenty empty subtrees the
// deployed pools hold (vectors/zeros.json), the contract's hashLeftRight, the Merkle tree and its paths, the recorded
// root of a real pool history (vectors/roots.json).
import { keccak256 } from "js-sha3";
import { describe, expect, it } from "vitest";
import { commitmentOf, FIELD_SIZE, hashLeftRight, nullifierHashOf, pedersenX, toHex32, ZERO_VALUE } from "../src/crypto/hashes";
import { LEVELS, MerkleTree, rootOfPath, zeros } from "../src/crypto/tree";
import { leBigInt, parseNote } from "../src/model/notes";
import notes from "../vectors/notes.json";
import roots from "../vectors/roots.json";
import zerosVector from "../vectors/zeros.json";

const hexBytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!, (x) => parseInt(x, 16));

describe("the note's derivations", () => {
  it("ZERO_VALUE is keccak256('tornado') mod p", () => {
    expect(ZERO_VALUE).toBe(BigInt("0x" + keccak256("tornado")) % FIELD_SIZE);
    expect(ZERO_VALUE).toBe(21663839004416932945382355908790599225266501822907911457504978515578255421292n);
  });

  for (const v of notes.notes) {
    it(`note seeded ${v.seed}: commitment = Pedersen(nullifier ‖ secret).x, nullifierHash = Pedersen(nullifier).x`, () => {
      const parsed = parseNote(v.note);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.note.currency).toBe("eth");
      expect(parsed.note.amount).toBe("1");
      expect(parsed.note.netId).toBe(1);
      expect(toHex32(leBigInt(parsed.note.nullifier))).toBe(toHex32(leBigInt(hexBytes(v.nullifier))));
      expect(toHex32(commitmentOf(parsed.note))).toBe(v.commitment);
      expect(toHex32(nullifierHashOf(parsed.note))).toBe(v.nullifierHash);
      // the same bytes through the raw hash
      expect(toHex32(pedersenX(new Uint8Array([...hexBytes(v.nullifier), ...hexBytes(v.secret)])))).toBe(v.commitment);
    });
  }

  it("a commitment and a nullifier hash are field elements, and differ between notes", () => {
    const cs = notes.notes.map((v) => BigInt(v.commitment));
    for (const c of cs) expect(c < FIELD_SIZE).toBe(true);
    expect(new Set(cs).size).toBe(cs.length);
  });
});

describe("the tree hash", () => {
  it("hashLeftRight on the vector (MiMCSponge(left, 0) then + right then MiMCSponge again)", () => {
    expect(toHex32(hashLeftRight(BigInt(notes.mimc.left), BigInt(notes.mimc.right)))).toBe(notes.mimc.hashLeftRight);
    expect(hashLeftRight(1n, 2n)).not.toBe(hashLeftRight(2n, 1n));
  });

  it("the twenty empty subtrees are the deployed pools' zeros(i)", () => {
    const z = zeros();
    expect(z.length).toBe(LEVELS + 1);
    expect(z[0]).toBe(ZERO_VALUE);
    for (let i = 0; i < 20; i++) expect(toHex32(z[i]), `zeros(${i})`).toBe(zerosVector.zeros[i]);
    expect(zerosVector.zeros.length).toBe(20);
  });

  it("refuses a value outside the field", () => {
    expect(() => hashLeftRight(FIELD_SIZE, 0n)).toThrow(/inside the field/);
  });
});

describe("the Merkle tree", () => {
  const leaves = notes.tree.leaves.map((l) => BigInt(l));

  it("the three-leaf tree's root and the second leaf's path are the vector's", () => {
    const tree = new MerkleTree(leaves);
    expect(tree.size).toBe(3);
    expect(toHex32(tree.root)).toBe(notes.tree.root);
    const path = tree.path(1);
    expect(path.pathElements.map(toHex32)).toEqual(notes.tree.path.pathElements);
    expect(path.pathIndices).toEqual(notes.tree.path.pathIndices);
    expect(rootOfPath(leaves[1], path)).toBe(tree.root);
    expect(rootOfPath(leaves[0], path)).not.toBe(tree.root);
  });

  it("an empty tree's root is zeros(20); one leaf changes it; the bulk build equals the incremental one", () => {
    const empty = new MerkleTree();
    expect(empty.root).toBe(zeros()[LEVELS]);
    const bulk = MerkleTree.fromLeaves(leaves);
    expect(bulk.root).toBe(new MerkleTree(leaves).root);
    expect(bulk.path(2)).toEqual(new MerkleTree(leaves).path(2));
    const more = MerkleTree.fromLeaves([...leaves, 5n, 6n, 7n, 8n, 9n]);
    const incremental = new MerkleTree(leaves);
    for (const l of [5n, 6n, 7n, 8n, 9n]) incremental.insert(l);
    expect(more.root).toBe(incremental.root);
    expect(more.path(6)).toEqual(incremental.path(6));
    expect(more.leaves()).toEqual(incremental.leaves());
  });

  it("finds a leaf, refuses a path off the end and a leaf outside the field", () => {
    const tree = new MerkleTree(leaves);
    expect(tree.indexOf(leaves[2])).toBe(2);
    expect(tree.indexOf(123n)).toBe(-1);
    expect(tree.leaf(1)).toBe(leaves[1]);
    expect(() => tree.path(3)).toThrow(/no leaf at 3/);
    expect(() => tree.insert(FIELD_SIZE)).toThrow(/inside the field/);
    expect(() => MerkleTree.fromLeaves([FIELD_SIZE + 1n])).toThrow(/inside the field/);
  });

  it("every path element at level i of a sparse tree is the sibling or zeros(i)", () => {
    const tree = new MerkleTree(leaves);
    const path = tree.path(2);
    expect(path.pathElements[0]).toBe(zeros()[0]); // leaf 3 is empty
    expect(path.pathIndices[0]).toBe(0);
    expect(path.pathElements[1]).toBe(hashLeftRight(leaves[0], leaves[1]));
    for (let i = 2; i < LEVELS; i++) expect(path.pathElements[i]).toBe(zeros()[i]);
  });
});

describe("the recorded root of a real history", () => {
  it("the 100 ETH pool's cache root is recorded with its on-chain verification (Stage 7 syncs against it)", () => {
    const r = roots["eth-100"];
    expect(r.pool).toBe("0xa160cdab225685da1d56aa342ad8841c3b53f291");
    expect(r.leaves).toBe(27544);
    expect(r.lastLeafIndex).toBe(27543);
    expect(r.toBlock).toBe(14954101);
    expect(r.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(r.root) < FIELD_SIZE).toBe(true);
    expect(r.verified.endpoints.length).toBeGreaterThanOrEqual(2);
  });
});
