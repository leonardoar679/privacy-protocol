// The quote request and the quote (doc §45–§46; spec v2.0 §13.2). The server gets only what the route engine needs: no
// destination for an indicative quote. Amounts are base units as decimal strings.
import type { Asset } from "./assets";
import type { BaseUnits } from "./primitives";
import type { PrivacyAssessment } from "./privacy";
import type { RiskAssessment } from "./risk";

export interface QuoteRequest {
  sourceAssetId: string;
  destinationAssetId: string;
  amount: BaseUnits;
  /** V7 (spec v3.0 §3): what the user pays — the privacy fee's basis when the escrow's funding differs from it */
  grossAmount?: BaseUnits;
  /** into the protected balance (a same-chain swap through a shield receiver) or to an address */
  destinationType: "protected" | "external";
  destination?: string;
}

export interface Quote {
  id: string;
  sourceAsset: Asset;
  destinationAsset: Asset;
  inputAmount: BaseUnits;
  expectedOutput: BaseUnits;
  /** the hard bound signed into the provider call */
  minimumOutput: BaseUnits;
  privacyFee: BaseUnits;
  relayerFee: BaseUnits;
  providerFee: BaseUnits;
  totalFee: BaseUnits;
  /**
   * V7 (spec v3.0 §3; doc §6 rule 2): the fee terms the quote is bound to — the privacy fee's basis points, the relayer's F,
   * the executor tip, their sum as the bound a funding never exceeds, and when the terms were read (unix seconds)
   */
  feeTerms?: { privacyFeeBps: number; relayerFee: BaseUnits; executorTip: BaseUnits; maxFee: BaseUnits; termsAt: number };
  /** unix seconds; an expired quote is never executed */
  expiresAt: number;
  estimatedSeconds: number;
  privacy: PrivacyAssessment;
  risk: RiskAssessment;
}
