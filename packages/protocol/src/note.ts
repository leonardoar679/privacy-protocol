// Notes (spec §5): owner commitment, two-layer commitment, and the wallet record encoding.
import { NOTE_BODY, NOTE_COMMITMENT, OWNER_COMMITMENT } from "./domains";
import { hash2, hash3, hash5 } from "./poseidon";

export interface Note {
  vaultId: bigint; // canonical vault address as uint
  amount: bigint;
  ownerCommitment: bigint;
  noteSecret: bigint;
}

/** ownerCommitment = H(OWNER_COMMITMENT, spendKey) — the receiving address (spec §4) */
export const ownerCommitmentOf = (spendKey: bigint): bigint => hash2(OWNER_COMMITMENT, spendKey);

/** body = H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret) — 5 inputs (spec §5.2) */
export const noteBody = (n: Note): bigint => hash5(NOTE_BODY, n.vaultId, n.amount, n.ownerCommitment, n.noteSecret);

/** commitment = H(NOTE_COMMITMENT, body, leafIndex) — the contract assigns leafIndex */
export const noteCommitment = (body: bigint, leafIndex: bigint): bigint => hash3(NOTE_COMMITMENT, body, leafIndex);

/** Wallet record, exact 121-byte encoding (spec §5.1). */
export function encodeNote(n: Note, leafIndex: number): Uint8Array {
  const out = new Uint8Array(121);
  out[0] = 0x01;
  writeBE(out, 1, n.vaultId, 20);
  writeBE(out, 21, n.amount, 32);
  writeBE(out, 53, n.ownerCommitment, 32);
  writeBE(out, 85, n.noteSecret, 32);
  writeBE(out, 117, BigInt(leafIndex), 4);
  return out;
}

export function decodeNote(b: Uint8Array): { note: Note; leafIndex: number } {
  if (b.length !== 121 || b[0] !== 0x01) throw new Error("not a v1 note record");
  return {
    note: {
      vaultId: readBE(b, 1, 20),
      amount: readBE(b, 21, 32),
      ownerCommitment: readBE(b, 53, 32),
      noteSecret: readBE(b, 85, 32),
    },
    leafIndex: Number(readBE(b, 117, 4)),
  };
}

function writeBE(out: Uint8Array, off: number, x: bigint, size: number): void {
  for (let i = size - 1; i >= 0; i--) {
    out[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("value does not fit");
}

function readBE(b: Uint8Array, off: number, size: number): bigint {
  let x = 0n;
  for (let i = 0; i < size; i++) x = (x << 8n) | BigInt(b[off + i]);
  return x;
}
