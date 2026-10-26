// A pool's history snapshot (spec v3.0 §7.4): the deposits, the withdrawals and the tree's layers as three JSON files,
// and a manifest with each file's sha256 and size, the block the snapshot ends at and its hash, the leaf count and the
// root. A deploy-time artifact served under /classic/data/<pool>/ (classic/scripts/snapshot.mjs writes it; git-ignored),
// loaded by the app before the delta sync, and the format of the committed test fixture. This module checks a snapshot
// without any hashing — the files against the manifest, the events against each other, the tree file's shape and its
// leaves against the commitments — so the main thread loads no vendored arithmetic; the tree itself is loaded in the
// worker, whose root is held to the manifest's (src/app/services/history.ts), and snapshotTree.ts builds and rehashes
// (the generator, the tests).
import { sha256Hex } from "../crypto/digest.ts";
import { fieldElementOf, HEX32 } from "../crypto/field.ts";
import type { PoolId } from "../config";
import { checkContinuity, type DepositEvent, type Hex, type WithdrawalEvent } from "./events.ts";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_LEVELS = 20;
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
  treeFile: TreeFile;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
export const pinOf = async (text: string, count?: number): Promise<FilePin> => {
  const bytes = utf8(text);
  return { sha256: await sha256Hex(bytes), bytes: bytes.length, ...(count !== undefined ? { count } : {}) };
};

export interface EventsInput {
  deployedBlock: number;
  toBlock: number;
  deposits: readonly DepositEvent[];
  withdrawals: readonly WithdrawalEvent[];
}

/** The deposits in order from leaf 0, inside the block range; the withdrawals inside it too. */
export function checkEvents(input: EventsInput): void {
  checkContinuity(input.deposits, 0);
  for (const d of input.deposits) {
    if (d.blockNumber < input.deployedBlock || d.blockNumber > input.toBlock) throw new Error(`deposit ${d.leafIndex} is outside the snapshot's blocks`);
    if (fieldElementOf(d.commitment) === null) throw new Error(`deposit ${d.leafIndex} has no field commitment`);
  }
  let last = 0;
  for (const w of input.withdrawals) {
    if (w.blockNumber < input.deployedBlock || w.blockNumber > input.toBlock) throw new Error("a withdrawal is outside the snapshot's blocks");
    if (w.blockNumber < last) throw new Error("the withdrawals are not in block order");
    last = w.blockNumber;
    if (!HEX32.test(w.nullifierHash)) throw new Error("a withdrawal has no 32-byte nullifier hash");
  }
}

/** The tree file's shape: the version and height, every node a field element, each layer as wide as its nodes, the leaves the deposits' commitments. */
export function checkTreeFile(file: TreeFile, deposits: readonly DepositEvent[]): void {
  if (file.version !== SNAPSHOT_VERSION || file.levels !== SNAPSHOT_LEVELS) throw new Error("not a tree file of this version");
  if (!Array.isArray(file.layers) || file.layers.length !== SNAPSHOT_LEVELS + 1) throw new Error(`a tree has ${SNAPSHOT_LEVELS + 1} layers`);
  if (file.layers[0].length !== file.leaves || file.leaves !== deposits.length) throw new Error("the tree file's leaf count is not the deposits'");
  let width = file.leaves;
  for (let level = 0; level <= SNAPSHOT_LEVELS; level++) {
    if (file.layers[level].length !== width) throw new Error(`layer ${level} has ${file.layers[level].length} nodes, not ${width}`);
    for (const node of file.layers[level]) if (fieldElementOf(node) === null) throw new Error(`layer ${level} holds a node outside the field`);
    width = Math.ceil(width / 2);
  }
  for (let i = 0; i < deposits.length; i++) {
    if (file.layers[0][i].toLowerCase() !== deposits[i].commitment.toLowerCase()) throw new Error(`leaf ${i} is not deposit ${i}'s commitment`);
  }
}

export type SnapshotCheck = { ok: true; snapshot: Snapshot } | { ok: false; problems: string[] };

/**
 * Holds the files to the manifest (hashes, sizes, counts), the events to each other (continuity, the blocks), and the
 * tree file to its shape and the commitments. The root is the worker's to compute from the layers and the caller's to
 * hold to `manifest.root`; `snapshotTree.ts` rehashes a snapshot entirely.
 */
export async function verifySnapshot(
  manifest: SnapshotManifest,
  texts: SnapshotTexts,
  { pool }: { pool?: { id: PoolId; address: Hex } } = {},
): Promise<SnapshotCheck> {
  const problems: string[] = [];
  if (manifest.version !== SNAPSHOT_VERSION) problems.push(`manifest version ${String(manifest.version)}, not ${SNAPSHOT_VERSION}`);
  if (pool && (manifest.pool !== pool.id || manifest.address.toLowerCase() !== pool.address.toLowerCase())) problems.push("the manifest is another pool's");
  if (!HEX32.test(manifest.root ?? "")) problems.push("the manifest names no 32-byte root");
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
  let treeFile: TreeFile;
  try {
    deposits = JSON.parse(texts["deposits.json"]) as DepositEvent[];
    withdrawals = JSON.parse(texts["withdrawals.json"]) as WithdrawalEvent[];
    checkEvents({ deployedBlock: manifest.deployedBlock, toBlock: manifest.toBlock, deposits, withdrawals });
    treeFile = JSON.parse(texts["tree.json"]) as TreeFile;
    checkTreeFile(treeFile, deposits);
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : "a file is not readable"] };
  }
  if (manifest.files["deposits.json"].count !== deposits.length) problems.push("the deposit count is not the manifest's");
  if (manifest.files["withdrawals.json"].count !== withdrawals.length) problems.push("the withdrawal count is not the manifest's");
  if (manifest.leaves !== deposits.length) problems.push("the manifest's leaf count is not the deposits'");
  return problems.length ? { ok: false, problems } : { ok: true, snapshot: { manifest, deposits, withdrawals, treeFile } };
}
