// The wallet's own view of a swap execution's gas (Privacy Wallet Web spec v2.0 §3): the same units and formula as the
// swap service's executor tip (@privacy-wallet/contracts executionUnits, gasCeilingWei), the fees from this wallet's own
// RPC (eth_feeHistory), an ERC-20's cost at this wallet's agreed prices — the current read's, else the last good read of
// the past day (the tier's fail-safe memory). The order guard refuses a tip more than three times this estimate
// (swapGuard.checkOrder maxTip). Without a fee read or a price there is no estimate, and no order is committed
// (CostUnknown; audit round 2, critic gap 4): the escrow's 1 % cap alone had let a swap service set a 1 % tip whenever one
// RPC endpoint failed a price read.
import { GAS_UNITS, executionUnits, gasCeilingWei, type GasFees } from "@privacy-wallet/contracts";
import { weiInAsset, type Prices } from "@privacy-wallet/protocol/wallet/valuation";
import type { Asset } from "./assets";
import { clientFor, type Deployment } from "./chain";
import { priceStore } from "./prices";

/** A tip above this many times the wallet's own estimate is refused. */
export const TIP_CEILING_MULTIPLE = 3n;

/** The wallet could not estimate a swap's gas (no fee read, or no agreed price of the past day): nothing is committed. */
export class CostUnknown extends Error {
  readonly code = "cost_unknown";
  constructor() {
    super(
      "This wallet could not read the network fees or prices it needs to check this swap's execution fee, so the swap was not set up. Nothing was sent. Try again in a moment.",
    );
    this.name = "CostUnknown";
  }
}

/** The next block's base fee and the median priority fee of the last five blocks, from this wallet's RPC. */
export async function feesOf(deployment: Deployment): Promise<GasFees> {
  const h = await clientFor(deployment).getFeeHistory({ blockCount: 5, rewardPercentiles: [50] });
  const rewards = (h.reward ?? []).map((r) => r[0] ?? 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { baseFeePerGas: h.baseFeePerGas[h.baseFeePerGas.length - 1] ?? 0n, priorityFeePerGas: rewards.length ? rewards[rewards.length >> 1] : 0n };
}

/** This wallet's estimate of an order's execution gas, in the order's asset; null without a fee read or a needed price (the
 *  current read's, else `last`: the last good read of the past day). */
export async function executionCostIn(
  deployment: Deployment,
  asset: Asset,
  prices: Prices | null = priceStore.state().prices,
  last: Prices | null = priceStore.lastGood(),
): Promise<bigint | null> {
  let fees: GasFees;
  try {
    fees = await feesOf(deployment);
  } catch {
    return null;
  }
  const native = asset.token === null;
  const wei = gasCeilingWei(executionUnits(!native), fees);
  const of = { symbol: asset.symbol, decimals: asset.decimals, native };
  return weiInAsset(wei, of, prices) ?? weiInAsset(wei, of, last);
}

/** The most an order's tip may be: three times this wallet's own estimate; null when the wallet cannot estimate. */
export async function tipCeiling(deployment: Deployment, asset: Asset, prices?: Prices | null): Promise<bigint | null> {
  const cost = await executionCostIn(deployment, asset, prices);
  return cost === null ? null : cost * TIP_CEILING_MULTIPLE;
}

/** V6 Stage 12 (spec v2.0 §11.2): the most a same-chain swap's shield tip may be — three times this wallet's own estimate
 *  of the receiver's deployment and deposit, in the output asset; null when the wallet cannot estimate. */
export async function shieldTipCeiling(
  deployment: Deployment,
  out: { symbol: string; decimals: number; asset: string },
  prices: Prices | null = priceStore.state().prices,
  last: Prices | null = priceStore.lastGood(),
): Promise<bigint | null> {
  let fees: GasFees;
  try {
    fees = await feesOf(deployment);
  } catch {
    return null;
  }
  const native = out.asset === "native";
  const wei = gasCeilingWei(native ? GAS_UNITS.shieldETH : GAS_UNITS.shieldERC20, fees);
  const of = { symbol: out.symbol, decimals: out.decimals, native };
  const cost = weiInAsset(wei, of, prices) ?? weiInAsset(wei, of, last);
  return cost === null ? null : cost * TIP_CEILING_MULTIPLE;
}
