// Plan §38, applied to the pool. Before the wallet builds a proof on a tree it rebuilt from RPC logs, that
// tree must contain, as its first leaves, exactly the tree the core held at the latest finalized block:
// leaf count and root read by storage proof under a header a 2/3 sync committee signed (sdk/lightclient).
// An RPC quorum that hides notes or invents them is caught. Leaves newer than finality (the last ~13
// minutes) still rest on the RPC quorum alone, and the status says how many leaves are proven. Chains
// this light client does not serve (a local devnet) are reported as such; the check can be switched off
// under Advanced.
import { keccak256, type Hex } from "viem";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import type { LightClient, StoreSnapshot } from "./lightclient";
import type { provenStorage as ProvenStorage, syncLightClient as SyncLightClient } from "./lightclient";
import { periodAtSlot, currentSlot, specForChain } from "./lightclient/spec";
import { treeLayers } from "./core";
import type { Deployment, TreeState } from "./chain";
import { settings } from "./wallet/settings";
import { session } from "./wallet/session";
import { config } from "./config";

/** PrivacyCore storage (MerkleAccumulator, `forge inspect`): pinned by contracts/test/core/StorageLayout.t.sol. */
export const POOL_SLOTS = { nextLeafIndex: "0x0" as Hex, currentRoot: "0x1" as Hex, /** mapping(uint256 => bool) spentNullifier */ spentNullifierMapping: 8 };
/** A saved store older than this (sync-committee periods of ~27 h) is not walked forward but replaced:
 *  keys of long-retired committees are the light client's weak-subjectivity risk. */
export const MAX_SNAPSHOT_AGE_PERIODS = 12;
/** A light client synced this recently is reused as is: beacon APIs see a sync per ~20 minutes, not one right
 *  before each transaction (a request moments before a relayer's transaction is a timing hint). Its
 *  finalized root stays well inside the core's root history. */
export const LC_REUSE_MS = 20 * 60_000;
/**
 * The fourth review round (2026-11-03): "the latest finalized block" has a freshness bound. A finality update no API served (or
 * a slow clock refused) left the store at an older header — hours old, an archive RPC still proving it — and the status read
 * "verified at finalized block N" all the same. A finalized slot more than this many epochs behind the clock (twelve: about 77
 * minutes, against finality's usual two) is synced again once and, still behind, refused as unavailable.
 */
export const MAX_FINALITY_LAG_EPOCHS = 12;

const list = (v?: string) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** The light client's beacon APIs and trusted checkpoint from the configuration (V6 Stage 3). */
export const beaconUrls = (): string[] => list(config().beaconUrls.join(","));
export const lcCheckpoint = (): Hex | undefined => config().lcCheckpoint;

export interface PoolProof { blockNumber: bigint; slot: number; nextLeafIndex: number; root: bigint }
/** The endpoints' view does not match the proven pool: refused before anything is proved, so nothing moved (its catalog row, n38). */
export class TreeNotProven extends Error {
  readonly code = "verification_failed";
}
/** The light client could not check (its sync, a beacon API, a proof); the cause's words are its own (audit round 2, n38). */
export class VerificationUnavailable extends Error {
  readonly code = "verification_failed";
}
export type VerifyStatus =
  | { kind: "verified"; proof: PoolProof; leaves: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "off" }
  | { kind: "idle" }
  /** the last check failed, and why (audit round 2, n42) */
  | { kind: "failed"; reason: string };

class StatusStore {
  private s: VerifyStatus = { kind: "idle" };
  private ls = new Set<() => void>();
  get(): VerifyStatus { return this.s; }
  set(s: VerifyStatus): void { this.s = s; for (const l of this.ls) l(); }
  subscribe(l: () => void): () => void { this.ls.add(l); return () => this.ls.delete(l); }
}
export const verifyStatus = new StatusStore();

let live: { chainId: bigint; lc: LightClient; syncedAt: number } | null = null;
/** Forget the in-memory light client (tests; a lock). */
export const resetLightClient = () => { live = null; };

type ProofOptions = { fetchFn?: typeof fetch; sync?: typeof SyncLightClient; prover?: typeof ProvenStorage };

/**
 * Storage words of the core at the light client's latest finalized block, proven (the client is synced and its store journaled
 * first). Any failure is a `VerificationUnavailable` with the cause's words (audit round 2, n38): a beacon API that refused or
 * never answered, an update or a proof that does not verify — each before anything is proved, so nothing moved. They had read
 * as unknown, or as an unreachable relayer ("fetch failed"): "We are checking where your funds are" for a Send that never left.
 */
