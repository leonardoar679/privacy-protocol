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
  /** unix seconds; an expired quote is never executed */
  expiresAt: number;
  estimatedSeconds: number;
  privacy: PrivacyAssessment;
  risk: RiskAssessment;
}
