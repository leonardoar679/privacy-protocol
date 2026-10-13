// The asset (doc §20–§21; spec v2.0 §9). The registry (packages/config/src/assets.ts) is the only place a token appears;
// components never hard-code one. No ERC-20 is assumed safe: an unknown token is "unsupported".
import type { Address, ChainId } from "./primitives";

/** supported; temporarily unavailable (its vault or every route is down); unsupported (unknown, fee-on-transfer, rebasing, callback-heavy) */
export type AssetStatus = "supported" | "temporarily-unavailable" | "unsupported";
export const ASSET_STATUSES: readonly AssetStatus[] = ["supported", "temporarily-unavailable", "unsupported"];

export interface Asset {
  /** stable id, lowercase: "eth", "usdc", "usdc-base", "btc" */
  id: string;
  symbol: string;
  name: string;
  chain: ChainId;
  /** the token contract on an EVM chain; absent for a chain's native asset */
  address?: Address;
  decimals: number;
  /** how many decimals the screens show (AmountText): 6 for ETH, 2 for a dollar stablecoin, 8 for BTC */
  displayDecimals: number;
  /** the icon's id in packages/ui's asset icons */
  icon: string;
  /** can be protected: a canonical vault may hold it */
  privacySupported: boolean;
  /** can be a swap's source or destination */
  swapSupported: boolean;
  enabled: boolean;
  status: AssetStatus;
}
