// The pool's vault of each refund token of a signed provider call (the twelfth review round, C12-4's critiques XB and XC): what tells a step's refund
// in another token than the order's — a note in one of these vaults at that token's floor — from a note anyone holding the order's payload can
// make in any vault. The hand-over journals it beside the refund tokens; the runners and the scan derive it for a journal kept before that. And
// the refund tokens themselves as the executor re-shields them (refundTokensOf: wrapped ETH beside a refund token of address(0), XF's critique).
import { WRAPPED_NATIVE_OF } from "@privacy-wallet/contracts/deployments";
import type { Deployment } from "./chain";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Each refund token's vault, by the vault's lower case, with the token's floor (the call's `refundFloors` are keyed by the token's lower case:
 * providerCall.ts floorOf). Wrapped ETH — and ETH itself — re-shields as ETH: the escrow's refundToken unwraps it into the pool's native vault
 * (SwapOrderEscrow.sol refundToken; providerCall.ts asEth); only an ERC-20 order names it a refund token (XC's critique: the native vault had been
 * left out, and an unfilled Across or LI.FI leg's WETH refund, back as ETH, was no refund of the step). A token the pool has no vault for: none.
 */
export function refundVaultsOf(d: Deployment | null, tokens: readonly string[], floors: Record<string, string> = {}): Record<string, string> {
  if (!d) return {};
  const weth = WRAPPED_NATIVE_OF[d.chainId]?.toLowerCase();
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const t = token.toLowerCase();
    const vault = t === weth || t === ZERO ? d.ethVault : (d.erc20Vaults ?? []).find((v) => v.token.toLowerCase() === t)?.vault;
    if (vault) out[vault.toLowerCase()] = floors[t] ?? floors[token] ?? "1";
  }
  return out;
}

/**
 * An order's refund tokens as the executor re-shields them, and its Return funds returns them: the route's, with the chain's wrapped ETH beside a
 * refund token of address(0) for an ERC-20 order, at that token's floor (the twelfth review round, XF's critique). An unfilled Across deposit of ETH
 * comes back to the escrow as WETH, which refundToken(address(0)) never unwraps: unlisted, the executor never re-shielded it and a Return funds
 * asked for nothing, and the order, read as a late refund, stayed open for good — a campaign sent an empty refund-only job at each Resume. Listed,
 * refundToken(WETH) unwraps it into the pool's ETH vault (the relayer takes it: not the order's asset, a floor above zero). A journal kept before
 * the hand-over listed it names address(0) alone: its readers derive WETH here. Anything else as given.
 */
export function refundTokensOf(
  chainId: number | undefined,
  orderAsset: string | undefined,
  tokens: readonly string[] | undefined,
  floors: Record<string, string> | undefined,
): { refundTokens: string[] | undefined; refundFloors: Record<string, string> | undefined } {
  const weth = chainId !== undefined ? WRAPPED_NATIVE_OF[chainId] : undefined;
  const erc20Order = !!orderAsset && orderAsset !== "native" && orderAsset.toLowerCase() !== ZERO;
  const ethFloor = floors?.[ZERO];
  const add =
    !!weth &&
    erc20Order &&
    ethFloor !== undefined &&
    !!tokens?.some((t) => t.toLowerCase() === ZERO) &&
    !tokens.some((t) => t.toLowerCase() === weth.toLowerCase());
  return add
    ? { refundTokens: [...tokens!, weth!], refundFloors: { ...floors, [weth!.toLowerCase()]: ethFloor! } }
    : { refundTokens: tokens ? [...tokens] : undefined, refundFloors: floors };
}
