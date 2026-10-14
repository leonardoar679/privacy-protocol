// The wallet's own view of a swap execution's gas (Privacy Wallet Web spec v2.0 §3): the same units and formula as the
// swap service's executor tip (@privacy-wallet/contracts executionUnits, gasCeilingWei), the fees from this wallet's own
// RPC (eth_feeHistory), an ERC-20's cost at this wallet's agreed prices. The order guard refuses a tip more than three
// times this estimate (swapGuard.checkOrder maxTip); without a fee read or a price there is no estimate, and the
// escrow's 1 % cap stands alone.
import { executionUnits, gasCeilingWei, type GasFees } from "@privacy-wallet/contracts";
import { weiInAsset, type Prices } from "@privacy-wallet/protocol/wallet/valuation";
import type { Asset } from "./assets";
import { clientFor, type Deployment } from "./chain";
import { priceStore } from "./prices";

/** A tip above this many times the wallet's own estimate is refused. */
export const TIP_CEILING_MULTIPLE = 3n;

/** The next block's base fee and the median priority fee of the last five blocks, from this wallet's RPC. */
export async function feesOf(deployment: Deployment): Promise<GasFees> {
  const h = await clientFor(deployment).getFeeHistory({ blockCount: 5, rewardPercentiles: [50] });
  const rewards = (h.reward ?? []).map((r) => r[0] ?? 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { baseFeePerGas: h.baseFeePerGas[h.baseFeePerGas.length - 1] ?? 0n, priorityFeePerGas: rewards.length ? rewards[rewards.length >> 1] : 0n };
}

/** This wallet's estimate of an order's execution gas, in the order's asset; null without a fee read or a needed price. */
export async function executionCostIn(deployment: Deployment, asset: Asset, prices: Prices | null = priceStore.state().prices): Promise<bigint | null> {
  let fees: GasFees;
  try {
    fees = await feesOf(deployment);
  } catch {
    return null;
  }
  const native = asset.token === null;
  return weiInAsset(gasCeilingWei(executionUnits(!native), fees), { symbol: asset.symbol, decimals: asset.decimals, native }, prices);
}

/** The most an order's tip may be: three times this wallet's own estimate; null when the wallet cannot estimate. */
export async function tipCeiling(deployment: Deployment, asset: Asset, prices?: Prices | null): Promise<bigint | null> {
  const cost = await executionCostIn(deployment, asset, prices);
  return cost === null ? null : cost * TIP_CEILING_MULTIPLE;
}
