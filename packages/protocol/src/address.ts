// Privacy address — what a sender needs to pay someone privately: their owner commitment (spec §4,
// the receiving address inside notes) and their view public key (envelope.ts, to encrypt the
// payload). Wallet-level convention (the core knows only owner commitments): bech32m (BIP-350),
// human-readable part "pp", data = version 0x01 ‖ ownerCommitment (32 bytes, big-endian) ‖ viewPub
// (32 bytes). Typo-resistant (the checksum detects any 4 errors), case-insensitive, 113 characters.
import { x25519 } from "@noble/curves/ed25519";
import { FIELD } from "./field";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;
export const ADDRESS_HRP = "pp";
export const ADDRESS_VERSION = 0x01;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string): number[] => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function createChecksum(hrp: string, data: number[]): number[] {
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  return Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
}
function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < 0 || v >> from) throw new Error("invalid value");
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error("invalid padding");
  return out;
}

export function bech32mEncode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  return hrp + "1" + [...data, ...createChecksum(hrp, data)].map((d) => CHARSET[d]).join("");
}

export function bech32mDecode(s: string): { hrp: string; bytes: Uint8Array } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error("mixed-case address");
  const str = s.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length) throw new Error("malformed address");
  const hrp = str.slice(0, pos);
  const data = [...str.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error("invalid character");
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new Error("bad checksum");
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

const be32 = (v: bigint): Uint8Array => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const fromBe = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);

export function encodePrivacyAddress(ownerCommitment: bigint, viewPub: Uint8Array): string {
  if (viewPub.length !== 32) throw new Error("view public key must be 32 bytes");
  const payload = new Uint8Array(65);
  payload[0] = ADDRESS_VERSION;
  payload.set(be32(ownerCommitment), 1);
  payload.set(viewPub, 33);
  return bech32mEncode(ADDRESS_HRP, payload);
}

/** Any scalar: a low-order point times a clamped one is the identity, which X25519 reads as an all-zero secret. */
const PROBE = new Uint8Array(32).fill(0x42);
/** A view key a payment can be encrypted to: never a low-order point, whose shared secret is the same for every sender. */
function contributory(viewPub: Uint8Array): boolean {
  try {
    return x25519.getSharedSecret(PROBE, viewPub).some((b) => b !== 0);
  } catch {
    return false;
  }
}

/**
 * Refused at the decode (audit round 2, n29/n30): an owner commitment at or past the field, which the Rust decoder refuses
 * (one recipient had two strings, and the web and native wallets disagreed on one address), and a view key no payment can
 * be encrypted to privately — it failed only at the encryption, after the Send's merges had paid their fees.
 */
export function decodePrivacyAddress(s: string): { version: number; ownerCommitment: bigint; viewPub: Uint8Array } {
  const { hrp, bytes } = bech32mDecode(s.trim());
  if (hrp !== ADDRESS_HRP) throw new Error(`not a privacy address (hrp ${hrp})`);
  if (bytes.length !== 65) throw new Error("wrong length");
  if (bytes[0] !== ADDRESS_VERSION) throw new Error(`unsupported address version ${bytes[0]}`);
  const ownerCommitment = fromBe(bytes.subarray(1, 33));
  if (ownerCommitment >= FIELD) throw new Error("its owner commitment is not a field element");
  const viewPub = bytes.slice(33, 65);
  if (!contributory(viewPub)) throw new Error("its view key is a low-order point: no payment to it could be private");
  return { version: bytes[0], ownerCommitment, viewPub };
}
