// The API's ids (spec v2.0 §15): `op_` / `qt_` and the base32 (RFC 4648, lower case, no padding) of 16 random bytes.
// An operation id is a bearer capability — there is no listing endpoint, and the on-chain order id never appears in a URL.
import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 in lower case, without padding (16 bytes → 26 characters). */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export const OPERATION_ID = /^op_[a-z2-7]{26}$/;
export const QUOTE_ID = /^qt_[a-z2-7]{26}$/;

export const newId = (prefix: "op" | "qt", random: (n: number) => Uint8Array = randomBytes): string => `${prefix}_${base32(random(16))}`;
