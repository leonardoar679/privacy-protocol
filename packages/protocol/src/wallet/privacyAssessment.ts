// The PrivacyEngine's assessment (contract docs/high-value-execution-contract-v1.0.md §3.11; plan §7, §48–§54, §112,
// §114): six linkabilities — source, amount, timing, destination, provider, cross-chain — each 0 (unlinkable) … 1
// (linked) and each measured from a stated fact, folded into one 0–100 score with the service's privacy weights
// regrouped into six (privacyScore.ts: source 0.20; destination 0.20 + address reuse 0.07; amount 0.15; timing 0.15;
// provider 0.10 + bridge 0.08; the cross-chain leg 0.05), and the level the Review and the Home badge show. The plan's
// §112 pattern (equal pieces on a fixed cadence) is flagged on amount and timing together. Pure; nothing here says
// "anonymous": the score measures, it never promises.
// Each basis sentence carries its code and values (`basisWords`) for the app's catalog, which says it in the reader's
// language (audit round 2, r55); `basis` is the English.
import { privacyLevelOf, type PrivacyAssessment as V6Assessment } from "@privacy-wallet/protocol-types";
import { levelOf, type Level } from "./privacyCenter";

export interface PrivacyAssessmentFacts {
  /** the source is the pool through a one-time escrow (true for every private action) */
  sourceIsPool: boolean;
  /** the public piece: a bucket of the alphabet, the sum of two, or an exact amount with its uniqueness share (0..1) */
  amount: { kind: "bucket" | "pair" | "exact"; uniqueness?: number };
  /** the funding delay window's lower bound (one order) or the cadence window's lower bound (a campaign), seconds */
  delaySeconds: number;
  destination: "privacy-address" | "fresh" | "fresh-per-tranche" | "entered" | "public-wallet";
  /** the number of steps (1 for a single order) */
  steps?: number;
  /** what the provider learns and publishes: the escrow → destination link (null: no route chosen yet) and its kind */
  provider: { linkPublic: boolean | null; kind?: "deposit-address" | "signed-intent" | "aggregator-api"; coverPerHour?: number; etaSeconds?: number; etaSigma?: number };
  /** the destination is on another chain */
  crossChain: boolean;
  /** a campaign's pattern (plan §112): two consecutive pieces of the same size; a fixed release interval */
  sameSizeConsecutive?: boolean;
  cadenceFixed?: boolean;
}

export interface PrivacyAssessment {
  components: { source: number; amount: number; timing: number; destination: number; provider: number; crossChain: number };
  score: number;
  level: Level;
  /** one sentence per component naming the fact it was measured from */
  basis: string[];
  /** the same sentences by their codes and values, for the app's catalog (assessPrivacy always sets them) */
  basisWords?: BasisWords[];
  pattern: { sameSizeConsecutive: boolean; cadenceFixed: boolean; destinationShared: boolean };
}

/** The basis sentences by their codes. */
export const BASIS_CODES = [
  "source-pool", "source-public", "amount-bucket", "amount-pair", "amount-exact",
  "timing-fixed", "timing-delayed", "timing-short", "timing-none",
  "dest-privacy-address", "dest-fresh-per-step", "dest-fresh", "dest-shared", "dest-entered", "dest-public-wallet",
  "provider-unknown", "provider-public", "provider-private", "crosschain-none", "crosschain-hidden", "crosschain-public",
] as const;
export type BasisCode = (typeof BASIS_CODES)[number];
/** A basis sentence by its code and its values: a delay in whole hours, the effective set. */
export interface BasisWords { code: BasisCode; hours?: number; set?: string }

export const ASSESSMENT_WEIGHTS = { source: 0.2, destination: 0.27, amount: 0.15, timing: 0.15, provider: 0.18, crossChain: 0.05 } as const;
export const CROSS_CHAIN_TARGET_BITS = 4;

