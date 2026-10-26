// The snapshot's tree built and rehashed (spec v3.0 §7.4): the generator's side (classic/scripts/snapshot.mjs) and the
// tests' — the tree from the commitments, the three files and the manifest, a tree file loaded as a MerkleTree, a
// snapshot rehashed layer by layer. Loads the vendored arithmetic; the app's main thread imports snapshot.ts instead.
import { fieldElementOf, toHex32 } from "../crypto/field.ts";
import { LEVELS, MerkleTree } from "../crypto/tree.ts";
import type { PoolId } from "../config";
import type { DepositEvent, Hex, WithdrawalEvent } from "./events.ts";
import { checkEvents, pinOf, SNAPSHOT_VERSION, type Snapshot, type SnapshotManifest, type SnapshotTexts, type TreeFile } from "./snapshot.ts";

export function treeFile(tree: MerkleTree): TreeFile {
  return { version: SNAPSHOT_VERSION, levels: LEVELS, leaves: tree.size, layers: tree.toLayers().map((l) => l.map(toHex32)) };
}

export function treeFromFile(file: TreeFile): MerkleTree {
  if (file.version !== SNAPSHOT_VERSION || file.levels !== LEVELS) throw new Error("not a tree file of this version");
  const layers = file.layers.map((layer) =>
    layer.map((h) => {
      const v = fieldElementOf(h);
      if (v === null) throw new Error("a node is not a field element");
      return v;
    }),
  );
  if (layers[0]?.length !== file.leaves) throw new Error("the tree file's leaf count is not its first layer's");
  return MerkleTree.fromLayers(layers);
}

export interface BuildInput {
  pool: PoolId;
  address: Hex;
  chainId?: number;
  deployedBlock: number;
  toBlock: number;
  blockHash: Hex | null;
  deposits: readonly DepositEvent[];
  withdrawals: readonly WithdrawalEvent[];
  generatedAt: string;
  verified?: SnapshotManifest["verified"];
}

/** The three files and the manifest; the tree built from the commitments (about 2n hashes). */
export async function buildSnapshot(input: BuildInput): Promise<{ manifest: SnapshotManifest; texts: SnapshotTexts; tree: MerkleTree }> {
  checkEvents(input);
  const tree = MerkleTree.fromLeaves(input.deposits.map((d) => BigInt(d.commitment)));
  const texts: SnapshotTexts = {
    "deposits.json": JSON.stringify(input.deposits),
    "withdrawals.json": JSON.stringify(input.withdrawals),
    "tree.json": JSON.stringify(treeFile(tree)),
  };
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_VERSION,
    chainId: input.chainId ?? 1,
    pool: input.pool,
    address: input.address,
    deployedBlock: input.deployedBlock,
    toBlock: input.toBlock,
    blockHash: input.blockHash,
    leaves: tree.size,
    root: toHex32(tree.root),
    files: {
      "deposits.json": await pinOf(texts["deposits.json"], input.deposits.length),
      "withdrawals.json": await pinOf(texts["withdrawals.json"], input.withdrawals.length),
      "tree.json": await pinOf(texts["tree.json"]),
    },
    generatedAt: input.generatedAt,
    ...(input.verified ? { verified: input.verified } : {}),
  };
  return { manifest, texts, tree };
}

/** The tree file's layers against a rebuild from the leaves, and the root against the manifest's (about 2n hashes). */
export function rehashSnapshot(snapshot: Snapshot): { ok: true; tree: MerkleTree } | { ok: false; problems: string[] } {
  const given = treeFromFile(snapshot.treeFile);
  const problems: string[] = [];
  if (toHex32(given.root) !== snapshot.manifest.root.toLowerCase()) problems.push("the tree's root is not the manifest's");
  const rebuilt = MerkleTree.fromLeaves(snapshot.deposits.map((d) => BigInt(d.commitment))).toLayers();
  const layers = given.toLayers();
  for (let level = 0; level <= LEVELS; level++) {
    if (layers[level].length !== rebuilt[level].length || layers[level].some((n, i) => n !== rebuilt[level][i])) {
      problems.push(`layer ${level} is not what the leaves hash to`);
      break;
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, tree: given };
}
