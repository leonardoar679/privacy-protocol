// The trade preference (whale spec §4, §23; plan V2 §97, §108–§110) lives in Settings, never on the Swap
// screen and never on chain. The service derives the policy from it and the value tier; the wallet needs
// the policy only for the funding window it schedules (spec v1.1 §8) and for the Privacy Center's timing line.
import type { Policy, Preference } from "./swapService";

/** The funding delay window per policy, seconds (spec v1.1 §8 errata; whale spec §4). */
export const DELAY_WINDOW: Record<Policy, [number, number]> = {
  "best-privacy": [6 * 3600, 72 * 3600],
  "best-price": [3600, 24 * 3600],
  fastest: [0, 0],
  balanced: [3600, 24 * 3600],
  "privacy-execution": [3600, 24 * 3600],
  // V4 (contract §7): the presets the service applies under the Best Execution and Maximum Privacy modes from high-value
  "best-execution": [3600, 24 * 3600],
  "high-privacy": [6 * 3600, 72 * 3600],
};

/**
 * A policy this wallet knows: an own key of DELAY_WINDOW (the twelfth review round, F12-7) — a service's `policy: "constructor"` (or "toString",
 * "__proto__") had passed `!!DELAY_WINDOW[p]` and been journaled, every resume of the order then refused by the API as an unknown policy.
 */
export const isKnownPolicy = (p: unknown): p is Policy => typeof p === "string" && Object.hasOwn(DELAY_WINDOW, p);
/**
 * Looser than the policy wanted (the eleventh review round, D11-11): Fastest — which alone accepts a call that binds no minimum — where the user
 * did not choose it, or a shorter funding delay than the preference's. The commit never journals one.
 */
export const looserThan = (p: Policy, wanted: Policy): boolean => (p === "fastest" && wanted !== "fastest") || DELAY_WINDOW[p][0] < DELAY_WINDOW[wanted][0];
/**
 * The policy a quote set names where the wallet knows it and the commit would take it (not looser than the preference's), else the preference's —
 * the swap screen's funding line and the policy its commit sends, as the commit journals them when the service answers the policy it was sent
 * (F12-7; ZE's critique: a looser one had been promised on screen while the order was funded on the preference's window; ZF's: an answer of
 * another known policy, within the preference's bound, is journaled as answered — stated).
 */
export const quotedPolicy = (quoted: unknown, preference: Preference): Policy => {
  const wanted = policyFromPreference(preference);
  return isKnownPolicy(quoted) && !looserThan(quoted, wanted) ? quoted : wanted;
};

/** The policy a preference maps to before the tier override (the service applies the override; "native" is balanced plus a filter). */
export const policyFromPreference = (p: Preference): Policy => (p === "native" ? "balanced" : p);

export const PREFERENCE_LABELS: Record<Preference, { label: string; help: string }> = {
  balanced: { label: "Balanced", help: "Privacy, price and time weighed together; funded at a random time within 1–24 h. Large transfers favour privacy and execution quality by themselves." },
  "best-privacy": { label: "Best privacy", help: "The most private route and the longest random delay (6–72 h), even at a worse price." },
  "best-price": { label: "Best price", help: "The best net output among safe routes; funded within 1–24 h." },
  native: { label: "Native assets", help: "Balanced, but a route that keeps the assets native wins over one with a wrapped leg." },
  fastest: { label: "Fastest", help: "No delay and a public submission: the least private choice, for when time matters more." },
};

const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
/** The window in words ("1–24 h", "6–72 h", "no delay"). */
export const windowLabel = ([min, max]: [number, number]): string => (max === 0 ? "no delay" : `${hours(min)}–${hours(max)}`);
