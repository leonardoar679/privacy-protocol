// The pool's Merkle tree as the deposits build it (spec v3.0 §7.4; MerkleTreeWithHistory, fixed-merkle-tree's
// semantics): 20 levels, the empty leaf ZERO_VALUE, each empty subtree the hash of two empty subtrees below it (the
// pools' own `zeros(i)`), leaves appended in deposit order, the path of a leaf as the circuit wants it — the sibling at
// every level and the side the leaf is on. Sparse: only the nodes the leaves touch are kept, so a path costs 20 hashes
// of the way up and a tree of n leaves about 2n hashes. Stage 7 feeds it the verified history and persists its layers.
// explicit .ts extensions on this chain: Node runs these modules directly for the snapshot generator (type stripping)
import { FIELD_SIZE, hashLeftRight, ZERO_VALUE } from "./hashes.ts";

export const LEVELS = 20;

let zerosCache: bigint[] | null = null;
/** zeros[i]: the root of an empty subtree of height i (zeros[0] = ZERO_VALUE). */
export function zeros(): readonly bigint[] {
  if (!zerosCache) {
    const z = [ZERO_VALUE];
    for (let i = 1; i <= LEVELS; i++) z[i] = hashLeftRight(z[i - 1], z[i - 1]);
    zerosCache = z;
  }
  return zerosCache;
}

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

export class MerkleTree {
  /** layers[level]: index → node; layers[0] holds the leaves */
  private readonly layers: Map<number, bigint>[] = Array.from({ length: LEVELS + 1 }, () => new Map());
  private count = 0;

  constructor(leaves: readonly bigint[] = []) {
    for (const leaf of leaves) this.insert(leaf);
  }

  /** The tree of a whole history at once: layer by layer, about 2n hashes instead of 20n (what a sync builds). */
  static fromLeaves(leaves: readonly bigint[]): MerkleTree {
    if (leaves.length > 2 ** LEVELS) throw new Error("the tree is full");
    const tree = new MerkleTree();
    leaves.forEach((leaf, i) => {
      if (leaf >= FIELD_SIZE) throw new Error("a leaf must be inside the field");
      tree.layers[0].set(i, leaf);
    });
    tree.count = leaves.length;
    let width = leaves.length;
    for (let level = 0; level < LEVELS && width > 0; level++) {
      const next = Math.ceil(width / 2);
      for (let i = 0; i < next; i++) tree.layers[level + 1].set(i, hashLeftRight(tree.node(level, 2 * i), tree.node(level, 2 * i + 1)));
      width = next;
    }
    return tree;
  }

  /** The tree from persisted layers (level 0 the leaves, each level as wide as its nodes): no hashing. */
  static fromLayers(layers: readonly (readonly bigint[])[]): MerkleTree {
    if (layers.length !== LEVELS + 1) throw new Error(`a tree has ${LEVELS + 1} layers`);
    const tree = new MerkleTree();
    tree.count = layers[0].length;
    if (tree.count > 2 ** LEVELS) throw new Error("the tree is full");
    for (let level = 0; level <= LEVELS; level++) {
      const expected = level === 0 ? tree.count : Math.ceil(layers[level - 1].length / 2);
      if (layers[level].length !== expected) throw new Error(`layer ${level} has ${layers[level].length} nodes, not ${expected}`);
      layers[level].forEach((node, i) => {
        if (node >= FIELD_SIZE) throw new Error("a node must be inside the field");
        tree.layers[level].set(i, node);
      });
    }
    return tree;
  }

  /** The layers as dense arrays (what a snapshot persists): level 0 the leaves, each level as wide as its nodes. */
  toLayers(): bigint[][] {
    const out: bigint[][] = [];
    let width = this.count;
    for (let level = 0; level <= LEVELS; level++) {
      out.push(Array.from({ length: width }, (_, i) => this.node(level, i)));
      width = Math.ceil(width / 2);
    }
    return out;
  }

  get size(): number {
    return this.count;
  }

  /** Appends the next leaf (the pool's nextIndex) and rehashes its way up. */
  insert(leaf: bigint): number {
    if (leaf >= FIELD_SIZE) throw new Error("a leaf must be inside the field");
    if (this.count >= 2 ** LEVELS) throw new Error("the tree is full");
    const index = this.count++;
    this.layers[0].set(index, leaf);
    let i = index;
    for (let level = 0; level < LEVELS; level++) {
      const parent = i >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.layers[level + 1].set(parent, hashLeftRight(left, right));
      i = parent;
    }
    return index;
  }

  node(level: number, index: number): bigint {
    return this.layers[level].get(index) ?? zeros()[level];
  }

  get root(): bigint {
    return this.node(LEVELS, 0);
  }

  leaf(index: number): bigint | undefined {
    return this.layers[0].get(index);
  }

  /** The index of a leaf, or -1. */
  indexOf(leaf: bigint): number {
    for (const [i, l] of this.layers[0]) if (l === leaf) return i;
    return -1;
  }

  /** The sibling at every level and the side the leaf is on (0 left, 1 right), leaf level first. */
  path(index: number): MerklePath {
    if (index < 0 || index >= this.count) throw new Error(`no leaf at ${index}`);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let i = index;
    for (let level = 0; level < LEVELS; level++) {
      pathIndices.push(i & 1);
      pathElements.push(this.node(level, i ^ 1));
      i >>= 1;
    }
    return { pathElements, pathIndices };
  }

  /** The leaves in order (what a snapshot persists). */
  leaves(): bigint[] {
    return Array.from({ length: this.count }, (_, i) => this.layers[0].get(i)!);
  }
}

/** The root a path proves for a leaf: what the circuit's MerkleTreeChecker recomputes. */
export function rootOfPath(leaf: bigint, path: MerklePath): bigint {
  let node = leaf;
  for (let level = 0; level < LEVELS; level++) {
    const sibling = path.pathElements[level];
    node = path.pathIndices[level] === 0 ? hashLeftRight(node, sibling) : hashLeftRight(sibling, node);
  }
  return node;
}