async function provenCoreWords(d: Deployment, slots: Hex[], o: ProofOptions): Promise<{ blockNumber: bigint; slot: number; values: bigint[] }> {
  try {
    return await readProvenCoreWords(d, slots, o);
  } catch (e) {
    throw new VerificationUnavailable(e instanceof Error ? e.message : String(e), { cause: e });
  }
}

async function readProvenCoreWords(d: Deployment, slots: Hex[], o: ProofOptions): Promise<{ blockNumber: bigint; slot: number; values: bigint[] }> {
  const spec = specForChain(d.chainId);
  if (!spec) throw new Error(`no light client for chain ${d.chainId}`);
  const saved = session.isUnlocked() ? (session.journal().lightClient as { chainId: string; snapshot: unknown } | undefined) : undefined;
  // a saved snapshot the build cannot read — a damaged write, a shape this build does not know — is no start (the fourth review
  // round, 2026-11-03): it had thrown outside the fail-over, and every spend and scan read "verification failed" until it aged out
  const savedSnapshot = saved?.chainId === String(spec.chainId) && isStoreSnapshot(saved.snapshot) ? saved.snapshot : undefined;
  let snapshot: StoreSnapshot | undefined = live?.chainId === spec.chainId ? live.lc.snapshot() : savedSnapshot;
  if (snapshot && periodAtSlot(currentSlot(spec)) - periodAtSlot(Number(snapshot.finalized.beacon.slot)) > MAX_SNAPSHOT_AGE_PERIODS) snapshot = undefined;
  // the light client (BLS pairing, SSZ, trie walking) is its own chunk, loaded on the first verification
  const lcm = o.sync && o.prover ? null : await import("./lightclient");
  const sync = async (): Promise<LightClient> => {
    // the age limit holds for the configured checkpoint too (audit round 2, n43)
    const fresh = await (o.sync ?? lcm!.syncLightClient)({ spec, beaconUrls: beaconUrls(), checkpoint: lcCheckpoint(), snapshot, fetchFn: o.fetchFn, maxCheckpointAgePeriods: MAX_SNAPSHOT_AGE_PERIODS });
    live = { chainId: spec.chainId, lc: fresh, syncedAt: Date.now() };
    if (session.isUnlocked()) session.update((j) => { j.lightClient = { chainId: String(spec.chainId), snapshot: fresh.snapshot() }; });
    return fresh;
  };
  const reused = live?.chainId === spec.chainId && Date.now() - live.syncedAt < LC_REUSE_MS;
  let lc: LightClient = reused ? live!.lc : await sync();
  // the finalized block's age (the fourth review round, 2026-11-03): a reused client, or one no API moved, is synced again once
  const lagEpochs = (c: LightClient) => Math.floor((currentSlot(spec) - c.finalizedSlot) / 32);
  if (lagEpochs(lc) > MAX_FINALITY_LAG_EPOCHS && reused) lc = await sync();
  if (lagEpochs(lc) > MAX_FINALITY_LAG_EPOCHS)
    throw new Error(`the light client's latest finalized block is ${lagEpochs(lc)} epochs (about ${Math.round((lagEpochs(lc) * 32 * 12) / 60)} min) behind the clock: no beacon API served a newer finality update`);
  let p: Awaited<ReturnType<typeof ProvenStorage>>;
  try {
    p = await (o.prover ?? lcm!.provenStorage)(lc, d.rpcUrls, d.core, slots, o.fetchFn);
  } catch (e) {
    // a reused client's finalized block ages about five blocks a minute (audit round 2, r25): past the endpoints' proof window
    // (128 blocks on a geth full node) every proof was refused until the reuse ended — every spend and scan failed for a third
    // to two thirds of each 20 minutes. Synced again once, at the latest finalized block
    if (!reused) throw e;
    lc = await sync();
    p = await (o.prover ?? lcm!.provenStorage)(lc, d.rpcUrls, d.core, slots, o.fetchFn);
  }
  return { blockNumber: p.header.number, slot: lc.finalizedSlot, values: p.values };
}

/** The pool's leaf count and root at the latest finalized block, proven. */
export async function provenPool(d: Deployment, o: ProofOptions = {}): Promise<PoolProof> {
  const p = await provenCoreWords(d, [POOL_SLOTS.nextLeafIndex, POOL_SLOTS.currentRoot], o);
  return { blockNumber: p.blockNumber, slot: p.slot, nextLeafIndex: Number(p.values[0] & 0xffffffffn), root: p.values[1] };
}

/** keccak256(nullifier ‖ 8): the spentNullifier mapping's slot for a nullifier. */
export const nullifierSlot = (nf: bigint): Hex => {
  const hex = (v: bigint) => v.toString(16).padStart(64, "0");
  return keccak256(`0x${hex(nf)}${hex(BigInt(POOL_SLOTS.spentNullifierMapping))}` as Hex);
};

