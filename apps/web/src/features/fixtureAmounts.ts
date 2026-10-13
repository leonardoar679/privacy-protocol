// The fixtures' amounts (spec v2.0 §19): the assets with the registry's display decimals, built from whole and
// fractional parts so a fixture reads like the spec's own figures ("2,470.90 USDC", "≈ 2.31 ETH").
import type { Amount } from "./viewKit";

const pow = (n: number) => 10n ** BigInt(n);
/** `value` written as the spec writes it ("2470.90", "0.176"), in base units of an asset with `decimals`. */
function units(value: string, decimals: number): bigint {
  const [w, f = ""] = value.split(".");
  return BigInt(w) * pow(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export const ETH = (v: string): Amount => ({ units: units(v, 18), decimals: 18, displayDecimals: 6, symbol: "ETH" });
export const USDC = (v: string): Amount => ({ units: units(v, 6), decimals: 6, displayDecimals: 2, symbol: "USDC" });
export const USDT = (v: string): Amount => ({ units: units(v, 6), decimals: 6, displayDecimals: 2, symbol: "USDT" });
export const BTC = (v: string): Amount => ({ units: units(v, 8), decimals: 8, displayDecimals: 6, symbol: "BTC" });
/** USD as the spec writes it ("10000", "4.10") in integer cents. */
export const usd = (v: string): bigint => units(v, 2);
