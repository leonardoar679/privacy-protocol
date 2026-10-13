// The SSZ hashing an Ethereum light client needs (consensus-specs ssz/simple-serialize.md): hash_tree_root
// of the few containers a sync-committee update carries, and Merkle-branch verification against a
// generalized index. sha256 throughout; every value is fixed-size except one ByteList (extra_data).
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const ZERO_CHUNK = new Uint8Array(32);
const zeroHashes: Uint8Array[] = [ZERO_CHUNK];
for (let i = 1; i < 64; i++) zeroHashes.push(hashPair(zeroHashes[i - 1], zeroHashes[i - 1]));

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(a, 0); buf.set(b, 32);
  return sha256(buf);
}

/** merkleize(chunks, limit): pad to the next power of two (of `limit` when given) with zero chunks and hash up. */
export function merkleize(chunks: Uint8Array[], limit?: number): Uint8Array {
  const size = Math.max(limit ?? chunks.length, 1);
  if (chunks.length > size) throw new Error("ssz: more chunks than the limit");
  let depth = 0;
  while (1 << depth < size) depth++;
  let layer = chunks.slice();
  for (let d = 0; d < depth; d++) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hashPair(layer[i], i + 1 < layer.length ? layer[i + 1] : zeroHashes[d]));
    layer = next.length ? next : [zeroHashes[d + 1]];
  }
  return layer.length ? layer[0] : zeroHashes[depth];
}

/** Split bytes into 32-byte chunks, the last zero-padded. */
export function pack(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const c = new Uint8Array(32);
    c.set(bytes.subarray(i, i + 32));
    out.push(c);
  }
  return out;
}

export function uintChunk(v: bigint | number | string, bytes = 8): Uint8Array {
  let x = BigInt(v);
  if (x < 0n || x >= 1n << BigInt(8 * bytes)) throw new Error("ssz: uint out of range");
  const c = new Uint8Array(32);
  for (let i = 0; i < bytes; i++) { c[i] = Number(x & 0xffn); x >>= 8n; } // little-endian
  return c;
}

export const mixInLength = (root: Uint8Array, length: number) => hashPair(root, uintChunk(length));

function fixed(hex: Hex, n: number): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== n) throw new Error(`ssz: expected ${n} bytes, got ${b.length}`);
  return b;
}
const bytes32 = (hex: Hex) => fixed(hex, 32);
/** hash_tree_root of a ByteVector[N]. */
const byteVectorRoot = (hex: Hex, n: number) => merkleize(pack(fixed(hex, n)));

export interface BeaconBlockHeader { slot: string; proposer_index: string; parent_root: Hex; state_root: Hex; body_root: Hex }
export function beaconBlockHeaderRoot(h: BeaconBlockHeader): Uint8Array {
  return merkleize([uintChunk(h.slot), uintChunk(h.proposer_index), bytes32(h.parent_root), bytes32(h.state_root), bytes32(h.body_root)]);
}

export interface SyncCommittee { pubkeys: Hex[]; aggregate_pubkey: Hex }
export function syncCommitteeRoot(c: SyncCommittee, size = 512): Uint8Array {
  if (c.pubkeys.length !== size) throw new Error(`ssz: a sync committee has ${size} keys, got ${c.pubkeys.length}`);
  return merkleize([merkleize(c.pubkeys.map((k) => byteVectorRoot(k, 48))), byteVectorRoot(c.aggregate_pubkey, 48)]);
}

/** deneb.ExecutionPayloadHeader (unchanged through Electra and Fulu): 17 fields. */
export interface ExecutionPayloadHeaderDeneb {
  parent_hash: Hex; fee_recipient: Hex; state_root: Hex; receipts_root: Hex; logs_bloom: Hex; prev_randao: Hex;
  block_number: string; gas_limit: string; gas_used: string; timestamp: string; extra_data: Hex; base_fee_per_gas: string;
  block_hash: Hex; transactions_root: Hex; withdrawals_root: Hex; blob_gas_used: string; excess_blob_gas: string;
}
export function executionPayloadHeaderDenebRoot(e: ExecutionPayloadHeaderDeneb): Uint8Array {
  const extra = hexToBytes(e.extra_data);
  if (extra.length > 32) throw new Error("ssz: extra_data longer than 32 bytes");
  return merkleize([
    bytes32(e.parent_hash), merkleize(pack(fixed(e.fee_recipient, 20))), bytes32(e.state_root), bytes32(e.receipts_root),
    byteVectorRoot(e.logs_bloom, 256), bytes32(e.prev_randao), uintChunk(e.block_number), uintChunk(e.gas_limit),
    uintChunk(e.gas_used), uintChunk(e.timestamp), mixInLength(merkleize(pack(extra), 1), extra.length),
    uintChunk(e.base_fee_per_gas, 32), bytes32(e.block_hash), bytes32(e.transactions_root), bytes32(e.withdrawals_root),
    uintChunk(e.blob_gas_used), uintChunk(e.excess_blob_gas),
  ]);
}

/** compute_domain(domain_type, fork_version, genesis_validators_root) */
export function computeDomain(domainType: Hex, forkVersion: Hex, genesisValidatorsRoot: Hex): Uint8Array {
  const forkDataRoot = merkleize([merkleize(pack(fixed(forkVersion, 4))), bytes32(genesisValidatorsRoot)]);
  const d = new Uint8Array(32);
  d.set(fixed(domainType, 4), 0);
  d.set(forkDataRoot.subarray(0, 28), 4);
  return d;
}

/** compute_signing_root(object, domain) = hash_tree_root(SigningData(object_root, domain)) */
export const signingRoot = (objectRoot: Uint8Array, domain: Uint8Array) => hashPair(objectRoot, domain);

export const floorlog2 = (n: number) => 31 - Math.clz32(n);

/** is_valid_merkle_branch for a generalized index: the branch must have exactly floorlog2(gindex) nodes. */
export function isValidMerkleBranch(leaf: Uint8Array, branch: Hex[], gindex: number, root: Hex): boolean {
  const depth = floorlog2(gindex);
  if (branch.length !== depth) return false;
  const index = gindex - (1 << depth);
  let value = leaf;
  for (let i = 0; i < depth; i++) {
    const sibling = hexToBytes(branch[i]);
    if (sibling.length !== 32) return false;
    value = (index >> i) & 1 ? hashPair(sibling, value) : hashPair(value, sibling);
  }
  return bytesToHex(value) === root.toLowerCase();
}
