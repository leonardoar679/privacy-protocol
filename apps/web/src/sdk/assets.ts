// The wallet's private assets (plan §36: ETH first, then the ERC-20s whose canonical vaults the
// deployment names): one vault per asset, nothing shared, a stablecoin issuer's freeze reaches only
// its own vault (plan §59). ETH comes from the deployment; ERC-20s from VITE_ERC20_VAULTS =
// "USDC:0xtoken:0xvault:6,USDT:0xtoken:0xvault:6". Amount formatting and the public bucket alphabet
// follow the asset's decimals.
import { formatUnits, parseUnits, type Address } from "viem";
import { bucketsFor, isBucketOf } from "@ref/wallet/amounts";
import type { Deployment } from "./chain";

export interface Asset {
  symbol: string;
  decimals: number;
  vault: Address;
  /** null for native ETH */
  token: Address | null;
}

export interface Erc20Asset extends Asset { token: Address }

export function parseErc20Vaults(spec: string | undefined): Erc20Asset[] {
  if (!spec) return [];
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [symbol, token, vault, decimals] = entry.split(":").map((x) => x.trim());
    if (!symbol || !/^0x[0-9a-fA-F]{40}$/.test(token ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(vault ?? "") || !/^\d+$/.test(decimals ?? "")) throw new Error(`VITE_ERC20_VAULTS entry "${entry}" must be SYMBOL:0xtoken:0xvault:decimals`);
    return { symbol, token: token as Address, vault: vault as Address, decimals: Number(decimals) };
  });
}

export function assetsOf(d: Deployment | null): Asset[] {
  if (!d) return [{ symbol: "ETH", decimals: 18, vault: "0x0000000000000000000000000000000000000000", token: null }];
  return [{ symbol: "ETH", decimals: 18, vault: d.ethVault, token: null }, ...d.erc20Vaults];
}

export const assetByVault = (d: Deployment | null, vault: bigint | string): Asset | undefined =>
  assetsOf(d).find((a) => BigInt(a.vault) === BigInt(vault));

export const formatAmount = (a: Asset, units: bigint): string => formatUnits(units, a.decimals);
export const parseAmount = (a: Asset, text: string): bigint => { try { return parseUnits(text || "0", a.decimals); } catch { return 0n; } };

/** The largest public bucket not above `units` for this asset (plan §31), or null below the smallest bucket. */
export function bucketBelowFor(a: Asset, units: bigint): bigint | null {
  let best: bigint | null = null;
  for (const b of bucketsFor(a.decimals)) if (b <= units && (best === null || b > best)) best = b;
  return best;
}
export const isBucketFor = (a: Asset, units: bigint): boolean => isBucketOf(units, a.decimals);
