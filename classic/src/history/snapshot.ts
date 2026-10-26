// A pool's history snapshot (spec v3.0 §7.4): the deposits, the withdrawals and the tree's layers as three JSON files,
// and a manifest with each file's sha256 and size, the block the snapshot ends at and its hash, the leaf count and the
// root. A deploy-time artifact served under /classic/data/<pool>/ (classic/scripts/snapshot.mjs writes it; git-ignored),
// loaded by the app before the delta sync, and the format of the committed test fixture. Pure: building and checking;
// the chain is verify.ts's business. Node runs this module directly for the generator: explicit extensions.
import { sha256Hex } from "../crypto/digest.ts";
import { FIELD_SIZE } from "../crypto/hashes.ts";
import { LEVELS, MerkleTree } from "../crypto/tree.ts";
import type { PoolId } from "../config";
import { checkContinuity, type DepositEvent, type Hex, type WithdrawalEvent } from "./events.ts";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FILES = ["deposits.json", "withdrawals.json", "tree.json"] as const;
export type SnapshotFileName = (typeof SNAPSHOT_FILES)[number];

export interface FilePin {
  sha256: string;
  bytes: number;
  /** events in the file (not for the tree) */
  count?: number;
}

export interface SnapshotManifest {
  version: typeof SNAPSHOT_VERSION;
  chainId: number;
  pool: PoolId;
  address: Hex;
  deployedBlock: number;
  /** the events run from the deployed block to this block, inclusive */
  toBlock: number;
  /** the hash of `toBlock`, so a later sync can tell a reorg from history */
  blockHash: Hex | null;
  leaves: number;
  root: Hex;
  files: Record<SnapshotFileName, FilePin>;
  generatedAt: string;
  /** how the root was checked against the chain when the snapshot was made */
  verified?: { method: string; endpoint?: string; block?: number; date: string };
}

export interface TreeFile {
  version: typeof SNAPSHOT_VERSION;
  levels: number;
  leaves: number;
  /** level 0 the leaves; each level as wide as its nodes; 32-byte hex */
  layers: string[][];
}

export interface SnapshotTexts {
  "deposits.json": string;
  "withdrawals.json": string;
  "tree.json": string;
}

export interface Snapshot {
  manifest: SnapshotManifest;
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
  tree: MerkleTree;
}

const toHex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;
const HEX32 = /^0x[0-9a-f]{64}$/;

export function treeFile(tree: MerkleTree): TreeFile {
  return { version: SNAPSHOT_VERSION, levels: LEVELS, leaves: tree.size, layers: tree.toLayers().map((l) => l.map(toHex32)) };
}

export function treeFromFile(file: TreeFile): MerkleTree {
  if (file.version !== SNAPSHOT_VERSION || file.levels !== LEVELS) throw new Error("not a tree file of this version");
  const layers = file.layers.map((layer) =>
    layer.map((h) => {
      if (!HEX32.test(h)) throw new Error("a node is not 32-byte hex");
      const v = BigInt(h);
      if (v >= FIELD_SIZE) throw new Error("a node is outside the field");
      return v;
    }),
  );
  if (layers[0]?.length !== file.leaves) throw new Error("the tree file's leaf count is not its first layer's");
  return MerkleTree.fromLayers(layers);
}

const utf8 = (text: string) => new TextEncoder().encode(text);
export const pinOf = async (text: string, count?: number): Promise<FilePin> => {
  const bytes = utf8(text);
  return { sha256: await sha256Hex(bytes), bytes: bytes.length, ...(count !== undefined ? { count } : {}) };
};

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

