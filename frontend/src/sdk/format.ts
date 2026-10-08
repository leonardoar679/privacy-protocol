// Amount text from base units without floating point (plan V2 §43: an eight-figure balance must be
// exact; `Number(units) / 10 ** decimals` is not). `fmtUnits` keeps a fixed number of places (what a
// quote line shows); viem's formatUnits (sdk/assets.ts formatAmount) trims for balances.
import { parseUnits } from "viem";

/** `units` in whole units of the asset with exactly min(places, decimals) fraction digits, truncated (never rounded up). */
export function fmtUnits(units: bigint | string, decimals: number, places = 6): string {
  let u: bigint;
  try { u = BigInt(units); } catch { return "n/a"; }
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const p = Math.max(0, Math.min(places, decimals));
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, p);
  return `${neg ? "-" : ""}${whole}${p ? `.${frac}` : ""}`;
}

/** The user's decimal text as base units; 0 for anything unparsable (the screens disable their buttons at 0). */
export function parseUnitsSafe(text: string, decimals: number): bigint {
  try { return parseUnits((text || "0").trim(), decimals); } catch { return 0n; }
}

/** A short form of a hash / address / order id for a list row. */
export const shortRef = (s: string, head = 10, tail = 4): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
