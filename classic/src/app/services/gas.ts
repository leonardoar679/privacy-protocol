// The gas price, live (spec v3.0 §7.5; the repository's rule: never a constant): eth_gasPrice from the configured
// endpoints, refused when it is zero or absurd.
import type { Rpc } from "../../history/sync";

export const MAX_GAS_PRICE_WEI = 10_000n * 10n ** 9n;

export async function gasPriceWei(rpc: Rpc): Promise<bigint> {
  const out = (await rpc("eth_gasPrice", [])) as string;
  if (typeof out !== "string" || !/^0x[0-9a-fA-F]+$/.test(out)) throw new Error("the endpoint answered no gas price");
  const wei = BigInt(out);
  if (wei <= 0n || wei > MAX_GAS_PRICE_WEI) throw new Error("the endpoint's gas price is not credible");
  return wei;
}
