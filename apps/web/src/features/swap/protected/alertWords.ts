// A protected execution's alerts and pauses in the reader's words (the eleventh review round, 2026-11-04, E11-10). Its progress had shown the
// SDK's English titles (sdk/wallet/alerts.ts ALERT_TITLES), the runner's pause detail and every alert's English text in each experience and
// language — "일시 중지됨 — Provider degraded" and the runner's sentence under it — on the page a Simple user reaches through "Review the new
// route", and a pause's notification kept the runner's English body. The alert kinds, the pause's reason and how an undelivered step ended are
// the catalog's words here; the runner's own sentences stay for Advanced.
import type { AlertKind, CampaignAlert, PauseReason, Tranche } from "@privacy-wallet/protocol/wallet/campaign";
import { hasCode, titleKey } from "@privacy-wallet/sdk/operations/errors/codes";
import type { MessageKey } from "../../../app/i18n/en";

export const ALERT_WORDS: Record<AlertKind, MessageKey> = {
  "provider-degraded": "campaign.alert.provider-degraded",
  "price-changed": "campaign.alert.price-changed",
  "liquidity-dropped": "campaign.alert.liquidity-dropped",
  "destination-changed": "campaign.alert.destination-changed",
  "route-changed": "campaign.alert.route-changed",
  "execution-delayed": "campaign.alert.execution-delayed",
  "chain-congested": "campaign.alert.chain-congested",
  "security-incident": "campaign.alert.security-incident",
  paused: "campaign.alert.paused",
  resumed: "campaign.alert.resumed",
  "step-settled": "campaign.alert.step-settled",
  completed: "campaign.alert.completed",
  cancelled: "campaign.alert.cancelled",
};

/** An alert in the reader's words: a pause's by its cause's code when the runner knew it, as the pause itself reads (the fourth critique of
 * slice 4), any other by its kind. */
export const alertWordsOf = (a: Pick<CampaignAlert, "kind" | "code">): MessageKey => (a.code && hasCode(a.code) ? (titleKey(a.code) as MessageKey) : ALERT_WORDS[a.kind]);

/** The catalog code a pause reason is read under, as the Simple steps page reads it (SwapScreen.tsx, SwapSteps). */
export const pauseCode = (reason: PauseReason): string => (reason === "user" ? "user_pause" : reason.replace(/-/g, "_"));

/** A pause notification's words by its alert kind: the catalog's reason of the pause the kind stands for, the generic words for the rest. */
export const PAUSE_WORDS: Partial<Record<AlertKind, MessageKey>> = {
  "provider-degraded": "op.error.provider_error.reason",
  "price-changed": "op.error.price_deviation.reason",
  "liquidity-dropped": "op.error.route_degraded.reason",
  "destination-changed": "op.error.unexpected_destination.reason",
  "chain-congested": "op.error.chain_congestion.reason",
  "security-incident": "op.error.security_incident.reason",
  "execution-delayed": "op.delayed",
};

/** How an undelivered step ended: where its value went, which only the runner's English pause detail had said. */
export const UNDELIVERED_WORDS: Record<NonNullable<NonNullable<Tranche["outcome"]>["undelivered"]>, MessageKey> = {
  "refunded-at-destination": "campaign.undelivered.refunded-at-destination",
  "other-token": "campaign.undelivered.other-token",
  lost: "campaign.undelivered.lost",
  "refunded-other-token": "campaign.undelivered.refunded-other-token",
};
