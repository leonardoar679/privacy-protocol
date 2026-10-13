// Plan §38, applied to the pool. Before the wallet builds a proof on a tree it rebuilt from RPC logs, that
// tree must contain, as its first leaves, exactly the tree the core held at the latest finalized block:
// leaf count and root read by storage proof under a header a 2/3 sync committee signed (sdk/lightclient).
// An RPC quorum that hides notes or invents them is caught. Leaves newer than finality (the last ~13
// minutes) still rest on the RPC quorum alone, and the status says how many leaves are proven. Chains
// this light client does not serve (a local devnet) are reported as such; the check can be switched off
// under Advanced.
import { useSyncExternalStore } from "react";
import { keccak256, type Hex } from "viem";
import { TX_LEVELS } from "@ref/txInputs";
import type { LightClient, StoreSnapshot } from "./lightclient";
import type { provenStorage as ProvenStorage, syncLightClient as SyncLightClient } from "./lightclient";
import { periodAtSlot, currentSlot, specForChain } from "./lightclient/spec";
import { treeLayers } from "./core";
import type { Deployment, TreeState } from "./chain";
import { settings } from "../wallet/settings";
import { session } from "../wallet/session";

/** PrivacyCore storage (MerkleAccumulator, `forge inspect`): pinned by contracts/test/core/StorageLayout.t.sol. */
export const POOL_SLOTS = { nextLeafIndex: "0x0" as Hex, currentRoot: "0x1" as Hex, /** mapping(uint256 => bool) spentNullifier */ spentNullifierMapping: 8 };
/** A saved store older than this (sync-committee periods of ~27 h) is not walked forward but replaced:
 *  keys of long-retired committees are the light client's weak-subjectivity risk. */
export const MAX_SNAPSHOT_AGE_PERIODS = 12;
/** A light client synced this recently is reused as is: beacon APIs see a sync per ~20 minutes, not one right
 *  before each transaction (a request moments before a relayer's transaction is a timing hint). Its
 *  finalized root stays well inside the core's root history. */
export const LC_REUSE_MS = 20 * 60_000;

const env: Record<string, string | undefined> = (import.meta as any).env ?? {};
const list = (v?: string) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const BEACON_URLS = list(env.VITE_BEACON_URLS);
export const LC_CHECKPOINT: Hex | undefined = /^0x[0-9a-fA-F]{64}$/.test(env.VITE_LC_CHECKPOINT ?? "") ? (env.VITE_LC_CHECKPOINT as Hex) : undefined;

export interface PoolProof { blockNumber: bigint; slot: number; nextLeafIndex: number; root: bigint }
export class TreeNotProven extends Error {}
export type VerifyStatus =
  | { kind: "verified"; proof: PoolProof; leaves: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "off" }
  | { kind: "idle" };

class StatusStore {
  private s: VerifyStatus = { kind: "idle" };
  private ls = new Set<() => void>();
  get(): VerifyStatus { return this.s; }
  set(s: VerifyStatus): void { this.s = s; for (const l of this.ls) l(); }
  subscribe(l: () => void): () => void { this.ls.add(l); return () => this.ls.delete(l); }
}
export const verifyStatus = new StatusStore();
export const useVerifyStatus = (): VerifyStatus => useSyncExternalStore((l) => verifyStatus.subscribe(l), () => verifyStatus.get());

let live: { chainId: bigint; lc: LightClient; syncedAt: number } | null = null;
/** Forget the in-memory light client (tests; a lock). */
export const resetLightClient = () => { live = null; };

type ProofOptions = { fetchFn?: typeof fetch; sync?: typeof SyncLightClient; prover?: typeof ProvenStorage };

/** Storage words of the core at the light client's latest finalized block, proven (the client is synced and its store journaled first). */
async function provenCoreWords(d: Deployment, slots: Hex[], o: ProofOptions): Promise<{ blockNumber: bigint; slot: number; values: bigint[] }> {
  const spec = specForChain(d.chainId);
  if (!spec) throw new Error(`no light client for chain ${d.chainId}`);
  const saved = session.isUnlocked() ? (session.journal().lightClient as { chainId: string; snapshot: StoreSnapshot } | undefined) : undefined;
  let snapshot: StoreSnapshot | undefined = live?.chainId === spec.chainId ? live.lc.snapshot() : saved?.chainId === String(spec.chainId) ? saved.snapshot : undefined;
  if (snapshot && periodAtSlot(currentSlot(spec)) - periodAtSlot(Number(snapshot.finalized.beacon.slot)) > MAX_SNAPSHOT_AGE_PERIODS) snapshot = undefined;
  // the light client (BLS pairing, SSZ, trie walking) is its own chunk, loaded on the first verification
  const lcm = o.sync && o.prover ? null : await import("./lightclient");
  let lc: LightClient;
  if (live?.chainId === spec.chainId && Date.now() - live.syncedAt < LC_REUSE_MS) lc = live.lc;
  else {
    lc = await (o.sync ?? lcm!.syncLightClient)({ spec, beaconUrls: BEACON_URLS, checkpoint: LC_CHECKPOINT, snapshot, fetchFn: o.fetchFn });
    live = { chainId: spec.chainId, lc, syncedAt: Date.now() };
    if (session.isUnlocked()) session.update((j) => { j.lightClient = { chainId: String(spec.chainId), snapshot: lc.snapshot() }; });
  }
  const p = await (o.prover ?? lcm!.provenStorage)(lc, d.rpcUrls, d.core, slots, o.fetchFn);
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

/** Whether each nullifier was spent as of the latest finalized block, proven; null when no light client applies (off, or a chain it does not serve). */
export async function provenSpent(d: Deployment, nullifiers: bigint[], o: ProofOptions = {}): Promise<{ blockNumber: bigint; spent: boolean[] } | null> {
  if (settings.get().verifyReads === false || !specForChain(d.chainId) || !nullifiers.length) return null;
  const p = await provenCoreWords(d, nullifiers.map(nullifierSlot), o);
  return { blockNumber: p.blockNumber, spent: p.values.map((v) => v !== 0n) };
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
    const proof = await provenPool(d, o);
    await checkTreeAgainstProof(tree, proof);
    s = { kind: "verified", proof, leaves: tree.nextLeafIndex };
  }
  verifyStatus.set(s);
  return s;
}
