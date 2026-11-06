// The protection level a person reads (spec v2.0 §14.1: the V4 words leave the UI) — one rule for Home's badge and for the Privacy Center
// the badge opens (the eleventh review round, 2026-11-04, E11-11). Home had kept its own and read one level more than the Center: "Medium
// protection" for a posture the Center calls "Low", "Protected" for its "Medium" — while audit gap 65 stated the badge read "Low
// protection". Pure and without imports: Home's first paint carries it.

export type ProtectionLevel = "high" | "medium" | "low";

/** The posture's overall word (V4: its lowest category's) as the level: Excellent → high, Good → medium, Reduced → low; unknown → null. */
export const protectionLevelOf = (overall: "Excellent" | "Good" | "Reduced" | null): ProtectionLevel | null =>
  overall === "Excellent" ? "high" : overall === "Good" ? "medium" : overall === "Reduced" ? "low" : null;
