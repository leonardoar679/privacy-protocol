// The addresses the Send and Swap screens refuse as destinations (a V6 follow-up of 2026-10-16): the deployment's own
// contracts and tokens (packages/sdk/src/recipients.ts) and the registry's tokens on the deployment's chain — a token sent
// to its own contract cannot come back — besides the zero and the burn address the parsers always refuse.
import { ASSETS, CHAINS } from "@privacy-wallet/config";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { knownAddresses } from "@privacy-wallet/sdk/recipients";
import type { KnownAddress } from "@privacy-wallet/protocol/wallet/destinations";

/**
 * A guest's Ethereum destination (walletless: no deployment; the twelfth review round, F12-8) is never a registry token's own contract — the
 * swap screens refuse them, and THORChain had paid a guest's USDC to the USDC contract, lost.
 */
export function guestKnownRecipients(): KnownAddress[] {
  return ASSETS.filter((a) => a.address && a.chain === "ethereum").map((a) => ({ address: a.address as string, kind: "token" as const, symbol: a.symbol }));
}

export function knownRecipients(d: Deployment | null): KnownAddress[] {
  if (!d) return [];
  const tokens = ASSETS.filter((a) => a.address && CHAINS[a.chain as keyof typeof CHAINS]?.chainId === d.chainId).map((a) => ({
    address: a.address as string,
    symbol: a.symbol,
  }));
  return knownAddresses(d, tokens);
}