/** The deposits in order from leaf 0, inside the block range; the withdrawals inside it too. */
export function checkEvents(input: Pick<BuildInput, "deployedBlock" | "toBlock" | "deposits" | "withdrawals">): void {
  checkContinuity(input.deposits, 0);
  for (const d of input.deposits) {
    if (d.blockNumber < input.deployedBlock || d.blockNumber > input.toBlock) throw new Error(`deposit ${d.leafIndex} is outside the snapshot's blocks`);
    if (!HEX32.test(d.commitment) || BigInt(d.commitment) >= FIELD_SIZE) throw new Error(`deposit ${d.leafIndex} has no field commitment`);
  }
  let last = 0;
  for (const w of input.withdrawals) {
    if (w.blockNumber < input.deployedBlock || w.blockNumber > input.toBlock) throw new Error("a withdrawal is outside the snapshot's blocks");
    if (w.blockNumber < last) throw new Error("the withdrawals are not in block order");
    last = w.blockNumber;
    if (!HEX32.test(w.nullifierHash)) throw new Error("a withdrawal has no 32-byte nullifier hash");
  }
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

export type SnapshotCheck = { ok: true; snapshot: Snapshot } | { ok: false; problems: string[] };

/**
 * Holds the files to the manifest (hashes, sizes, counts), the events to each other (continuity, the tree's leaves the
 * commitments) and the tree to the manifest's root; `rehash` rebuilds the tree from the leaves and compares every layer
 * (about 2n hashes — the tests do it on the fixture; the app relies on the chain's root instead).
 */
export async function verifySnapshot(
  manifest: SnapshotManifest,
  texts: SnapshotTexts,
  { rehash = false, pool }: { rehash?: boolean; pool?: { id: PoolId; address: Hex } } = {},
): Promise<SnapshotCheck> {
  const problems: string[] = [];
  if (manifest.version !== SNAPSHOT_VERSION) problems.push(`manifest version ${String(manifest.version)}, not ${SNAPSHOT_VERSION}`);
  if (pool && (manifest.pool !== pool.id || manifest.address.toLowerCase() !== pool.address.toLowerCase())) problems.push("the manifest is another pool's");
  for (const name of SNAPSHOT_FILES) {
    const pin = manifest.files?.[name];
    if (!pin) {
      problems.push(`${name} is not in the manifest`);
      continue;
    }
    const actual = await pinOf(texts[name]);
    if (actual.sha256 !== pin.sha256 || actual.bytes !== pin.bytes) problems.push(`${name} does not hash to the manifest`);
  }
  if (problems.length) return { ok: false, problems };
  let deposits: DepositEvent[];
  let withdrawals: WithdrawalEvent[];
  let tree: MerkleTree;
  try {
    deposits = JSON.parse(texts["deposits.json"]) as DepositEvent[];
    withdrawals = JSON.parse(texts["withdrawals.json"]) as WithdrawalEvent[];
    checkEvents({ deployedBlock: manifest.deployedBlock, toBlock: manifest.toBlock, deposits, withdrawals });
    tree = treeFromFile(JSON.parse(texts["tree.json"]) as TreeFile);
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : "a file is not readable"] };
  }
  if (manifest.files["deposits.json"].count !== deposits.length) problems.push("the deposit count is not the manifest's");
  if (manifest.files["withdrawals.json"].count !== withdrawals.length) problems.push("the withdrawal count is not the manifest's");
  if (tree.size !== deposits.length || manifest.leaves !== deposits.length) problems.push("the tree's leaves are not the deposits");
  for (let i = 0; i < Math.min(tree.size, deposits.length); i++) {
    if (tree.leaf(i) !== BigInt(deposits[i].commitment)) {
      problems.push(`leaf ${i} is not deposit ${i}'s commitment`);
      break;
    }
  }
  if (toHex32(tree.root) !== manifest.root.toLowerCase()) problems.push("the tree's root is not the manifest's");
  if (rehash && !problems.length) {
    const rebuilt = MerkleTree.fromLeaves(deposits.map((d) => BigInt(d.commitment))).toLayers();
    const given = tree.toLayers();
    for (let level = 0; level <= LEVELS; level++) {
      if (given[level].length !== rebuilt[level].length || given[level].some((n, i) => n !== rebuilt[level][i])) {
        problems.push(`layer ${level} is not what the leaves hash to`);
        break;
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, snapshot: { manifest, deposits, withdrawals, tree } };
}
