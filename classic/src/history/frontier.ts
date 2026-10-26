// The pool's frontier (spec v3.0 §7.4): `filledSubtrees` plus the last leaf hash to `getLastRoot()` exactly as the
// contract's `_insert` does — the live proof, needing no history, that the tree hash and the insertion semantics are
// the chain's. Loads the vendored arithmetic: the worker's and the tests' module, never the main thread's.
import { FIELD_SIZE, hashLeftRight } from "../crypto/hashes.ts";
import { LEVELS, MerkleTree, zeros } from "../crypto/tree.ts";

/**
 * The root after inserting `leaf` at `index`, from the frontier as the contract holds it right after that insertion:
 * MerkleTreeWithHistory._insert walks up — at a level where the index bit is 0 the new node is the left child and the
 * right is the empty subtree; where it is 1 the left child is filledSubtrees[level] (unchanged by this insertion).
 */
export function rootFromFrontier(filledSubtrees: readonly bigint[], index: number, leaf: bigint): bigint {
  if (filledSubtrees.length !== LEVELS) throw new Error(`${LEVELS} subtrees`);
  if (leaf >= FIELD_SIZE) throw new Error("a leaf must be inside the field");
  let current = leaf;
  for (let level = 0; level < LEVELS; level++) {
    current = (index >> level) & 1 ? hashLeftRight(filledSubtrees[level], current) : hashLeftRight(current, zeros()[level]);
  }
  return current;
}

/** The frontier a full tree implies after its last insertion (what the chain's filledSubtrees hold). */
export function frontierOf(tree: MerkleTree): bigint[] {
  if (tree.size === 0) return zeros().slice(0, LEVELS);
  const k = tree.size - 1;
  return Array.from({ length: LEVELS }, (_, level) => ((k >> level) & 1 ? tree.node(level, (k >> level) - 1) : tree.node(level, k >> level)));
}