/** The cross-chain lab's fit (docs/privacy-lab.md): effective joint set ≈ 1 + k · candidates, k = 0.02 bucketed / 0.0006 arbitrary. */
export function crossChainEffectiveSet(c: { coverPerHour: number; etaSeconds: number; etaSigma?: number }, bucketed: boolean): number {
  const window = Math.max(60, c.etaSeconds) * Math.exp(5 * (c.etaSigma ?? 0.5));
  const candidates = (Math.max(0, c.coverPerHour) / 3600) * window;
  return 1 + (bucketed ? 0.02 : 0.0006) * candidates;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * V6 (spec v2.0 §14.1): the timing linkability of a funding from the youngest note it spends — 1 under an hour or ten
 * deposits since its leaf, 0.7 under six hours or fifty, 0.3 under a day, else 0. An unknown age (a note a scan found)
 * counts by the deposits alone; with a delayed funding the age grows by the delay's lower bound and the deposits still to
 * come are not counted against it. Nothing known at all reads 0.3.
 */
export function timingOfFunding(t: { ageSeconds: number | null; depositsSince: number | null; delaySeconds?: number }): number {
  const delay = t.delaySeconds ?? 0;
  if (t.ageSeconds === null && t.depositsSince === null) return 0.3;
  const age = t.ageSeconds === null ? Infinity : t.ageSeconds + delay;
  const deposits = delay > 0 || t.depositsSince === null ? Infinity : t.depositsSince;
  if (age < 3600 || deposits < 10) return 1;
  if (age < 6 * 3600 || deposits < 50) return 0.7;
  if (age < 86400) return 0.3;
  return 0;
}

export interface SwapPrivacy extends V6Assessment {
  score: number;
  /** the funds were protected (or moved) recently: the level is at most medium and "Delay for more privacy" is offered */
  recent: boolean;
  components: PrivacyAssessment["components"];
}

/**
 * V6 (spec v2.0 §14.1): the six components with the funding's timing from its youngest note, the score's level (high ≥ 75,
 * medium ≥ 50), at most medium right after a protect; the reasons are codes the app words ("recent", "exact-amount",
 * "entered-destination", "public-link").
 */
export function assessSwapPrivacy(f: Omit<PrivacyAssessmentFacts, "delaySeconds"> & { timing: { ageSeconds: number | null; depositsSince: number | null }; delaySeconds?: number }): SwapPrivacy {
  const base = assessPrivacy({ ...f, delaySeconds: 0 });
  const timing = timingOfFunding({ ...f.timing, delaySeconds: f.delaySeconds });
  const components = { ...base.components, timing: round2(timing) };
  let s = 1;
  for (const k of Object.keys(ASSESSMENT_WEIGHTS) as (keyof typeof ASSESSMENT_WEIGHTS)[]) s *= 1 - ASSESSMENT_WEIGHTS[k] * components[k];
  const score = Math.round(100 * s);
  const recent = timing >= 1;
  const scored = privacyLevelOf(score);
  const level = recent && scored === "high" ? "medium" : scored;
  const reasons = [
    ...(recent ? ["recent"] : []),
    ...(components.amount >= 0.5 ? ["exact-amount"] : []),
    ...(components.destination >= 1 ? ["entered-destination"] : []),
    ...(f.provider.linkPublic ? ["public-link"] : []),
  ];
  return { level, reasons, score, recent, components };
}

export function assessPrivacy(f: PrivacyAssessmentFacts): PrivacyAssessment {
  const basis: string[] = [];
  const basisWords: BasisWords[] = [];
  const note = (code: BasisCode, text: string, more: Omit<BasisWords, "code"> = {}) => {
    basis.push(text);
    basisWords.push({ code, ...more });
  };
  const steps = f.steps ?? 1;
  const pattern = { sameSizeConsecutive: !!f.sameSizeConsecutive, cadenceFixed: !!f.cadenceFixed, destinationShared: f.destination === "entered" && steps > 1 };

  const source = f.sourceIsPool ? 0 : 1;
  if (f.sourceIsPool) note("source-pool", "Source: your private balance pays a one-time escrow; your permanent address appears nowhere.");
  else note("source-public", "Source: a public address pays; whoever watches it sees this payment.");

  let amount = f.amount.kind === "bucket" ? 0 : f.amount.kind === "pair" ? 0.3 : Math.min(1, Math.max(0.2, f.amount.uniqueness ?? 0.8));
  if (pattern.sameSizeConsecutive && pattern.cadenceFixed) amount = Math.max(amount, 0.7); // plan §112: a repeated size on a clock is a fingerprint
  if (f.amount.kind === "bucket") note("amount-bucket", "Amount: a common size hides in the crowd.");
  else if (f.amount.kind === "pair") note("amount-pair", "Amount: the sum of two common sizes.");
  else note("amount-exact", "Amount: an exact public amount is a fingerprint.");

  const delay = f.delaySeconds;
  let timing = delay >= 6 * 3600 ? 0 : delay >= 3600 ? 0.3 : delay >= 300 ? 0.7 : 1;
  if (pattern.cadenceFixed) timing = 1;
  if (pattern.cadenceFixed) note("timing-fixed", "Timing: the steps would follow a fixed interval — a clock is a fingerprint.");
  else if (delay >= 6 * 3600) note("timing-delayed", `Timing: a random delay of at least ${Math.round(delay / 3600)} h.`, { hours: Math.round(delay / 3600) });
  else if (delay >= 3600) note("timing-short", `Timing: a random delay of at least ${Math.round(delay / 3600)} h; timing may still correlate with other activity.`, { hours: Math.round(delay / 3600) });
  else note("timing-none", "Timing: little or no delay links funding and action by time.");

  const destination = f.destination === "privacy-address" || f.destination === "fresh" || f.destination === "fresh-per-tranche" ? 0 : 1;
  if (f.destination === "privacy-address") note("dest-privacy-address", "Destination: a privacy address inside the pool; nothing about the recipient is public.");
  else if (f.destination === "fresh-per-tranche") note("dest-fresh-per-step", "Destination: each step pays its own fresh address, used once.");
  else if (f.destination === "fresh") note("dest-fresh", "Destination: a fresh address of this wallet, used once.");
  else if (f.destination === "entered" && pattern.destinationShared) note("dest-shared", "Destination: every step pays the same entered address, which links the steps publicly.");
  else if (f.destination === "entered") note("dest-entered", "Destination: entered by hand; whoever knows it knows this payment.");
  else note("dest-public-wallet", "Destination: your connected public wallet — this payment and your public history become one.");

  const bucketed = f.amount.kind !== "exact";
  const eff = f.provider.coverPerHour !== undefined && f.provider.etaSeconds !== undefined ? crossChainEffectiveSet({ coverPerHour: f.provider.coverPerHour, etaSeconds: f.provider.etaSeconds, etaSigma: f.provider.etaSigma }, bucketed) : 1;
  const hurdle = 1 - Math.min(1, Math.log2(eff) / CROSS_CHAIN_TARGET_BITS); // 1 = the arrival is linked, 0 = hidden among the provider's comparable swaps
  const kind = f.provider.kind ?? (f.provider.linkPublic === null ? undefined : "deposit-address");
  const provider = f.provider.linkPublic === null ? 0.5 : (kind === "deposit-address" ? 0.3 : kind === "signed-intent" ? 0.6 : 0.5) * (f.provider.linkPublic ? 1 : 0.5);
  if (f.provider.linkPublic === null) note("provider-unknown", "Provider: what the route publishes is known once a route is chosen.");
  else if (f.provider.linkPublic) note("provider-public", "Provider: the route publishes the escrow → destination link (it reaches only the one-time escrow).");
  else note("provider-private", "Provider: the route keeps the escrow → destination link off public chains.");

  const crossChain = !f.crossChain ? 0 : f.provider.linkPublic === false ? 0 : f.provider.linkPublic === null ? 0.5 : round2(hurdle);
  if (!f.crossChain) note("crosschain-none", "Cross-chain: none; the destination is on the same chain.");
  else if (crossChain === 0) note("crosschain-hidden", "Cross-chain: the arrival is hidden among the provider's comparable swaps.");
  else note("crosschain-public", `Cross-chain: the destination settles publicly; the provider's cover traffic gives an effective set of ${eff.toFixed(1)}.`, { set: eff.toFixed(1) });

  const components = { source, amount: round2(amount), timing: round2(timing), destination, provider: round2(provider), crossChain };
  let s = 1;
  for (const k of Object.keys(ASSESSMENT_WEIGHTS) as (keyof typeof ASSESSMENT_WEIGHTS)[]) s *= 1 - ASSESSMENT_WEIGHTS[k] * components[k];
  const score = Math.round(100 * s);
  return { components, score, level: levelOf(score), basis, basisWords, pattern };
}
