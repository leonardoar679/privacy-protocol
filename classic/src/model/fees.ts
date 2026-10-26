// Classic's own fee lines (spec v3.0 §7.5; the owner's rule: no 1 % privacy fee in Classic): the relayer's service fee
// as a share of the denomination, the network fee at the LIVE gas price over the original's 550,000 gas estimate, their
// total, and what the recipient receives — integer wei throughout, never a float.
import type { FeeLines, RelayerInfo } from "./types";
import type { Pool } from "./pools";

/** The gas the original interface priced a relayed withdrawal at. */
export const WITHDRAW_GAS = 550_000n;
/** The relayer's own minimum uses 390,000 gas (the compatibility matrix §4): a fee below it is refused, never offered. */
export const RELAYER_MIN_GAS = 390_000n;
const E4_PERCENT = 1_000_000n; // percent × 10,000 → a share of 1: divide by 100 × 10,000

export function feeLines(pool: Pool, relayer: Pick<RelayerInfo, "feePercentE4">, gasPriceWei: bigint): FeeLines {
  const networkFeeWei = gasPriceWei * WITHDRAW_GAS;
  const relayerFeeWei = (pool.denominationWei * BigInt(relayer.feePercentE4)) / E4_PERCENT;
  const totalFeeWei = networkFeeWei + relayerFeeWei;
  return { gasPriceWei, networkFeeWei, relayerFeeWei, totalFeeWei, receiveWei: pool.denominationWei - totalFeeWei };
}

/** The least fee the relayer accepts for this withdrawal (its own rule); the offered total must not fall below it. */
export const relayerMinimumWei = (pool: Pool, relayer: Pick<RelayerInfo, "feePercentE4">, gasPriceWei: bigint): bigint =>
  gasPriceWei * RELAYER_MIN_GAS + (pool.denominationWei * BigInt(relayer.feePercentE4)) / E4_PERCENT;

/** The relayer's service fee cap the original schema applied: 20 %. */
export const MAX_FEE_PERCENT_E4 = 20 * 10_000;
