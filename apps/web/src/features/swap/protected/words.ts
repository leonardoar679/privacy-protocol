// The words of a step's state (High-Value Protection spec §15, plan V3 §110): never "failed" for a step whose last
// read failed — "unknown / reconnecting" is the progress' word for that.
import { exposure, unreturnedOf, type Campaign, type Tranche } from "@privacy-wallet/protocol/wallet/campaign";
import type { MessageKey } from "../../../app/i18n/en";
import type { Vars } from "../../../app/i18n/messages";
import type { CampaignStatus } from "./CampaignProgress";

type T = (key: MessageKey, vars?: Vars) => string;

/** A protected execution's status word in the reader's language (audit round 2, n84): "✓ Returned" had read in English. */
const STATUS_WORDS: Record<CampaignStatus["word"], MessageKey> = {
  Protected: "campaign.status.protected",
  Review: "campaign.status.review",
  Processing: "campaign.status.processing",
  Completed: "campaign.status.completed",
  Returned: "campaign.status.returned",
  // part of the amount not delivered as asked (the eleventh review round, 2026-11-04, E11-1)
  PartNotDelivered: "campaign.status.partNotDelivered",
};
export const campaignStatusWords = (t: T, st: CampaignStatus): string => t(STATUS_WORDS[st.word]);

/** How a step not delivered as asked ended (Tranche.outcome.undelivered), in the reader's words. */
const NOT_DELIVERED_WORDS: Record<"refunded-at-destination" | "other-token" | "lost" | "partial-unreturned", MessageKey> = {
  "refunded-at-destination": "screen.swap.stepsWhere.refundedAtDestination",
  "other-token": "screen.swap.stepsWhere.otherToken",
  lost: "screen.swap.stepsWhere.lost",
  // a settled partial fill whose rest never came back (exposure().notDelivered counts it: the critique of E11-1)
  "partial-unreturned": "screen.swap.stepsWhere.partialUnreturned",
};
type Way = keyof typeof NOT_DELIVERED_WORDS;
/**
 * Where the value of the steps not delivered as asked went — refunded at the step's destination address in the provider's own asset,
 * delivered there in another token, or failed with nothing back —, one sentence for each way, in the order of the steps (the eleventh
 * review round, 2026-11-04, E11-1): the Simple steps page had said "Your funds are safe" beside such a step, then "complete", and never
 * where it went.
 */
export function notDeliveredWords(t: T, c: Campaign): string[] {
  const ways = [
    ...new Set(
      c.tranches.flatMap((x): Way[] =>
        x.state === "undelivered" ? [x.outcome?.undelivered ?? "lost"] : unreturnedOf(x) > 0n ? ["partial-unreturned"] : [],
      ),
    ),
  ];
  return ways.map((w) => t(NOT_DELIVERED_WORDS[w], { symbol: c.request.to.symbol }));
}

/**
 * A protected execution's line (the SDK's English progressLine, which the activity journal keeps) in the reader's words
 * (audit round 2, n93): the Swap screen's running list and the Activity detail had put it in English into a Korean sentence.
 */
export function campaignLineText(t: T, c: Campaign, advanced = false): string {
  const e = exposure(c);
  const settled = c.tranches.filter((x) => x.state === "settled").length;
  const total = Math.max(c.tranches.filter((x) => x.state !== "skipped").length, 1);
  const dec = c.request.from.decimals;
  const f = (u: bigint) => {
    const base = 10n ** BigInt(dec);
    const frac = (u % base).toString().padStart(dec, "0").slice(0, 4).replace(/0+$/, "");
    return `${u / base}${frac ? `.${frac}` : ""}`;
  };
  const head = advanced ? t("campaign.stepOf", { step: Math.min(settled + 1, total), total }) : t("campaign.executing");
  return `${head} · ${t("campaign.lineAmounts", { completed: f(e.completed), inFlight: f(e.inFlight), protected: f(e.protected), symbol: c.request.from.symbol })}`;
}

export const TRANCHE_WORDS: Record<Tranche["state"], string> = {
  planned: "waiting", ready: "starting", committed: "committed", funded: "funded", signed: "signed", executing: "executing", "source-confirmed": "executing", "destination-submitted": "waiting for the destination", "destination-confirmed": "delivered, finality pending", settled: "settled", partial: "delivered in part", refunding: "returning", refunded: "returned", failed: "needs attention", skipped: "skipped", undelivered: "not delivered as asked",
};
