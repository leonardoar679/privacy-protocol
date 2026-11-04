// One-time endpoints (spec §6): the EVM source endpoint is a counterfactual SwapOrderEscrow whose
// CREATE2 address is computed here exactly as SwapOrderFactory.predict does on-chain, and the
// execution authorization is the digest SwapOrderEscrow.executionDigest computes.
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { OrderParams } from "./types";

export const EXECUTE_TAG = keccak_256(new TextEncoder().encode("privacy-protocol/v1.1/swap-order/execute"));

const hex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`;
const bytes = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
export const word = (v: bigint | number | string): Buffer => {
  let x = typeof v === "string" ? BigInt(v) : BigInt(v);
  // refused, never truncated (the seventh review round, 2026-11-03): c and c + 2^256 had encoded alike, so params no contract call can
  // take predicted a vouched order's escrow and its vouches verified for them
  if (x < 0n || x >= 1n << 256n) throw new RangeError(`not a uint256: ${String(v).slice(0, 80)}`);
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const addrWord = (a: string) => word(BigInt(a));
const b32 = (h: string) => { const b = bytes(h); if (b.length !== 32) throw new Error("expected 32 bytes"); return b; };

/** abi.encode(OrderParams): a static struct = 12 consecutive 32-byte words. */
export function encodeOrderParams(p: OrderParams): Buffer {
  return Buffer.concat([
    b32(p.orderId), word(p.assetType), addrWord(p.asset), word(p.amount), addrWord(p.orderSigner),
    word(p.executeDeadline), word(p.refundAfter), addrWord(p.refundVault),
    word(p.refundOwnerCommitment), word(p.refundNoteSecret), b32(p.refundNoteDataHash), word(p.executorTip),
  ]);
}

export function initCodeHash(creationCode: string, p: OrderParams): `0x${string}` {
  return hex(keccak_256(Buffer.concat([bytes(creationCode), encodeOrderParams(p)])));
}

/** address(uint160(uint256(keccak256(0xff ‖ factory ‖ salt ‖ initCodeHash)))) */
export function predictEscrow(factory: string, creationCode: string, p: OrderParams): `0x${string}` {
  const h = keccak_256(Buffer.concat([Buffer.from([0xff]), addrWord(factory).subarray(12), b32(p.orderId), bytes(initCodeHash(creationCode, p))]));
  return hex(h.subarray(12));
}

/** keccak256(abi.encode(EXECUTE_TAG, chainId, escrow, orderId, provider, value, keccak256(calldata), deadline)) */
export function executionDigest(chainId: bigint, escrow: string, orderId: string, provider: string, value: bigint, calldata: string, deadline: number): `0x${string}` {
  return hex(keccak_256(Buffer.concat([
    Buffer.from(EXECUTE_TAG), word(chainId), addrWord(escrow), b32(orderId), addrWord(provider), word(value),
    Buffer.from(keccak_256(bytes(calldata))), word(deadline),
  ])));
}

/** 65-byte r‖s‖v signature by the one-time order key (low-s), as SwapOrderEscrow._recover expects. */
export function signExecution(orderPrivateKey: Uint8Array, digest: `0x${string}`): `0x${string}` {
  const sig = secp256k1.sign(bytes(digest), orderPrivateKey, { lowS: true });
  const r = word(sig.r), s = word(sig.s);
  return hex(Buffer.concat([r, s, Buffer.from([27 + sig.recovery])]));
}

export function orderSignerAddress(orderPrivateKey: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(orderPrivateKey, false).subarray(1); // drop 0x04
  return hex(keccak_256(pub).subarray(12));
}

/** Address that produced a 65-byte r‖s‖v signature over `digest` (low-s enforced, like the escrow). */
export function recoverExecutionSigner(digest: `0x${string}`, signature: `0x${string}`): `0x${string}` {
  const sig = bytes(signature);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const r = BigInt("0x" + Buffer.from(sig.subarray(0, 32)).toString("hex"));
  const s = BigInt("0x" + Buffer.from(sig.subarray(32, 64)).toString("hex"));
  const v = sig[64];
  if (v !== 27 && v !== 28) throw new Error("bad v");
  if (s > secp256k1.CURVE.n / 2n) throw new Error("high-s signature");
  const pub = new secp256k1.Signature(r, s).addRecoveryBit(v - 27).recoverPublicKey(bytes(digest)).toRawBytes(false).subarray(1);
  return hex(keccak_256(pub).subarray(12));
}

/**
 * The API vouches for what a relayer may execute (a V6 follow-up of 2026-10-16; audit gap 47). The relayer admitted orders
 * from anyone who could sign one (an order key is its committer's own), so a tip of no value, a zero tip or a provider call
 * made to burn gas cost it its gas. The API signs the escrow of an order it committed, whose address commits to the factory
 * and every parameter (the tip it valued, the pool's refund vault, the asset and the amount), and the provider call it
 * prepared for that order. A relayer executes and refunds only what the voucher it trusts signed. The tags keep the two
 * digests apart from each other and from an execution's (EXECUTE_TAG); the API's key signs nothing else. They are signed
 * and recovered as an execution is (`signExecution`, `recoverExecutionSigner`).
 */
export const ORDER_VOUCH_TAG = keccak_256(new TextEncoder().encode("privacy-wallet/v6/api-vouch/order"));
export const EXECUTION_VOUCH_TAG = keccak_256(new TextEncoder().encode("privacy-wallet/v6/api-vouch/execution"));
/** a same-chain swap's shield receipt (its receiver's address commits to the factory and every parameter) */
export const SHIELD_VOUCH_TAG = keccak_256(new TextEncoder().encode("privacy-wallet/v6/api-vouch/shield"));

/**
 * A restore of an order at the API — POST /v1/operations with its params, a resume, a prepare rebuilt from them — is signed
 * by the order's one-time key over the request it names (audit round 2, r05): the escrow commits to the params only, and
 * they are public once an execution is tried (its calldata, the relayer's job), so anyone could name them with another
 * destination or provider. The tag keeps it apart from an execution's digest: a restore's signature moves nothing.
 */
export const RESTORE_TAG = keccak_256(new TextEncoder().encode("privacy-wallet/v6/api-restore"));
/** The request a restore names, as one text the wallet and the API build alike: the pair, the destination, the provider. */
export const restoreRequestText = (r: { from: { chain: string; asset: string }; to: { chain: string; asset: string }; destination: string; provider: string }): string =>
  JSON.stringify([r.from.chain, r.from.asset, r.to.chain, r.to.asset, r.destination, r.provider]);
/** keccak256(abi.encode(RESTORE_TAG, chainId, escrow, keccak256(requestText))) */
export function restoreDigest(chainId: bigint, escrow: string, requestText: string): `0x${string}` {
  return hex(keccak_256(Buffer.concat([Buffer.from(RESTORE_TAG), word(chainId), addrWord(escrow), Buffer.from(keccak_256(new TextEncoder().encode(requestText)))])));
}

/** keccak256(abi.encode(ORDER_VOUCH_TAG, chainId, escrow)) */
export function orderVouchDigest(chainId: bigint, escrow: string): `0x${string}` {
  return hex(keccak_256(Buffer.concat([Buffer.from(ORDER_VOUCH_TAG), word(chainId), addrWord(escrow)])));
}

/** keccak256(abi.encode(EXECUTION_VOUCH_TAG, chainId, escrow, provider, value, keccak256(calldata), deadline)) */
export function executionVouchDigest(chainId: bigint, escrow: string, provider: string, value: bigint, calldata: string, deadline: number): `0x${string}` {
  return hex(keccak_256(Buffer.concat([
    Buffer.from(EXECUTION_VOUCH_TAG), word(chainId), addrWord(escrow), addrWord(provider), word(value),
    Buffer.from(keccak_256(bytes(calldata))), word(deadline),
  ])));
}

/** keccak256(abi.encode(SHIELD_VOUCH_TAG, chainId, receiver)) */
export function shieldVouchDigest(chainId: bigint, receiver: string): `0x${string}` {
  return hex(keccak_256(Buffer.concat([Buffer.from(SHIELD_VOUCH_TAG), word(chainId), addrWord(receiver)])));
}

/**
 * Whether `signature` over `digest` is the voucher's: one address, or several while the swap service rotates its key (the
 * new one and the ones whose vouches are still out). A missing or malformed signature is no one's.
 */
export function vouchedBy(voucher: string | readonly string[], digest: `0x${string}`, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  let signer: string;
  try {
    signer = recoverExecutionSigner(digest, signature as `0x${string}`).toLowerCase();
  } catch {
    return false;
  }
  return (typeof voucher === "string" ? [voucher] : voucher).some((v) => v.toLowerCase() === signer);
}

export const keccakHex = (data: string | Uint8Array): `0x${string}` =>
  hex(keccak_256(typeof data === "string" ? bytes(data) : data));
