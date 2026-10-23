// The Review's values in the reader's words (audit round 2, r55): the tier, the privacy level, the route kind, the verdict and
// the execution plan reach the Review as codes, or as the V2–V4 English its styling compares; the catalog says them. A Korean
// reader had read "High-value transfer.", "Reduced", "Safe to execute" and "Private streaming route" in English.
import type { Level } from "@privacy-wallet/protocol/wallet/privacyCenter";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { ExecutionPlan } from "@privacy-wallet/sdk/swapService";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import type { ReviewProps, Verdict } from "./ReviewScreen";

type T = (key: MessageKey, vars?: Vars) => string;

export const TIER_WORDS: Record<Tier, MessageKey> = {
  standard: "tier.standard",
  large: "tier.large",
  "large-protected": "tier.largeProtected",
  enhanced: "tier.enhanced",
  "high-value": "tier.highValue",
  "high-value-secondary": "tier.highValueSecondary",
  institutional: "tier.institutional",
};
export const LEVEL_WORDS: Record<Level, MessageKey> = { Excellent: "review.level.excellent", Good: "review.level.good", Reduced: "review.level.reduced" };
export const SECURITY_WORDS: Record<Verdict["security"], MessageKey> = {
  "Safe to execute": "review.verdict.safe",
  Review: "review.verdict.review",
  "Do not execute": "review.verdict.doNot",
};
export const EXECUTION_WORDS: Record<NonNullable<Verdict["execution"]>, MessageKey> = {
  "Best available": "review.verdict.best",
  "Only route": "review.verdict.only",
  Review: "review.verdict.review",
};
export const ROUTE_KIND_WORDS: Record<NonNullable<ReviewProps["routeKind"]>, MessageKey> = {
  "Native-to-native": "review.routeKind.native",
  "Issuer-dependent": "review.routeKind.issuer",
};

/** The execution in words (sdk planWords): never the provider's vocabulary. */
export function planText(t: T, plan: ExecutionPlan | undefined): string {
  if (!plan || plan.mode === "single") return t("plan.single");
  if (plan.mode === "streaming" || plan.mode === "dca") return t("plan.streaming");
  if (plan.mode === "auction") return t("plan.auction");
  return t("plan.intent");
}

/** The plan's detail (sdk planLabel): its parts and their time, the auction, the intent. */
export function planDetail(t: T, plan: ExecutionPlan | undefined): string {
  if (!plan || plan.mode === "single") return t("plan.detail.single");
  const mins = Math.round(plan.expectedSeconds / 60);
  if (plan.mode === "streaming" || plan.mode === "dca")
    return t("plan.detail.streaming", {
      parts: plan.parts,
      duration: mins >= 90 ? t("unit.hoursLong", { n: (mins / 60).toFixed(1) }) : t("unit.minutesLong", { n: mins }),
    });
  if (plan.mode === "auction") return t("plan.detail.auction");
  return t("plan.detail.intent");
}
