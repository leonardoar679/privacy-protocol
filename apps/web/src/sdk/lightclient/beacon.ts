// An Ethereum light client (consensus-specs altair→gloas light-client/sync-protocol.md): from one trusted
// beacon block root, follow the sync committees forward and accept a finalized header only when a
// supermajority of the current sync committee signed a header whose state proves it final. Every proof
// is checked here — Merkle branches by SSZ hashing, the aggregate BLS signature by pairing — so a beacon
// API is only a courier: one that lies is caught; one that refuses only stops the client.
import { fetchFor } from "../../api/transport";
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import {
  beaconBlockHeaderRoot, computeDomain, executionPayloadHeaderDenebRoot, isValidMerkleBranch, signingRoot, syncCommitteeRoot,
  type BeaconBlockHeader, type ExecutionPayloadHeaderDeneb, type SyncCommittee,
} from "./ssz";
import { BLS_DST, DOMAIN_SYNC_COMMITTEE, GINDEX, SYNC_COMMITTEE_SIZE, currentSlot, epochAtSlot, forkAtEpoch, lcFork, periodAtSlot, type BeaconChainSpec, type LcFork } from "./spec";

export interface LightClientHeader { beacon: BeaconBlockHeader; execution?: ExecutionPayloadHeaderDeneb; execution_block_hash?: Hex; execution_branch: Hex[] }
export interface LightClientBootstrap { header: LightClientHeader; current_sync_committee: SyncCommittee; current_sync_committee_branch: Hex[] }
export interface LightClientUpdate {
  attested_header: LightClientHeader;
  next_sync_committee?: SyncCommittee; next_sync_committee_branch?: Hex[];
  finalized_header: LightClientHeader; finality_branch: Hex[];
  sync_aggregate: { sync_committee_bits: Hex; sync_committee_signature: Hex };
  signature_slot: string;
}

export class LightClientError extends Error {}
/** Slack for the local clock when refusing updates signed in the future (2 minutes). */
export const CLOCK_SLACK_SLOTS = 10;
const fail = (why: string): never => { throw new LightClientError(`light client: ${why}`); };

/** The execution block a light-client header commits to, if the header's execution proof holds. */
export function executionBlockHash(h: LightClientHeader, fork: LcFork): Hex {
  const g = GINDEX[fork].execution;
  if (fork === "gloas") {
    if (!h.execution_block_hash) fail("a gloas header without execution_block_hash");
    if (!isValidMerkleBranch(hexToBytes(h.execution_block_hash!), h.execution_branch, g, h.beacon.body_root)) fail("the execution block hash is not in the beacon block body");
    return h.execution_block_hash!.toLowerCase() as Hex;
  }
  if (!h.execution) fail(`a ${fork} header without its execution payload header`);
  if (!isValidMerkleBranch(executionPayloadHeaderDenebRoot(h.execution!), h.execution_branch, g, h.beacon.body_root)) fail("the execution payload header is not in the beacon block body");
  return h.execution!.block_hash.toLowerCase() as Hex;
}

/** Sync committee members whose bit is set (bits are little-endian within each byte). */
function participants(bitsHex: Hex): number[] {
  const bits = hexToBytes(bitsHex);
  if (bits.length * 8 !== SYNC_COMMITTEE_SIZE) fail(`sync committee bits for ${bits.length * 8} members, expected ${SYNC_COMMITTEE_SIZE}`);
  const out: number[] = [];
  for (let i = 0; i < SYNC_COMMITTEE_SIZE; i++) if ((bits[i >> 3] >> (i & 7)) & 1) out.push(i);
  return out;
}

type G1 = ReturnType<typeof bls12_381.G1.ProjectivePoint.fromHex>;
/** A committee with its root and, once needed, its decompressed (subgroup-checked) keys. */
interface Committee { root: Hex; committee: SyncCommittee; points?: G1[] }
const committeeOf = (c: SyncCommittee): Committee => ({ root: bytesToHex(syncCommitteeRoot(c)), committee: c });

export interface StoreSnapshot { finalized: LightClientHeader; finalizedFork: LcFork; current: SyncCommittee; next?: SyncCommittee }

export class LightClient {
  private finalized: LightClientHeader;
  private finalizedFork: LcFork;
  private current: Committee;
  private next?: Committee;
  /** Minimum share of the committee that must have signed (the spec's safety threshold for applying an update). */
  readonly minParticipants: number;

  private constructor(readonly spec: BeaconChainSpec, s: StoreSnapshot, minShare: number) {
    this.finalized = s.finalized; this.finalizedFork = s.finalizedFork;
    this.current = committeeOf(s.current); this.next = s.next ? committeeOf(s.next) : undefined;
    this.minParticipants = Math.ceil(SYNC_COMMITTEE_SIZE * minShare);
  }

  /** initialize_light_client_store: the bootstrap must be the state of exactly `trustedBlockRoot`. */
  static fromBootstrap(spec: BeaconChainSpec, trustedBlockRoot: Hex, bootstrap: LightClientBootstrap, version: string, minShare = 2 / 3): LightClient {
    const fork = lcFork(version);
    if (bytesToHex(beaconBlockHeaderRoot(bootstrap.header.beacon)) !== trustedBlockRoot.toLowerCase()) fail("the bootstrap is not for the trusted block root");
    executionBlockHash(bootstrap.header, fork);
    if (!isValidMerkleBranch(syncCommitteeRoot(bootstrap.current_sync_committee), bootstrap.current_sync_committee_branch, GINDEX[fork].currentSyncCommittee, bootstrap.header.beacon.state_root)) fail("the bootstrap's sync committee is not in its state");
    return new LightClient(spec, { finalized: bootstrap.header, finalizedFork: fork, current: bootstrap.current_sync_committee }, minShare);
  }

