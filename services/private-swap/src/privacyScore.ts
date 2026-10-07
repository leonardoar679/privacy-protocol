// Cross-chain privacy score (spec §10, plan §51): eight penalties, multiplicative, calibrated by the
// privacy lab (docs/privacy-lab.md). The same function must run in the wallet UI.
export interface PrivacyInputs {
  sourceIsPool: boolean; // withdrawal from the shielded pool via a one-time escrow
  destinationFresh: boolean; // wallet-derived fresh address
  amountIsBucket: boolean; // from the 1-2-5 bucket alphabet
  amountUniqueness?: number; // 0..1 when not a bucket (share of comparable amounts that are unique)
  delaySeconds: number; // scheduled delay between commit and source submission
  providerKind: "deposit-address" | "signed-intent" | "aggregator-api";
  nativeAssets: boolean; // no wrapped / bridged legs
  oneTimeEndpoints: boolean;
  privateSubmission: boolean;
  /**
   * For a cross-chain swap: the provider's cover traffic on the pair (swaps/hour) and its delivery
   * time. The ingress → arrival link is only as private as the number of comparable swaps in the
   * provider's ETA window (benchmarks/privacy/crosschain.json): the amount and timing penalties are
   * then taken from the lab's fit instead of the single-chain rules.
   */
  crossChain?: { throughputPerHour: number; etaSeconds: number; etaSigma?: number };
}

/** Lab fit (docs/privacy-lab.md, cross-chain section): effective joint set ≈ 1 + k · candidates, k = 0.02 bucketed / 0.0006 arbitrary. */
export function crossChainEffectiveSet(c: NonNullable<PrivacyInputs["crossChain"]>, bucketed: boolean): number {
  const window = Math.max(60, c.etaSeconds) * Math.exp(5 * (c.etaSigma ?? 0.5)); // ingresses the ETA law still makes plausible
  const candidates = (Math.max(0, c.throughputPerHour) / 3600) * window;
  return 1 + (bucketed ? 0.02 : 0.0006) * candidates;
}
export const CROSS_CHAIN_TARGET_BITS = 4; // a 16-strong effective set earns full marks on the cross-chain leg

export const PRIVACY_WEIGHTS = {
  sourceIdentity: 0.20, destinationIdentity: 0.20, amountCorrelation: 0.15, timingCorrelation: 0.15,
  providerVisibility: 0.10, bridgeVisibility: 0.08, addressReuse: 0.07, mempoolVisibility: 0.05,
} as const;

export function privacyPenalties(i: PrivacyInputs) {
  const timing = i.delaySeconds >= 6 * 3600 ? 0 : i.delaySeconds >= 3600 ? 0.3 : i.delaySeconds >= 300 ? 0.7 : 1;
  let amountCorrelation = i.amountIsBucket ? 0 : Math.min(1, Math.max(0.2, i.amountUniqueness ?? 0.8));
  let timingCorrelation = timing;
  if (i.crossChain) {
    // the cross-chain leg: how many comparable swaps hide this arrival (lab-calibrated); the delay
    // policy does not help here (the escrow ties withdrawal and ingress), only cover traffic does
    const eff = crossChainEffectiveSet(i.crossChain, i.amountIsBucket);
    const cc = 1 - Math.min(1, Math.log2(eff) / CROSS_CHAIN_TARGET_BITS);
    amountCorrelation = Math.max(amountCorrelation, cc);
    timingCorrelation = Math.max(timingCorrelation, cc);
  }
  return {
    sourceIdentity: i.sourceIsPool ? 0 : 1,
    destinationIdentity: i.destinationFresh ? 0 : 1,
    amountCorrelation,
    timingCorrelation,
    providerVisibility: i.providerKind === "deposit-address" ? 0.3 : i.providerKind === "signed-intent" ? 0.6 : 0.5,
    bridgeVisibility: i.nativeAssets ? 0 : 1,
    addressReuse: i.oneTimeEndpoints ? 0 : 1,
    mempoolVisibility: i.privateSubmission ? 0 : 1,
  };
}

export function privacyScore(i: PrivacyInputs): number {
  const p = privacyPenalties(i);
  let s = 1;
  for (const k of Object.keys(PRIVACY_WEIGHTS) as (keyof typeof PRIVACY_WEIGHTS)[]) s *= 1 - p[k] * PRIVACY_WEIGHTS[k];
  return Math.round(100 * s);
}
