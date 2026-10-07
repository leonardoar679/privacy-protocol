// From a proven execution block hash to proven contract storage. The header comes from any RPC and is
// accepted only if keccak256(rlp(header)) is that hash; its state root then anchors `eth_getProof`, whose
// account and storage proofs are walked here through the Merkle-Patricia trie (yellow paper, appendix D)
// — the RPC can withhold data but cannot make a wrong value verify.
import { bytesToHex, fromRlp, hexToBytes, keccak256, toRlp, type Address, type Hex } from "viem";

export class ProofError extends Error {}
const fail = (why: string): never => { throw new ProofError(`state proof: ${why}`); };

/** Header fields in RLP order (Frontier … Prague); then the optional tail, each present from its fork on. */
const HEADER_FIELDS = ["parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom", "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce"] as const;
const HEADER_TAIL = ["baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash", "blockAccessListHash", "slotNumber"] as const;
const QUANTITIES = new Set(["difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas", "slotNumber"]);
/** JSON-RPC block fields that are not part of the header. */
const NOT_HEADER = new Set(["hash", "size", "totalDifficulty", "transactions", "uncles", "withdrawals", "sealFields", "author"]);

const quantity = (v: string): Hex => { const n = BigInt(v); if (n === 0n) return "0x"; const h = n.toString(16); return `0x${h.length % 2 ? "0" + h : h}` as Hex; };

export interface VerifiedHeader { hash: Hex; number: bigint; stateRoot: Hex; timestamp: bigint }

/** Accept an RPC block header only if it hashes to the proven `blockHash`; a field this build does not know fails closed. */
export function verifyHeader(blockHash: Hex, block: Record<string, unknown>): VerifiedHeader {
  const known = new Set<string>([...HEADER_FIELDS, ...HEADER_TAIL, ...NOT_HEADER]);
  const unknown = Object.keys(block).filter((k) => !known.has(k));
  if (unknown.length) fail(`unknown header field(s) ${unknown.join(", ")}`);
  const tail: string[] = [];
  for (const k of HEADER_TAIL) { if (block[k] === undefined || block[k] === null) break; tail.push(k); }
  if (HEADER_TAIL.slice(tail.length).some((k) => block[k] !== undefined && block[k] !== null)) fail("header tail fields out of order");
  const fields = [...HEADER_FIELDS, ...tail].map((k) => { const v = block[k]; if (typeof v !== "string") fail(`header field ${k} missing`); return QUANTITIES.has(k) ? quantity(v as string) : (v as Hex); });
  if (keccak256(toRlp(fields)) !== blockHash.toLowerCase()) fail("the header does not hash to the proven block hash");
  return { hash: blockHash.toLowerCase() as Hex, number: BigInt(block.number as string), stateRoot: (block.stateRoot as Hex).toLowerCase() as Hex, timestamp: BigInt(block.timestamp as string) };
}

type RlpItem = Hex | RlpItem[];
const nibbles = (b: Uint8Array) => { const n: number[] = []; for (const x of b) n.push(x >> 4, x & 15); return n; };

/** Walk a Merkle-Patricia proof for `path` (32 bytes, already hashed) from `root`; the RLP value, or null when the proof shows the key is absent. */
export function mptGet(root: Hex, path: Uint8Array, proof: Hex[]): Uint8Array | null {
  const key = nibbles(path);
  let pos = 0, i = 0;
  let ref: RlpItem = root;
  for (;;) {
    let node: RlpItem[];
    if (typeof ref === "string") {
      const r = hexToBytes(ref);
      if (r.length === 0) return null; // an empty slot: the key is not in the trie
      if (r.length !== 32) fail("a node reference that is neither a hash nor an embedded node");
      if (i >= proof.length) fail("the proof ends before the key does");
      const encoded = proof[i++];
      if (keccak256(encoded) !== bytesToHex(r)) fail(`proof node ${i - 1} does not hash to its reference`);
      node = fromRlp(encoded, "hex") as RlpItem[];
    } else node = ref; // embedded (< 32 bytes) node
    if (!Array.isArray(node)) fail("a proof node that is not a list");
    if (node.length === 17) {
      if (pos === key.length) { const v = hexToBytes(node[16] as Hex); return v.length ? v : null; }
      ref = node[key[pos++]];
      continue;
    }
    if (node.length !== 2) fail(`a proof node with ${node.length} items`);
    const enc = nibbles(hexToBytes(node[0] as Hex));
    if (!enc.length) fail("an empty path in a leaf/extension node");
    const flag = enc[0];
    if (flag > 3) fail("a bad hex-prefix flag");
    const part = enc.slice(flag & 1 ? 1 : 2);
    const matches = part.every((x, k) => key[pos + k] === x);
    if (flag >= 2) { // leaf
      if (!matches || pos + part.length !== key.length) return null; // a different key ends here: absent
      return hexToBytes(node[1] as Hex);
    }
    if (!matches) return null; // the key diverges inside an extension: absent
    pos += part.length;
    ref = node[1];
  }
}

export interface AccountProof { address: Address; accountProof: Hex[]; balance: Hex; codeHash: Hex; nonce: Hex; storageHash: Hex; storageProof: { key: Hex; value: Hex; proof: Hex[] }[] }
export interface VerifiedAccount { nonce: bigint; balance: bigint; storageRoot: Hex; codeHash: Hex }

const EMPTY_TRIE = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
const EMPTY_CODE = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/** The account at `address` as of `stateRoot` (an absent account is the empty account). */
export function verifyAccount(stateRoot: Hex, p: AccountProof): VerifiedAccount {
  const leaf = mptGet(stateRoot, hexToBytes(keccak256(p.address)), p.accountProof);
  const acct: VerifiedAccount = leaf === null
    ? { nonce: 0n, balance: 0n, storageRoot: EMPTY_TRIE, codeHash: EMPTY_CODE }
    : (() => {
      const [nonce, balance, storageRoot, codeHash] = fromRlp(leaf, "hex") as Hex[];
      return { nonce: BigInt(nonce === "0x" ? 0 : nonce), balance: BigInt(balance === "0x" ? 0 : balance), storageRoot: storageRoot.toLowerCase() as Hex, codeHash: codeHash.toLowerCase() as Hex };
    })();
  // the RPC's own summary must agree with what the proof shows
  if (BigInt(p.nonce) !== acct.nonce || BigInt(p.balance) !== acct.balance || p.storageHash.toLowerCase() !== acct.storageRoot || p.codeHash.toLowerCase() !== acct.codeHash) fail(`the RPC's account summary for ${p.address} disagrees with its proof`);
  return acct;
}

/** The storage word at `slot` under `storageRoot`. */
export function verifyStorage(storageRoot: Hex, slot: Hex, proof: Hex[]): bigint {
  const key = hexToBytes(keccak256(`0x${BigInt(slot).toString(16).padStart(64, "0")}` as Hex));
  const leaf = mptGet(storageRoot, key, proof);
  if (leaf === null) return 0n;
  const v = fromRlp(leaf, "hex") as Hex;
  if (typeof v !== "string") fail("a storage leaf that is not a byte string");
  return v === "0x" ? 0n : BigInt(v);
}

/** A slot of a Solidity `mapping(K => V)` at `mappingSlot`: keccak256(key ‖ slot). */
export const mappingSlot = (key: bigint | Hex, mappingSlotIndex: number): Hex =>
  keccak256(`0x${BigInt(key).toString(16).padStart(64, "0")}${BigInt(mappingSlotIndex).toString(16).padStart(64, "0")}` as Hex);
