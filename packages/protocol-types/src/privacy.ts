// The privacy assessment (doc §34–§35; spec v2.0 §14.1): a level and its reasons, never a promise. The wallet never says
// "anonymous", "untraceable" or "impossible to trace"; "Some blockchain metadata remains public." always follows the reasons.

export type PrivacyLevel = "low" | "medium" | "high";
export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["low", "medium", "high"];

export interface PrivacyAssessment {
  level: PrivacyLevel;
  /** plain sentences, each a fact the level rests on ("Protected source", "Fresh destination", …) */
  reasons: string[];
}

/** The level of a 0–100 score: high ≥ 75, medium ≥ 50, low below (spec v2.0 §14.1). */
export const privacyLevelOf = (score: number): PrivacyLevel => (score >= 75 ? "high" : score >= 50 ? "medium" : "low");
