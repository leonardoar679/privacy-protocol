// The Classic pool's note (Privacy Wallet Web spec §16; plan §32–§33): `tornado-<currency>-<amount>-<netId>-0x<124 hex>`,
// 62 bytes — a 31-byte nullifier then a 31-byte secret, each little-endian — the only key to a classic deposit; it
// cannot be recovered. Pure: format, parse, validate, generate; the proving arrives with the circuit port.
export interface ClassicNote { currency: string; amount: string; netId: number; nullifier: Uint8Array; secret: Uint8Array }

export const NOTE_PREFIX = "tornado";
const NOTE_RE = /^tornado-([a-z0-9]+)-([0-9.]+)-(\d+)-0x([0-9a-fA-F]{124})$/;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

export function formatNote(n: ClassicNote): string {
  if (n.nullifier.length !== 31 || n.secret.length !== 31) throw new Error("a classic note carries a 31-byte nullifier and a 31-byte secret");
  return `${NOTE_PREFIX}-${n.currency.toLowerCase()}-${n.amount}-${n.netId}-0x${hex(n.nullifier)}${hex(n.secret)}`;
}

export type ParsedNote = { ok: true; note: ClassicNote } | { ok: false; reason: string };

export function parseNote(text: string): ParsedNote {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return { ok: false, reason: "not a classic note: expected tornado-<currency>-<amount>-<netId>-0x<124 hex characters>" };
  const body = unhex(m[4].toLowerCase());
  return { ok: true, note: { currency: m[1], amount: m[2], netId: Number(m[3]), nullifier: body.slice(0, 31), secret: body.slice(31, 62) } };
}

/** The note against a pool: the currency, the amount and the network must be the pool's. */
export function validateNote(n: ClassicNote, pool: { currency: string; amount: string; netId: number }): string | null {
  if (n.currency.toLowerCase() !== pool.currency.toLowerCase()) return `the note is a ${n.currency.toUpperCase()} note; this pool is ${pool.currency.toUpperCase()}`;
  if (n.amount !== pool.amount) return `the note is for ${n.amount} ${n.currency.toUpperCase()}; this pool is the ${pool.amount} ${pool.currency.toUpperCase()} pool`;
  if (n.netId !== pool.netId) return `the note is for network ${n.netId}; this pool is on network ${pool.netId}`;
  return null;
}

/** A fresh note from 62 random bytes (the CSPRNG in the wallet, a seeded source in tests). */
export function generateNote(currency: string, amount: string, netId: number, random: (n: number) => Uint8Array): ClassicNote {
  const bytes = random(62);
  if (bytes.length !== 62) throw new Error("62 random bytes are needed");
  return { currency: currency.toLowerCase(), amount, netId, nullifier: bytes.slice(0, 31), secret: bytes.slice(31, 62) };
}

/** The little-endian field elements of the note's two halves (the circuit's inputs, when the port arrives). */
export const leBigInt = (b: Uint8Array): bigint => b.reduce((acc, x, i) => acc + (BigInt(x) << BigInt(8 * i)), 0n);
