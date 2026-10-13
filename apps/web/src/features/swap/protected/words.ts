// The words of a step's state (High-Value Protection spec §15, plan V3 §110): never "failed" for a step whose last
// read failed — "unknown / reconnecting" is the progress' word for that.
import type { Tranche } from "@ref/wallet/campaign";

export const TRANCHE_WORDS: Record<Tranche["state"], string> = {
  planned: "waiting", ready: "starting", committed: "committed", funded: "funded", signed: "signed", executing: "executing", "source-confirmed": "executing", "destination-submitted": "waiting for the destination", "destination-confirmed": "delivered, finality pending", settled: "settled", partial: "delivered in part", refunding: "returning", refunded: "returned", failed: "needs attention", skipped: "skipped",
};
