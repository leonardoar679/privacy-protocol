// Append-only Merkle accumulator with 4-aligned leaf groups — the off-chain mirror of
// MerkleAccumulator.sol (spec §9). ZERO_LEAF matches the contract's keccak-derived empty-leaf constant.
import { keccak_256 } from "@noble/hashes/sha3";
import { utf8ToBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { bytesToBigInt } from "./domains";
import { hash2 } from "./poseidon";

export const ZERO_LEAF = bytesToBigInt(keccak_256(utf8ToBytes("privacy-protocol/v1/empty-leaf"))) % FIELD;
export const GROUP_SIZE = 4;

export interface TreeSnapshot {
  filled: bigint[];
  nextIndex: number;
  root: bigint;
  leafCount: number;
}

/** z[0] = ZERO_LEAF, z[i+1] = H(z[i], z[i]); z[levels] is the empty-tree root. */
export function zeroHashes(levels: number): bigint[] {
  const z = [ZERO_LEAF];
  for (let i = 0; i < levels; i++) z.push(hash2(z[i], z[i]));
  return z;
}

/** Incremental tree, group insertion only (mirrors _insertGroup). */
export class MerkleTree {
  readonly levels: number;
  private zeros: bigint[];
  private filled: bigint[];
  nextIndex = 0; // always a multiple of GROUP_SIZE
  root: bigint;
  readonly leaves: bigint[] = []; // flat, incl. ZERO_LEAF padding — what merkleProof() consumes

  constructor(levels: number) {
    if (levels < 3 || levels > 32) throw new Error("levels out of range");
    this.levels = levels;
    this.zeros = zeroHashes(levels);
    this.filled = this.zeros.slice(0, levels);
    this.root = this.zeros[levels];
  }

  /** O(levels) checkpoint of the incremental state, for reorg rollback (indexer.ts). */
  snapshot(): TreeSnapshot {
    return { filled: this.filled.slice(), nextIndex: this.nextIndex, root: this.root, leafCount: this.leaves.length };
  }

  restore(s: TreeSnapshot): void {
    this.filled = s.filled.slice();
    this.nextIndex = s.nextIndex;
    this.root = s.root;
    this.leaves.length = s.leafCount;
  }

  /** A deposit: one commitment + three empty leaves. Returns the leaf index. */
  insertLeaf(leaf: bigint): number {
    return this.insertGroup([leaf, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
  }

  /** Append one aligned group; returns the index of its first leaf. */
  insertGroup(group: bigint[]): number {
    if (group.length !== GROUP_SIZE) throw new Error("a group has exactly 4 leaves");
    const first = this.nextIndex;
    if (first + GROUP_SIZE >= 2 ** this.levels) throw new Error("tree full");
    let h = hash2(hash2(group[0], group[1]), hash2(group[2], group[3]));
    let cur = first / GROUP_SIZE;
    for (let i = 2; i < this.levels; i++) {
      if (cur % 2 === 0) {
        this.filled[i] = h;
        h = hash2(h, this.zeros[i]);
      } else {
        h = hash2(this.filled[i], h);
      }
      cur = Math.floor(cur / 2);
    }
    this.root = h;
    this.leaves.push(...group);
    this.nextIndex = first + GROUP_SIZE;
    return first;
  }
}

export interface MerkleProofResult { root: bigint; pathElements: bigint[]; pathIndices: number[] }

/**
 * Every layer of the tree over `leaves` (flat, with padding): layers[0] is the leaves, layers[l+1][i] =
 * H(layers[l][2i], layers[l][2i+1]) with the empty-subtree hash z[l] standing in for a missing right
 * sibling, up to layers[levels] = [root]. About one hash per leaf, once; every authentication path is
 * then a lookup — a sync + proofs cost n hashes instead of ~8n (incremental groups) + 2n per proof.
 * `fromLayers` takes layers computed elsewhere (the Rust core's WASM build does them in one call); the
 * wallet checks the resulting root against the chain before it proves anything.
 */
export class MerkleLayers {
  private constructor(readonly levels: number, readonly layers: bigint[][]) {}

  /** Hash the layers here (TypeScript Poseidon2). */
  static build(leaves: bigint[], levels: number): MerkleLayers {
    if (levels < 3 || levels > 32) throw new Error("levels out of range");
    const z = zeroHashes(levels);
    const layers: bigint[][] = [leaves];
    for (let lvl = 0; lvl < levels; lvl++) {
      const layer = layers[lvl];
      const next: bigint[] = new Array(Math.ceil(layer.length / 2));
      for (let k = 0, i = 0; k < layer.length; k += 2, i++) next[i] = hash2(layer[k], k + 1 < layer.length ? layer[k + 1] : z[lvl]);
      layers.push(next);
    }
    return new MerkleLayers(levels, layers);
  }

  /** Layers 1..levels computed elsewhere; only the shape is checked here (the root is checked against the chain). */
  static fromLayers(leaves: bigint[], upper: bigint[][], levels: number): MerkleLayers {
    if (levels < 3 || levels > 32) throw new Error("levels out of range");
    if (upper.length !== levels) throw new Error(`expected ${levels} upper layers, got ${upper.length}`);
    let size = leaves.length;
    for (let lvl = 0; lvl < levels; lvl++) {
      size = Math.ceil(size / 2);
      if (upper[lvl].length !== size) throw new Error(`layer ${lvl + 1} has ${upper[lvl].length} nodes, expected ${size}`);
    }
    return new MerkleLayers(levels, [leaves, ...upper]);
  }

  get leaves(): bigint[] { return this.layers[0]; }
  get root(): bigint { return this.layers[this.levels][0] ?? zeroHashes(this.levels)[this.levels]; }

  /** Root + authentication path of leaf `index` (a lookup per level). */
  proof(index: number): MerkleProofResult {
    if (index < 0 || index >= this.leaves.length) throw new Error(`leaf index ${index} out of range`);
    const z = zeroHashes(this.levels);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = index;
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const bit = idx % 2;
      const sib = bit ? idx - 1 : idx + 1;
      const layer = this.layers[lvl];
      pathElements.push(sib < layer.length ? layer[sib] : z[lvl]);
      pathIndices.push(bit);
      idx = Math.floor(idx / 2);
    }
    return { root: this.root, pathElements, pathIndices };
  }
}

/** Root + authentication path of leaf `index` in the tree holding `leaves` (flat, with padding). */
export function merkleProof(leaves: bigint[], index: number, levels: number): MerkleProofResult {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
  return MerkleLayers.build(leaves, levels).proof(index);
}
