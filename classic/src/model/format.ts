import { keccak256 } from "js-sha3";
// Amounts, hashes and addresses as the screens show them: wei to a fixed number of decimals (the original's
// toDecimals), gwei with one decimal, a shortened hash.
const WEI = 1_000_000_000_000_000_000n;
const GWEI = 1_000_000_000n;

/** `wei` as a decimal string with at most `fixed` decimals, trailing zeros trimmed, never a float. */
export function toDecimals(wei: bigint, decimals = 18, fixed = 6): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let frac = (abs % unit).toString().padStart(decimals, "0").slice(0, fixed).replace(/0+$/, "");
  if (frac.length) frac = "." + frac;
  return `${negative ? "-" : ""}${whole.toString()}${frac}`;
}

export const fromWei = (wei: bigint, fixed = 6): string => toDecimals(wei, 18, fixed);

/** wei as gwei with one decimal ("12.5"). */
export function toGwei(wei: bigint): string {
  const tenths = (wei * 10n) / GWEI;
  return `${tenths / 10n}.${tenths % 10n}`;
}

export const weiOfEth = (eth: string): bigint => {
  const [whole, frac = ""] = eth.split(".");
  return BigInt(whole || "0") * WEI + BigInt((frac + "0".repeat(18)).slice(0, 18));
};

/** 0x1234…abcd */
export const shortHash = (h: string, head = 6, tail = 4): string => (h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);

/** A thousands-separated count ("96,432"). */
export const formatCount = (n: number, locale = "en-US"): string => new Intl.NumberFormat(locale).format(n);

/**
 * An Ethereum address: 20 bytes of hex — and, when it carries both cases, a correct EIP-55 checksum (the review round of
 * 2026-11-03, C2-1: the original's web3-utils check; a mistyped character in a checksummed address had been accepted as the
 * proof's recipient, which nothing can undo). All-lower or all-upper hex carries no checksum and passes as before.
 */
/** An address in its EIP-55 spelling: the confirmation restates the proof's recipient so (the tenth review round, C10-1). */
export const toChecksumAddress = (address: string): string => {
  const hex = address.trim().slice(2).toLowerCase();
  const hash = keccak256(hex);
  return "0x" + Array.from(hex, (c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
};

export const isAddress = (s: string): boolean => {
  const a = s.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const hex = a.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = keccak256(hex.toLowerCase());
  for (let i = 0; i < 40; i++) {
    const upper = parseInt(hash[i], 16) >= 8;
    if (hex[i] !== (upper ? hex[i].toUpperCase() : hex[i].toLowerCase())) return false;
  }
  return true;
};
