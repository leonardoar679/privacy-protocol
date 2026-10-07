// Per-order wallet keys for private swaps (spec v1.1 §2, §6): a ONE-TIME secp256k1 order key that
// authorizes exactly one provider call, and the pre-committed refund note that a failed order becomes.
// Both derive from the master seed; nothing here is ever persisted to dapp-origin storage (TC-01).
import { keccak256, type Hex } from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";
import { deriveKeys, deriveNoteSecret } from "@ref/keys";
import { ownerCommitmentOf } from "@ref/note";

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
 * The fresh note a refund re-shields into. `counter` must be unique per order (the wallet's note
 * counter). The payload is random here — the production wallet writes the encrypted note record
 * (spec §12) so the note can be recovered from chain; until then the wallet keeps `noteData` itself.
 */
export function deriveRefundNote(masterSeed: Uint8Array, counter: number): RefundNote {
  const keys = deriveKeys(masterSeed);
  const payload = new Uint8Array(NOTE_DATA_BYTES);
  crypto.getRandomValues(payload);
  const noteData = ("0x" + Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  return { ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter), noteData, noteDataHash: keccak256(noteData) };
}
