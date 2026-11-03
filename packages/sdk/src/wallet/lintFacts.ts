// The lint's facts from the wallet's own state (whale spec §18): the settings, the deployment, the quote set
// and what the wallet checked in the provider call. The engine's score and this list agree because both
// read the same inputs; nothing here is fetched (the pool's deposit sizes come from sdk/poolDeposits.ts
// when a piece exceeds the common sizes, on the user's input, never at launch).
import { bucketsFor } from "@privacy-wallet/protocol/wallet/amounts";
import { lint, type LintFacts, type LintId, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { Deployment } from "../chain";
import { specForChain } from "../lightclient/spec";
import type { QuoteSet } from "../swapService";
import type { CheckedCall } from "../providerCall";
import type { Settings } from "./settings";

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface WalletLintInput {
  action: "swap" | "withdraw" | "transfer";
  tier: Tier;
  deployment: Deployment | null;
  settings: Pick<Settings, "submission" | "verifyReads">;
  destination: string;
  destinationKind: "fresh" | "entered" | "privacy-address";
  /** the connected public wallet, if any */
  account: string | null;
  delaySeconds: number;
  amount: bigint;
  decimals: number;
  amountIsBucket: boolean;
  /** swaps: the quote set and the chosen route, when quoted */
  quotes?: QuoteSet | null;
  chosenProvider?: string;
  /** swaps, at signing: what the wallet read in the provider call */
  checked?: CheckedCall | null;
  approvedMin?: bigint | null;
  /** holders who could pay a piece above the common sizes (sdk/poolDeposits.ts), null when not read */
  holders?: number | null;
  acknowledged?: LintId[];
  /** V3 (High-Value Protection spec §11): what a protected execution reveals, when the order is one */
  campaign?: LintFacts["campaign"];
}

export const topBucket = (decimals: number): bigint => bucketsFor(decimals).reduce((m, b) => (b > m ? b : m), 0n);

export function walletLintFacts(i: WalletLintInput): LintFacts {
  const link = i.quotes && i.chosenProvider ? i.quotes.links?.[i.chosenProvider]?.public : undefined;
  const inAlphabet = i.amount <= topBucket(i.decimals);
  return {
    action: i.action,
    tier: i.tier,
    sourceIsPool: true,
    destinationKind: i.destinationKind,
    destinationIsPublicWallet: i.destinationKind !== "privacy-address" && same(i.destination, i.account),
    linkPublic: i.action === "swap" ? (link === undefined ? null : link) : null,
    providerIdentityDetached: i.action === "swap" ? (i.quotes ? !!i.quotes.competition : null) : null,
    delaySeconds: i.delaySeconds,
    amountIsBucket: i.amountIsBucket,
    // an approved minimum this call must meet; without one on record nothing is verified (the third review round, 2026-11-03)
    minOutVerified: i.action === "swap" ? (i.checked ? i.checked.minOut !== null && i.approvedMin !== undefined && i.approvedMin !== null && i.checked.minOut >= i.approvedMin : null) : null,
    privateSubmission: i.settings.submission.kind === "relayer",
    rpcEndpoints: i.deployment ? (i.deployment.rpcUrls?.length ? i.deployment.rpcUrls.length : 1) : 0,
    lightClient: !!i.deployment && i.settings.verifyReads && !!specForChain(i.deployment.chainId),
    largePiece: i.action === "transfer" ? null : { inAlphabet, holders: inAlphabet ? null : (i.holders ?? null) },
    acknowledged: i.acknowledged,
    ...(i.campaign ? { campaign: i.campaign } : {}),
  };
}

export const walletLint = (i: WalletLintInput): LintItem[] => lint(walletLintFacts(i));
