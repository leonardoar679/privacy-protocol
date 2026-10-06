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

/** Root + authentication path of leaf `index` in the tree holding `leaves` (flat, with padding). */
export function merkleProof(leaves: bigint[], index: number, levels: number) {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);
  const z = zeroHashes(levels);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let layer = leaves.slice();
  let idx = index;
  for (let lvl = 0; lvl < levels; lvl++) {
    const bit = idx % 2;
    const sib = bit ? idx - 1 : idx + 1;
    pathElements.push(sib < layer.length ? layer[sib] : z[lvl]);
    pathIndices.push(bit);
    const next: bigint[] = [];
    for (let k = 0; k < layer.length; k += 2) next.push(hash2(layer[k], k + 1 < layer.length ? layer[k + 1] : z[lvl]));
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return { root: layer[0], pathElements, pathIndices };
}
