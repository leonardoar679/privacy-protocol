// The §46 quote (doc §45–§46; spec v2.0 §13.2): the engine's chosen route as one Quote — the amounts, every fee in the
// source asset (the privacy fee by the formula, the relayer's F from its terms plus the executor tip, the provider's own
// fees in the source asset; a fee the provider takes in another asset is already in the rate), the expiry, the time, the
// route-only privacy assessment and assessRisk. Indicative: the wallet stays canonical for money (it computes the
// escrow's W with its own relayer terms, spec v2.0 §3). V6 Stage 12: into the protected balance, the expected and minimum
// output are what the note receives — the delivery less the shield tip, which is in the output asset (in the rate).
import { assetOn } from "@privacy-wallet/config";
import { PRIVACY_FEE_BPS, privacyFee } from "@privacy-wallet/protocol/wallet/fees";
import { atLeast, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { assessRisk } from "@privacy-wallet/risk-engine";
import { privacyLevelOf, type ChainId, type Quote } from "@privacy-wallet/protocol-types";
import type { QuoteSet } from "@privacy-wallet/swap-engine/engine";
import type { AssetRef, QuoteRequest } from "@privacy-wallet/swap-engine/types";

/** The relayer's terms for the fee: its live ETH minimum and its fixed minimums per accepted ERC-20 vault (GET /info). */
export interface RelayerTerms {
  minFeeWei: string;
  feeVaults?: { vault: string; symbol: string; decimals: number; minFee: string }[];
  /** the swap service's addresses the relayer runs for (its /info `vouchers`, lowercased); absent from a relayer that names none */
  vouchers?: string[];
}

/** F: the relayer's minimum for the source asset with the wallet's 10 % margin (packages/sdk/src/relayer.ts feeForRelayer); 0 when unknown. */
export function relayerMinimum(terms: RelayerTerms | null, from: AssetRef): bigint {
  if (!terms) return 0n;
  const margin = (x: bigint) => (x * 11_000n) / 10_000n;
  if (from.asset === "native") return margin(BigInt(terms.minFeeWei));
  const t = terms.feeVaults?.find((v) => v.symbol === from.symbol && v.decimals === from.decimals);
  return t ? margin(BigInt(t.minFee)) : 0n;
}

const registryAsset = (a: AssetRef) => assetOn(a.chain as ChainId, a.asset === "native" ? null : a.asset);

export interface QuoteFacts {
  id: string;
  request: QuoteRequest;
  set: QuoteSet;
  terms: RelayerTerms | null;
  /** the providers' recent failures (provider_health) */
  recentFailures: (provider: string) => number;
  healthy: (provider: string) => boolean;
  chainId: number;
  now: number;
}

/** The §46 quote of the chosen route; null when nothing was chosen or an asset is not in the registry. */
export function quoteOf(f: QuoteFacts): Quote | null {
  const { set, request: req } = f;
  const chosen = set.quotes.find((q) => q.provider === set.chosen?.provider);
  const src = registryAsset(req.from),
    dst = registryAsset(req.to);
  if (!chosen || !src || !dst) return null;
  const tip = BigInt(set.executorTip ?? chosen.executorTip ?? 0n);
  const p = privacyFee(req.amount, PRIVACY_FEE_BPS);
  const relayer = relayerMinimum(f.terms, req.from) + tip;
  const provider = chosen.fees.filter((x) => x.asset === req.from.symbol && x.decimals === req.from.decimals).reduce((s, x) => s + BigInt(x.amount), 0n);
  const score = set.scores.find((s) => s.provider === chosen.provider);
  const link = set.links[chosen.provider];
  const tier = set.tier as Tier | undefined;
  const risk = assessRisk({
    now: f.now,
    quote: {
      fetchedAt: chosen.obtainedAt,
      expiresAt: chosen.expiresAt * 1000,
      minimumOut: chosen.toAmountMin,
      approvedMinimum: chosen.toAmountMin,
      impactBps: chosen.impactBps ?? 0,
      slippageBps: req.slippageBps,
      parametersMatch: true,
    },
    asset: { status: src.status !== "supported" ? src.status : dst.status },
    destination: { valid: true }, // indicative: the destination is checked by the wallet and at commit
    provider: { healthy: f.healthy(chosen.provider), recentFailures: f.recentFailures(chosen.provider) },
    network: { expectedChainId: f.chainId, chainId: f.chainId },
    execution: { steps: chosen.plan && chosen.plan.mode !== "single" ? Math.min(chosen.plan.parts, 4) : 1, crossChain: req.from.chain !== req.to.chain },
    ...(set.value && "usd" in set.value ? { usd: set.value.usd } : {}),
    largeTrade: !!tier && atLeast(tier, "large-protected"),
  });
  return {
    id: f.id,
    sourceAsset: src,
    destinationAsset: dst,
    inputAmount: req.amount.toString(),
    expectedOutput: (chosen.toAmount - (chosen.shieldTip ?? 0n)).toString(),
    minimumOutput: (chosen.toAmountMin - (chosen.shieldTip ?? 0n)).toString(),
    privacyFee: p.toString(),
    relayerFee: relayer.toString(),
    providerFee: provider.toString(),
    totalFee: (p + relayer + provider).toString(),
    expiresAt: chosen.expiresAt,
    estimatedSeconds: Math.max(chosen.etaSeconds, chosen.plan?.expectedSeconds ?? 0),
    privacy: {
      level: privacyLevelOf(score?.components.privacy ?? 0),
      reasons: ["Protected source", link?.public ? "The route's destination is public on chain" : "No public link from the escrow to the destination"],
    },
    risk,
  };
}