  /** Resume from a store this wallet verified before (kept in its encrypted journal). */
  static fromSnapshot(spec: BeaconChainSpec, s: StoreSnapshot, minShare = 2 / 3): LightClient { return new LightClient(spec, s, minShare); }
  snapshot(): StoreSnapshot { return { finalized: this.finalized, finalizedFork: this.finalizedFork, current: this.current.committee, next: this.next?.committee }; }

  get finalizedHeader(): LightClientHeader { return this.finalized; }
  get finalizedSlot(): number { return Number(this.finalized.beacon.slot); }
  get period(): number { return periodAtSlot(this.finalizedSlot); }
  get knowsNextCommittee(): boolean { return !!this.next; }
  /** The execution block hash of the finalized header (its proof is re-checked). */
  finalizedExecutionBlockHash(): Hex { return executionBlockHash(this.finalized, this.finalizedFork); }

  /** validate_light_client_update + apply_light_client_update, for updates that carry finality. */
  applyUpdate(u: LightClientUpdate, version: string, nowMs = Date.now()): void {
    const fork = lcFork(version);
    const signers = participants(u.sync_aggregate.sync_committee_bits);
    if (signers.length < this.minParticipants) fail(`only ${signers.length} of ${SYNC_COMMITTEE_SIZE} sync committee members signed (at least ${this.minParticipants} required)`);
    const sigSlot = Number(u.signature_slot), attSlot = Number(u.attested_header.beacon.slot), finSlot = Number(u.finalized_header.beacon.slot);
    // a slot from the future is refused; 10 slots (2 min) of slack absorb a skewed local clock (the signature still has to verify)
    if (!(currentSlot(this.spec, nowMs) + CLOCK_SLACK_SLOTS >= sigSlot && sigSlot > attSlot && attSlot >= finSlot)) fail("slots out of order (signature > attested >= finalized, not in the future)");
    executionBlockHash(u.attested_header, fork);
    executionBlockHash(u.finalized_header, fork);

    const storePeriod = this.period, sigPeriod = periodAtSlot(sigSlot), attPeriod = periodAtSlot(attSlot);
    if (this.next ? sigPeriod !== storePeriod && sigPeriod !== storePeriod + 1 : sigPeriod !== storePeriod) fail(`signed in period ${sigPeriod}, the store is in ${storePeriod}${this.next ? " (next committee known)" : ""}`);
    const hasNext = !!u.next_sync_committee && !!u.next_sync_committee_branch?.length && u.next_sync_committee.pubkeys.length > 0;
    const learnsNext = !this.next && hasNext && attPeriod === storePeriod;
    if (!(attSlot > this.finalizedSlot || learnsNext)) fail("the update is not newer than what is already final");

    if (!isValidMerkleBranch(beaconBlockHeaderRoot(u.finalized_header.beacon), u.finality_branch, GINDEX[fork].finalizedRoot, u.attested_header.beacon.state_root)) fail("the finalized header is not the finalized checkpoint of the attested state");
    let nextCommittee: Committee | undefined;
    if (hasNext) {
      nextCommittee = committeeOf(u.next_sync_committee!);
      if (attPeriod === storePeriod && this.next && nextCommittee.root !== this.next.root) fail("the update names another next sync committee than the one already proven");
      if (!isValidMerkleBranch(hexToBytes(nextCommittee.root), u.next_sync_committee_branch!, GINDEX[fork].nextSyncCommittee, u.attested_header.beacon.state_root)) fail("the next sync committee is not in the attested state");
    }

    // FastAggregateVerify(participants, signing_root(attested header, domain), signature)
    const committee = sigPeriod === storePeriod ? this.current : this.next!;
    committee.points ??= committee.committee.pubkeys.map((k) => bls12_381.G1.ProjectivePoint.fromHex(k.slice(2)));
    const aggregate = signers.reduce((acc, i) => acc.add(committee.points![i]), bls12_381.G1.ProjectivePoint.ZERO);
    const forkVersion = forkAtEpoch(this.spec, epochAtSlot(Math.max(sigSlot, 1) - 1)).version;
    const domain = computeDomain(DOMAIN_SYNC_COMMITTEE, forkVersion, this.spec.genesisValidatorsRoot);
    const message = signingRoot(beaconBlockHeaderRoot(u.attested_header.beacon), domain);
    let ok = false;
    try { ok = bls12_381.verify(u.sync_aggregate.sync_committee_signature.slice(2), message, aggregate, { DST: BLS_DST }); } catch { ok = false; }
    if (!ok) fail("the sync committee signature does not verify");

    // apply
    const finPeriod = periodAtSlot(finSlot);
    if (!this.next) {
      if (finPeriod === storePeriod && nextCommittee) this.next = nextCommittee;
    } else if (finPeriod === storePeriod + 1) {
      this.current = this.next;
      this.next = nextCommittee && attPeriod === storePeriod + 1 ? nextCommittee : undefined;
    }
    if (finSlot > this.finalizedSlot) { this.finalized = u.finalized_header; this.finalizedFork = fork; }
  }
}

// ---- a courier for the light-client data (beacon API, consensus-specs/beacon-APIs light_client routes) ----

export interface BeaconApi { get<T>(path: string): Promise<{ version: string; data: T }[] | { version: string; data: T }> }

export function beaconApi(base: string, fetchFn: typeof fetch = fetchFor("beacon"), timeoutMs = 20_000) {
  return async <T>(path: string): Promise<T> => {
    const r = await fetchFn(base.replace(/\/+$/, "") + path, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new LightClientError(`beacon API ${base}: HTTP ${r.status} for ${path.split("?")[0]}`);
    return (await r.json()) as T;
  };
}
