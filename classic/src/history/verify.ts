// The history held to the chain (spec v3.0 §7.4): one check settles a synced history — the recomputed root is a root the
// pool knows (`getLastRoot()`, or `isKnownRoot` inside its 100-root window) and the leaf count is `nextIndex()`. And a
// cheaper rung that needs no history at all: the pool's own frontier (`filledSubtrees`) plus the last leaf must hash to
// `getLastRoot()` exactly as the contract's `_insert` does — the live proof that the tree hash and the insertion
// semantics are the chain's. Pure over an injected JSON-RPC function.
import { keccak256 } from "js-sha3";
import { FIELD_SIZE, hashLeftRight } from "../crypto/hashes.ts";
import { LEVELS, MerkleTree, zeros } from "../crypto/tree.ts";
import type { Hex } from "./events.ts";
import type { Rpc } from "./sync.ts";

const selector = (signature: string): string => "0x" + keccak256(signature).slice(0, 8);
export const SELECTORS = Object.freeze({
  nextIndex: selector("nextIndex()"),
  getLastRoot: selector("getLastRoot()"),
  isKnownRoot: selector("isKnownRoot(bytes32)"),
  isSpent: selector("isSpent(bytes32)"),
  filledSubtrees: selector("filledSubtrees(uint256)"),
  currentRootIndex: selector("currentRootIndex()"),
});

const word = (x: bigint | number): string => BigInt(x).toString(16).padStart(64, "0");
const toHex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;

export async function call(rpc: Rpc, to: Hex, data: string, block: string = "latest"): Promise<string> {
  const out = (await rpc("eth_call", [{ to, data }, block])) as string;
  if (typeof out !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new Error("eth_call answered no bytes");
  return out;
}
export const wordOf = (out: string): bigint => {
  if (out.length !== 66) throw new Error(`the call answered ${(out.length - 2) / 2} bytes, not a word`);
  return BigInt(out);
};

export interface ChainVerification {
  ok: boolean;
  root: Hex;
  leaves: number;
  nextIndex: number;
  lastRoot: Hex;
  /** the root is inside the pool's window of the last 100 */
  known: boolean;
  reason?: "leaf count" | "root unknown";
}

/** The synced tree against the pool at `block` (latest by default): leaves == nextIndex and the root known. */
export async function verifyAgainstChain(rpc: Rpc, address: Hex, tree: { root: bigint; size: number }, block: string = "latest"): Promise<ChainVerification> {
  const root = toHex32(tree.root);
  const [nextIndex, lastRoot, known] = await Promise.all([
    call(rpc, address, SELECTORS.nextIndex, block).then((o) => Number(wordOf(o))),
    call(rpc, address, SELECTORS.getLastRoot, block).then((o) => toHex32(wordOf(o))),
    call(rpc, address, SELECTORS.isKnownRoot + word(tree.root), block).then((o) => wordOf(o) === 1n),
  ]);
  const rootOk = known || lastRoot === root;
  const countOk = nextIndex === tree.size;
  return {
    ok: rootOk && countOk,
    root,
    leaves: tree.size,
    nextIndex,
    lastRoot,
    known,
    ...(countOk ? (rootOk ? {} : { reason: "root unknown" as const }) : { reason: "leaf count" as const }),
  };
}

export interface Frontier {
  /** filledSubtrees[0..19]: the left child kept at each level for the next insertion */
  filledSubtrees: bigint[];
  nextIndex: number;
  lastRoot: Hex;
}

/** The pool's frontier at `block` (latest by default): 22 calls. */
export async function readFrontier(rpc: Rpc, address: Hex, block: string = "latest"): Promise<Frontier> {
  const [subtrees, nextIndex, lastRoot] = await Promise.all([
    Promise.all(Array.from({ length: LEVELS }, (_, i) => call(rpc, address, SELECTORS.filledSubtrees + word(i), block).then(wordOf))),
    call(rpc, address, SELECTORS.nextIndex, block).then((o) => Number(wordOf(o))),
    call(rpc, address, SELECTORS.getLastRoot, block).then((o) => toHex32(wordOf(o))),
  ]);
  return { filledSubtrees: subtrees, nextIndex, lastRoot };
}

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
