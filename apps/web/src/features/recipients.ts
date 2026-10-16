// The addresses the Send and Swap screens refuse as destinations (a V6 follow-up of 2026-10-16): the deployment's own
// contracts and tokens (packages/sdk/src/recipients.ts) and the registry's tokens on the deployment's chain — a token sent
// to its own contract cannot come back — besides the zero and the burn address the parsers always refuse.
import { ASSETS, CHAINS } from "@privacy-wallet/config";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { knownAddresses } from "@privacy-wallet/sdk/recipients";
import type { KnownAddress } from "@privacy-wallet/protocol/wallet/destinations";

export function knownRecipients(d: Deployment | null): KnownAddress[] {
  if (!d) return [];
  const tokens = ASSETS.filter((a) => a.address && CHAINS[a.chain as keyof typeof CHAINS]?.chainId === d.chainId).map((a) => ({
    address: a.address as string,
    symbol: a.symbol,
  }));
  return knownAddresses(d, tokens);
}
