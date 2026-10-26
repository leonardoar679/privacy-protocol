// The Classic note (spec v3.0 §7.3; the compatibility matrix §3): `tornado-<currency>-<amount>-<netId>-0x<124 hex>`,
// 62 bytes — a 31-byte nullifier then a 31-byte secret, each little-endian — the only key to a deposit. This module is
// the twin of packages/protocol/src/classic/note.ts, pinned to the same vectors (Stage 6); like the original CLI it reads
// the currency case-insensitively. Pure: format, parse, validate, generate, the backup file's name. The hashing (the
// Pedersen commitment and nullifier hash) arrives with the vendored prover in Stage 6.
export interface ClassicNote {
  currency: string;
  amount: string;
  netId: number;
  nullifier: Uint8Array;
  secret: Uint8Array;
}

export const NOTE_PREFIX = "tornado";
const NOTE_RE = /^tornado-([a-zA-Z0-9]+)-([0-9.]+)-(\d+)-0x([0-9a-fA-F]{124})$/;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

export function formatNote(n: ClassicNote): string {
  if (n.nullifier.length !== 31 || n.secret.length !== 31) throw new Error("a classic note carries a 31-byte nullifier and a 31-byte secret");
  return `${NOTE_PREFIX}-${n.currency.toLowerCase()}-${n.amount}-${n.netId}-0x${hex(n.nullifier)}${hex(n.secret)}`;
}

export type ParsedNote = { ok: true; note: ClassicNote } | { ok: false; reason: "malformed" };

/** The note of a pasted text, or why not. Whitespace around it is ignored; the currency reads case-insensitively. */
export function parseNote(text: string): ParsedNote {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const body = unhex(m[4].toLowerCase());
  return { ok: true, note: { currency: m[1].toLowerCase(), amount: m[2], netId: Number(m[3]), nullifier: body.slice(0, 31), secret: body.slice(31, 62) } };
}

/** A fresh note from 62 random bytes (crypto.getRandomValues in the app; a seeded source in the tests). */
export function generateNote(currency: string, amount: string, netId: number, random: (n: number) => Uint8Array): ClassicNote {
  const bytes = random(62);
  if (bytes.length !== 62) throw new Error("62 random bytes are needed");
  return { currency: currency.toLowerCase(), amount, netId, nullifier: bytes.slice(0, 31), secret: bytes.slice(31, 62) };
}

/** The original's backup file name: backup-tornado-<currency>-<amount>-<netId>-<the note's first 10 hex>.txt */
export function noteFileName(n: ClassicNote): string {
  return `backup-${NOTE_PREFIX}-${n.currency}-${n.amount}-${n.netId}-${hex(n.nullifier).slice(0, 10)}.txt`;
}

/** The little-endian field element of a 31-byte half (the circuit's input; Stage 6). */
export const leBigInt = (b: Uint8Array): bigint => b.reduce((acc, x, i) => acc + (BigInt(x) << BigInt(8 * i)), 0n);
