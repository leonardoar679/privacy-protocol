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

/** The pool's Ethereum tokens this engine knows by address (the registry's, packages/config): what a pooled token is. */
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
};

/**
 * What `token` is when it comes back to the escrow of an order spending `from` and re-shields: ETH (ETH and WETH), the order's own
 * asset as the request names it, a pooled token as KNOWN_TOKENS names it. Undefined when it does not re-shield, or is a pooled token
 * this engine does not know: the floor checks of a swap before a bridge need its asset and decimals.
 */
export function reshieldableAsset(from: AssetRef, token: string, pooled = pooledTokens()): { symbol: string; decimals: number } | undefined {
  const t = token.toLowerCase();
  if (!escrowCanReshield(from, t, pooled)) return undefined;
  if (t === ZERO || t === (WETH[from.chain] ?? ZERO).toLowerCase()) return { symbol: "ETH", decimals: 18 };
  if (from.asset !== "native" && t === from.asset.toLowerCase()) return { symbol: from.symbol, decimals: from.decimals };
  return KNOWN_TOKENS[t];
}

/**
 * Whether a floor in one asset counts for an output in another: ETH and WETH are one asset, and so are the dollar stablecoins
 * USDC and USDT (LI.FI routes USDC on Base through a USDT deposit, 2026-10). Anything else only counts for itself.
 */
export const sameAsset = (a: string, b: string) => { const n = (s: string) => (/^w?eth$/i.test(s) ? "ETH" : /^usd[ct]$/i.test(s) ? "USD" : s.toUpperCase()); return n(a) === n(b); };

/** Whether `floor` (with `floorDecimals`) covers `out` (with `outDecimals`) of the same asset. */
export const covers = (floor: bigint, floorDecimals: number, out: bigint, outDecimals: number) => out * 10n ** BigInt(floorDecimals) <= floor * 10n ** BigInt(outDecimals);

/**
 * The paid-back assets that need refundToken (not the order's asset; for an ETH order not ETH or WETH):
 * what the executor is told to watch. address(0) is the escrow's own ETH, listed for an ERC-20 order.
 */
export const foreignRefundTokens = (from: AssetRef, tokens: string[]): string[] =>
  [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !ownAsset(from, t));
