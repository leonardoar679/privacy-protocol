// The addresses a payment must not go to (a V6 follow-up of 2026-10-16): this deployment's own contracts and the tokens it
// holds, besides the burn addresses `refusedRecipient` knows. The Send and Swap screens refuse them as destinations (with
// the registry's tokens added), and a private withdrawal refuses them again before anything is proved or sent.
import type { Address } from "viem";
import { refusedRecipient, type KnownAddress } from "@privacy-wallet/protocol/wallet/destinations";
import type { Deployment } from "./chain";

/** The deployment's contracts and its tokens' contracts, with `tokens` (the registry's, from the app) added. */
export function knownAddresses(d: Deployment | null, tokens: readonly { address: string; symbol: string }[] = []): KnownAddress[] {
  if (!d) return [];
  const protocol = [d.core, d.ethVault, d.protectRouter, d.swapFactory, d.shieldFactory, ...d.erc20Vaults.map((v) => v.vault)]
    .filter((a): a is Address => !!a)
    .map((address) => ({ address, kind: "protocol" as const }));
  const own = d.erc20Vaults.map((v) => ({ address: v.token, kind: "token" as const, symbol: v.symbol }));
  return [...protocol, ...own, ...tokens.map((t) => ({ address: t.address, kind: "token" as const, symbol: t.symbol }))];
}

/** Thrown before anything is proved or sent: the recipient would lose what it receives (the catalog's `recipient_refused`). */
export class RecipientRefused extends Error {
  readonly code = "recipient_refused";
  constructor(reason: string) {
    super(`Not sent: the recipient is ${reason}. Nothing was sent.`);
    this.name = "RecipientRefused";
  }
}

/** Refuses a withdrawal's recipient that is the zero or a burn address, or a contract of this deployment or of one of its tokens. */
export function guardRecipient(d: Deployment, recipient: string): void {
  const r = refusedRecipient(recipient, knownAddresses(d));
  if (r) throw new RecipientRefused(r.reason);
}
