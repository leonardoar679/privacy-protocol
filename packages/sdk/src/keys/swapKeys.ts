// Per-order wallet keys for private swaps (spec v1.1 §2, §6): a ONE-TIME secp256k1 order key that
// authorizes exactly one provider call, the pre-committed refund note that a failed order becomes, and (V6, spec v2.0
// §11.2) the note a same-chain swap's shield receiver deposits. All derive from the master seed; nothing here is ever
// persisted to dapp-origin storage (TC-01).
import { hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { ownerCommitmentOf } from "@privacy-wallet/protocol/note";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const enc = new TextEncoder();
const NOTE_DATA_BYTES = 169;

function concat(...xs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
}

/** The one-time order key for `orderId` (hex). Never reused: a new orderId gives a new key. */
export function deriveOrderKey(masterSeed: Uint8Array, orderId: Hex): { privateKey: Hex; address: Hex } {
  const h = BigInt(keccak256(concat(masterSeed, enc.encode("/order/"), enc.encode(orderId.toLowerCase()))));
  const k = (h % (SECP256K1_N - 1n)) + 1n; // in [1, n-1]
  const privateKey = ("0x" + k.toString(16).padStart(64, "0")) as Hex;
  return { privateKey, address: privateKeyToAddress(privateKey) };
}

/** 65-byte r‖s‖v (low-s) signature over the escrow's execution digest, as SwapOrderEscrow expects. */
export async function signExecutionDigest(privateKey: Hex, digest: Hex): Promise<Hex> {
  return sign({ hash: digest, privateKey, to: "hex" });
}

export interface RefundNote {
  ownerCommitment: bigint; // the wallet's receiving commitment: refunds come back to US
  noteSecret: bigint;
  noteData: Hex; // the 169-byte payload the refund supplies; its keccak is committed in the order
  noteDataHash: Hex;
}

/**
 * The 169-byte payload a refund re-shields with, derived from the seed and the note counter: a version
 * byte as in a §12 envelope, then a keyed pseudo-random stream nobody without the seed can tell from a
 * dummy's. The refund amount is not known when the order is committed, so the payload cannot be an
 * envelope of the note; deriving it lets a wallet restored from its phrase alone (no journal) regenerate
 * the payloads of its counters and find its refunds on chain (sdk/refunds.ts).
 */
export function refundPayload(masterSeed: Uint8Array, counter: number): Hex {
  return seedPayload(masterSeed, "/refund-payload/", counter);
}

/**
 * V6 (spec v2.0 §11.2): the 169-byte payload a same-chain swap's shield receiver deposits with — the same construction
 * under its own domain, so a wallet restored from its phrase tells a delivered swap from a refund.
 */
export function shieldPayload(masterSeed: Uint8Array, counter: number): Hex {
  return seedPayload(masterSeed, "/shield-payload/", counter);
}

function seedPayload(masterSeed: Uint8Array, domain: string, counter: number): Hex {
  const c = Uint8Array.of((counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff);
  const stream = Array.from({ length: Math.ceil((NOTE_DATA_BYTES - 1) / 32) }, (_, i) => hexToBytes(keccak256(concat(masterSeed, enc.encode(domain), c, Uint8Array.of(i)))));
  const payload = concat(Uint8Array.of(0x01), ...stream).subarray(0, NOTE_DATA_BYTES);
  return ("0x" + Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** The fresh note a refund re-shields into. `counter` must be unique per order (the wallet's note counter). */
export function deriveRefundNote(masterSeed: Uint8Array, counter: number): RefundNote {
  return committedNote(masterSeed, counter, refundPayload(masterSeed, counter));
}

/** V6 (spec v2.0 §11.2): the note a shield receiver deposits a same-chain swap's output as; `counter` is the wallet's next note counter. */
export function deriveShieldNote(masterSeed: Uint8Array, counter: number): RefundNote {
  return committedNote(masterSeed, counter, shieldPayload(masterSeed, counter));
}

function committedNote(masterSeed: Uint8Array, counter: number, noteData: Hex): RefundNote {
  const keys = deriveKeys(masterSeed);
  return { ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter), noteData, noteDataHash: keccak256(noteData) };
}
