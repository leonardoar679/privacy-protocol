// The network cost of a protect (spec §3.4): eth_estimateGas × the connected wallet's own gas price, read through
// that wallet's provider at render time with a scratch note — never a constant, never through this wallet's RPCs
// (no address ↔ endpoint link) — and converted with the wallet's price read. Null when the provider, the account or
// the estimate is unavailable: the screen then says "read at confirmation".
import { availablePrice, usdOf } from "@privacy-wallet/protocol/wallet/valuation";
import type { Address } from "viem";
import type { Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { scratchShieldTx } from "@privacy-wallet/sdk/privateTx";
import { GAS_UNITS } from "@privacy-wallet/contracts";
import type { PriceState } from "@privacy-wallet/sdk/prices";

export interface NetworkEstimate { gas: bigint; feePerGasWei: bigint; wei: bigint }

const hexToBigInt = (x: unknown): bigint | null => (typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x) ? BigInt(x) : null);

/**
 * The deposit's gas × the provider's gas price. An ERC-20 deposit before its approval cannot be simulated: forge's
 * measured units of the path stand in for it (V6: @privacy-wallet/contracts GAS_UNITS — through ProtectRouter or straight
 * into the vault), beside the approval's own estimate.
 */
export async function estimateShieldCost(deployment: Deployment, asset: Pick<Asset, "token" | "vault">, amount: bigint, account: string | null): Promise<NetworkEstimate | null> {
  const eth = activeProvider();
  if (!eth || !account || amount <= 0n) return null;
  const { approve, deposit } = scratchShieldTx(deployment, amount, asset.token, asset.vault as Address);
  const call = (tx: { to: Address; data: `0x${string}`; value?: bigint }) =>
    eth.request({ method: "eth_estimateGas", params: [{ from: account, to: tx.to, data: tx.data, ...(tx.value ? { value: "0x" + tx.value.toString(16) } : {}) }] }).then(hexToBigInt).catch(() => null);
  const [gasDeposit, gasApprove, price] = await Promise.all([call(deposit), approve ? call(approve) : Promise.resolve(0n), eth.request({ method: "eth_gasPrice" }).then(hexToBigInt).catch(() => null)]);
  const pinned = deployment.protectRouter ? (asset.token ? GAS_UNITS.protectERC20 : GAS_UNITS.protectETH) : GAS_UNITS.deposit;
  const gas = gasDeposit !== null ? gasDeposit + (gasApprove ?? 0n) : asset.token && gasApprove && gasApprove > 0n ? pinned + gasApprove : null;
  if (gas === null || price === null) return null;
  return { gas, feePerGasWei: price, wei: gas * price };
}

/** The estimate in USD from the wallet's ETH price read; null without a price. */
export function estimateUsd(e: NetworkEstimate | null, prices: PriceState): number | null {
  if (!e) return null;
  const p = availablePrice(prices.prices, "ETH");
  return p ? usdOf(e.wei, 18, p.usd1e8) : null;
}