/** At most this many storage slots per eth_getProof (audit round 2, n44): the endpoints cap a response's size and time. */
export const PROOF_BATCH_SLOTS = 32;

/**
 * Whether each nullifier was spent as of the latest finalized block, proven, `PROOF_BATCH_SLOTS` per request: `blockNumber` is the
 * latest of the batches' and `blocks[i]` the block nullifier i was proven at (the fourth review round, 2026-11-03: a batch proven at
 * an earlier finalized block than a later one, after a re-sync in between, must not be read at the later block — a spent mark's
 * lift compares against the block its own proof reached); null when no light client applies (off, or a chain it does not serve).
 */
export async function provenSpent(d: Deployment, nullifiers: bigint[], o: ProofOptions = {}): Promise<{ blockNumber: bigint; blocks: bigint[]; spent: boolean[] } | null> {
  if (settings.get().verifyReads === false || !specForChain(d.chainId) || !nullifiers.length) return null;
  let blockNumber = 0n;
  const spent: boolean[] = [];
  const blocks: bigint[] = [];
  for (let i = 0; i < nullifiers.length; i += PROOF_BATCH_SLOTS) {
    const p = await provenCoreWords(d, nullifiers.slice(i, i + PROOF_BATCH_SLOTS).map(nullifierSlot), o);
    if (p.blockNumber > blockNumber) blockNumber = p.blockNumber;
    spent.push(...p.values.map((v) => v !== 0n));
    blocks.push(...p.values.map(() => p.blockNumber));
  }
  return { blockNumber, blocks, spent };
}

/** The shape of a saved light-client store (a journal field this build wrote, or an older one): what `LightClient.fromSnapshot` needs. */
export function isStoreSnapshot(x: unknown): x is StoreSnapshot {
  const isHex = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
  const header = (h: unknown): boolean => {
    const b = (h as { beacon?: Record<string, unknown> } | null)?.beacon;
    return !!b && typeof b.slot === "string" && /^\d+$/.test(b.slot) && isHex(b.state_root) && isHex(b.body_root) && Array.isArray((h as { execution_branch?: unknown }).execution_branch);
  };
  const committee = (c: unknown): boolean => {
    const k = (c as { pubkeys?: unknown; aggregate_pubkey?: unknown } | null) ?? null;
    return !!k && Array.isArray(k.pubkeys) && k.pubkeys.length === 512 && k.pubkeys.every(isHex) && isHex(k.aggregate_pubkey);
  };
  const s = x as { finalized?: unknown; finalizedFork?: unknown; current?: unknown; next?: unknown } | null;
  return !!s && typeof s === "object" && header(s.finalized) && typeof s.finalizedFork === "string" && committee(s.current) && (s.next === undefined || committee(s.next));
}

/** The tree's first `proof.nextLeafIndex` leaves must hash to the proven root; the RPCs may know more leaves, never fewer. */
export async function checkTreeAgainstProof(tree: TreeState, proof: PoolProof): Promise<void> {
  if (tree.nextLeafIndex < proof.nextLeafIndex) throw new TreeNotProven(`the RPC endpoints show ${tree.nextLeafIndex} leaves; the chain had ${proof.nextLeafIndex} at finalized block ${proof.blockNumber} — they are hiding notes`);
  const prefix = proof.nextLeafIndex === tree.nextLeafIndex ? tree.layers : await treeLayers(tree.leaves.slice(0, proof.nextLeafIndex), TX_LEVELS);
  if (prefix.root !== proof.root) throw new TreeNotProven(`the RPC endpoints' tree does not hash to the root proven at finalized block ${proof.blockNumber} — refusing to act on it`);
}

/** Verify a freshly synced tree, when this chain has a light client and the user has not switched it off. */
export async function verifyTree(d: Deployment, tree: TreeState, onStatus?: (s: string) => void, o: ProofOptions = {}): Promise<VerifyStatus> {
  let s: VerifyStatus;
  if (settings.get().verifyReads === false) s = { kind: "off" };
  else if (!specForChain(d.chainId)) s = { kind: "unavailable", reason: `no light client for chain ${d.chainId}: reads rest on the RPC quorum` };
  else {
    onStatus?.("Verifying the pool with the Ethereum light client…");
    try {
      const proof = await provenPool(d, o);
      await checkTreeAgainstProof(tree, proof);
      s = { kind: "verified", proof, leaves: tree.nextLeafIndex };
    } catch (e) {
      // a failed check is what the status says (audit round 2, n42): only a success set it, and More → Advanced kept the last
      // one's "Verified at finalized block …" after a refusal (the reason's first line, as the error names it)
      verifyStatus.set({ kind: "failed", reason: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240) });
      throw e;
    }
  }
  verifyStatus.set(s);
  return s;
}
