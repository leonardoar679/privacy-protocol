// The asset registry (doc §20–§21; spec v2.0 §9): the only place a token is named. A deployment adds the vaults it has
// (the protected balance holds an asset only where a canonical vault exists); a token absent from here is
// "unsupported" — no ERC-20 is assumed safe (fee-on-transfer, rebasing and callback-heavy tokens never are).
import type { Asset, AssetStatus, ChainId } from "@privacy-wallet/protocol-types";
import { CHAINS } from "./chains";

const asset = (a: Omit<Asset, "enabled" | "status"> & Partial<Pick<Asset, "enabled" | "status">>): Asset => ({ enabled: true, status: "supported", ...a });

export const ASSETS: readonly Asset[] = [
  // the pool's chain: what can be protected (a vault may hold it) and swapped
  asset({
    id: "eth",
    symbol: "ETH",
    name: "Ether",
    chain: "ethereum",
    decimals: 18,
    displayDecimals: 6,
    icon: "eth",
    privacySupported: true,
    swapSupported: true,
  }),
  asset({
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    chain: "ethereum",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    displayDecimals: 2,
    icon: "usdc",
    privacySupported: true,
    swapSupported: true,
  }),
  asset({
    id: "usdt",
    symbol: "USDT",
    name: "Tether USD",
    chain: "ethereum",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    displayDecimals: 2,
    icon: "usdt",
    privacySupported: true,
    swapSupported: true,
  }),
  // destinations of a cross-chain swap (never held in the protected balance)
  asset({
    id: "btc",
    symbol: "BTC",
    name: "Bitcoin",
    chain: "bitcoin",
    decimals: 8,
    displayDecimals: 6,
    icon: "btc",
    privacySupported: false,
    swapSupported: true,
  }),
  asset({
    id: "sol",
    symbol: "SOL",
    name: "Solana",
    chain: "solana",
    decimals: 9,
    displayDecimals: 4,
    icon: "sol",
    privacySupported: false,
    swapSupported: true,
  }),
  asset({
    id: "usdc-base",
    symbol: "USDC",
    name: "USD Coin on Base",
    chain: "base",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    displayDecimals: 2,
    icon: "usdc",
    privacySupported: false,
    swapSupported: true,
  }),
  asset({
    id: "eth-base",
    symbol: "ETH",
    name: "Ether on Base",
    chain: "base",
    decimals: 18,
    displayDecimals: 6,
    icon: "eth",
    privacySupported: false,
    swapSupported: true,
  }),
];

export const assetById = (id: string): Asset | undefined => ASSETS.find((a) => a.id === id);

/** The registry entry of a token on a chain (`address` null = the native asset), or undefined: an unknown token. */
export const assetOn = (chain: ChainId, address: string | null): Asset | undefined =>
  ASSETS.find((a) => a.chain === chain && (address === null ? a.address === undefined : a.address?.toLowerCase() === address.toLowerCase()));

/** The status a screen shows: the registry's, "temporarily-unavailable" when the deployment has no vault for an asset that
 *  could be protected, "unsupported" for an unknown token. */
export function statusOf(a: Asset | undefined, o: { hasVault?: boolean } = {}): AssetStatus {
  if (!a || !a.enabled) return "unsupported";
  if (a.status !== "supported") return a.status;
  if (a.privacySupported && o.hasVault === false) return "temporarily-unavailable";
  return "supported";
}

/** The label of a destination asset: the symbol on its home chain, else "symbol on Network" ("USDC on Base"). */
const HOME: Record<string, ChainId> = { BTC: "bitcoin", SOL: "solana", ETH: "ethereum", USDC: "ethereum", USDT: "ethereum" };
export const assetLabel = (a: Asset): string => (HOME[a.symbol] === a.chain ? a.symbol : `${a.symbol} on ${CHAINS[a.chain].name}`);

/** The destinations a swap from the pool's chain can reach on another chain (the V5 Swap's four targets). */
export const crossChainTargets = (): Asset[] =>
  ASSETS.filter((a) => a.swapSupported && a.enabled && a.chain !== "ethereum" && a.chain !== "sepolia" && a.chain !== "local");
