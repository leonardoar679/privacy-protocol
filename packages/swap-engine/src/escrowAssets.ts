// What an order's escrow can re-shield on the source chain (SwapOrderEscrow, spec §7): through
// refund(), its own asset (an ETH order also unwraps WETH); through refundToken(), for an ERC-20 order
// ETH and WETH as ETH into the pool's native vault (the escrow unwraps the WETH), and any other token
// into that token's canonical vault, which the wallet can only see and spend if the pool has it
// configured (ERC20_VAULTS, the same setting as the engine's refund vaults). A route that can pay
// anything else back to the escrow (an unfilled bridge deposit of a token a source swap produced, a
// swap surplus swept to the refund address) would leave it where nobody re-shields it (PP-S08), so
// the adapters refuse such routes, and report the foreign asset of a route they accept so that the
// executor re-shields it through refundToken.
import { WETH } from "./adapters/across";
import type { AssetRef } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";

/** The tokens the pool has a configured canonical vault for (ERC20_VAULTS="0xtoken:0xvault,…"). */
export function pooledTokens(setting = process.env.ERC20_VAULTS ?? ""): Set<string> {
  return new Set(setting.split(",").map((e) => e.split(":")[0]?.trim().toLowerCase()).filter((t): t is string => !!t && /^0x[0-9a-f]{40}$/.test(t)));
}

/** Whether `token` re-shields through refund(): the order's asset, or for an ETH order the wrapped native token. */
const ownAsset = (from: AssetRef, t: string) => (from.asset === "native" ? t === ZERO || t === (WETH[from.chain] ?? ZERO).toLowerCase() : t === from.asset.toLowerCase());

/** Whether `token` re-shields as ETH through refundToken(): for an ERC-20 order, ETH itself and the wrapped native token (unwrapped first). */
const asEth = (from: AssetRef, t: string) => from.asset !== "native" && (t === ZERO || t === (WETH[from.chain] ?? ZERO).toLowerCase());

/** Whether `token` (address(0) = native) paid back to the escrow of an order spending `from` would re-shield. */
export function escrowCanReshield(from: AssetRef, token: string, pooled = pooledTokens()): boolean {
  const t = token.toLowerCase();
  return ownAsset(from, t) || asEth(from, t) || (t !== ZERO && pooled.has(t));
}

/**
 * The paid-back assets that need refundToken (not the order's asset; for an ETH order not ETH or WETH):
 * what the executor is told to watch. address(0) is the escrow's own ETH, listed for an ERC-20 order.
 */
export const foreignRefundTokens = (from: AssetRef, tokens: string[]): string[] =>
  [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !ownAsset(from, t));
