// What an order's escrow can re-shield on the source chain (SwapOrderEscrow.refund, spec §7): its own
// asset, and for an ETH order the wrapped native token, which refund() unwraps first. A route that can
// pay anything else back to the escrow (an unfilled bridge deposit of a token a source swap produced,
// a swap surplus swept to the refund address) would leave it there for good (PP-S08), so the adapters
// refuse such routes.
import { WETH } from "./adapters/across";
import type { AssetRef } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Whether `token` (address(0) = native) paid back to the escrow of an order spending `from` would re-shield. */
export function escrowCanReshield(from: AssetRef, token: string): boolean {
  const t = token.toLowerCase();
  if (from.asset === "native") return t === ZERO || t === (WETH[from.chain] ?? ZERO).toLowerCase();
  return t === from.asset.toLowerCase();
}
