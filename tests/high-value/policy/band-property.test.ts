// V7 Stage 13 (spec v3.0 §4; the owner's decision 3; the V6 Stage 13 worlds kept): the $50K band's protected execution — when the
// service stages the order or the user asks — plans the V3 planner's varied pieces between an eighth and a quarter of the order,
// one in flight at a time, never identical quarters; driven by the runner's own reducer (`nextAction`) through random worlds:
// every step fills, partially fills, refunds or fails; the user pauses, resumes or returns the rest. After every event the
// in-flight exposure stays within the limit (I1: in flight ≤ a quarter of the order), at most one step is in flight, every step
// fits the limit (I2), and completed + in flight + prepared + remaining is the order.
import { describe, expect, it } from "vitest";
import {
  exposure,
  nextAction,
  planTranches,
  replan,
  withCampaignState,
  withTrancheState,
  type Campaign,
  type TrancheState,
} from "../../../packages/protocol/src/wallet/campaign";
import { campaign, seeded, sum } from "../helpers";

const CASES = 500;
const BAND = { bandBps: [1250, 2500] as [number, number], capBps: 2500 };

/** A $50K–$100K order in USDC (6 decimals) or ETH (18), planned as the band plans it: varied pieces under the quarter. */
function bandCampaign(rng: () => number): { c: Campaign; cap: bigint } {
  const decimals = rng() < 0.5 ? 6 : 18;
  const unit = 10n ** BigInt(decimals);
  const total =
    decimals === 6 ? BigInt(50_000 + Math.floor(rng() * 50_000)) * unit : BigInt(12 + Math.floor(rng() * 12)) * unit + BigInt(Math.floor(rng() * 1e9));
  const split = planTranches(total, { decimals, ...BAND, sizing: "varied", maxParallel: 1, rng });
  const c = campaign(
    split.pieces,
    [],
    { tier: "large-protected" },
    { ...BAND, sizing: "varied", concurrency: "sequential", maxParallel: 1, estimatedTranches: split.pieces.length },
  );
  return { c, cap: (total * 2500n) / 10000n };
}

function check(c: Campaign, cap: bigint, where: string): void {
  const e = exposure(c);
  if (e.inFlight > cap) throw new Error(`I1 broken ${where}: in flight ${e.inFlight} > ${cap}`);
  if (e.inFlightCount > 1) throw new Error(`more than one step in flight ${where}`);
  for (const t of c.tranches) if (BigInt(t.amount) > cap) throw new Error(`I2 broken ${where}: a step of ${t.amount} > ${cap}`);
  if (e.completed + e.inFlight + e.prepared + e.remaining !== BigInt(c.request.amount)) throw new Error(`the accounting broke ${where}`);
}

/** One reducer action applied the way the runner would, with the world's answer drawn at random. */
function apply(c: Campaign, rng: () => number, now: number): Campaign {
  const a = nextAction(c, { now, pause: null, notesShaped: true });
  switch (a.kind) {
    case "commit":
      return withTrancheState(c.state === "user-confirmed" ? withCampaignState(c, "running", now) : c, a.index, "committed", now);
    case "fund":
      return withTrancheState(c, a.index, "funded", now);
    case "sign":
      return withTrancheState(c, a.index, rng() < 0.05 ? "failed" : "signed", now);
    case "hand-over":
      return withTrancheState(c, a.index, "executing", now, { provider: "thorchain" });
    case "track": {
      const i = a.indexes[Math.floor(rng() * a.indexes.length)];
      const t = c.tranches[i];
      const r = rng();
      if (t.state === "refunding") return withTrancheState(c, i, "refunded", now);
      if (r < 0.55) return withTrancheState(c, i, "settled", now);
      if (r < 0.65)
        return withTrancheState(c, i, "partial", now, { outcome: { delivered: ((BigInt(t.amount) * BigInt(1 + Math.floor(rng() * 99))) / 100n).toString() } });
      if (r < 0.75) return withTrancheState(c, i, "refunding", now);
      if (r < 0.85) return withTrancheState(c, i, "destination-submitted", now);
      return c; // nothing new this time
    }
    case "pause":
      // a failed step: its funds are in its escrow and come back (the runner hands it a refund-only job); a pause that asks before a
      // step that came back is swapped again records the question (the seventh review round)
      return a.index !== undefined
        ? withTrancheState(withCampaignState(c, "paused", now), a.index, "refunding", now)
        : withCampaignState(c, "paused", now, undefined, a.replan ? { replanAskedAt: now } : {});
    case "refund": // a failed step's own refund-only job after a resume
      return withTrancheState(c, a.index, "refunding", now);
    case "replan": {
      const e = exposure(c);
      const split = planTranches(e.remaining, {
        decimals: c.request.from.decimals,
        ...BAND,
        sizing: "varied",
        maxParallel: 1,
        rng,
        reference: e.total,
      });
      return replan(c, split.pieces, now);
    }
    case "wind-down": {
      const funded = c.tranches.find((t) => t.state === "funded" || t.state === "signed" || t.state === "failed")!;
      return withTrancheState(c, funded.index, "refunding", now);
    }
    case "abandon": // the runner reads the escrow empty: never funded, given up
      return withTrancheState(c, a.index, "skipped", now);
    case "complete":
      return withCampaignState(c, c.state === "winding-down" ? "cancelled" : "completed", now);
    default:
      return c;
  }
}

describe("V7 Stage 13: the $50K band's protected steps (spec v3.0 §4)", () => {
  it("plans varied pieces under the quarter: at least four, the whole order, no two neighbours alike (the last aside), never four identical quarters", () => {
    const rng = seeded(7);
    for (let n = 0; n < 200; n++) {
      const { c, cap } = bandCampaign(rng);
      const pieces = c.tranches.map((t) => BigInt(t.amount));
      expect(pieces.length, `case ${n}`).toBeGreaterThanOrEqual(4);
      expect(sum(pieces), `case ${n}`).toBe(BigInt(c.request.amount));
      for (const p of pieces) expect(p <= cap, `case ${n}: ${p} ≤ ${cap}`).toBe(true);
      expect(new Set(pieces.map(String)).size, `case ${n}: varied sizes`).toBeGreaterThan(1);
      for (let i = 1; i < pieces.length - 1; i++) expect(pieces[i], `case ${n}: piece ${i} differs from its neighbour`).not.toBe(pieces[i - 1]);
      expect(pieces.slice(0, 4), `case ${n}: never the V5 quarters`).not.toEqual([cap, cap, cap, cap]);
    }
  });

  it(`${CASES} random worlds through the runner's reducer: in flight ≤ the limit, one step at a time, the accounting kept`, () => {
    let events = 0,
      completed = 0,
      returned = 0;
    for (let n = 0; n < CASES; n++) {
      const rng = seeded(5000 + n);
      let { c, cap } = bandCampaign(rng);
      check(c, cap, `case ${n} at start`);
      for (let step = 0; step < 300 && c.state !== "completed" && c.state !== "cancelled"; step++) {
        const now = 2_000_000 + step * 15_000;
        const r = rng();
        if (r < 0.03 && c.state === "running") {
          // the user returns the rest: the planned steps are skipped, a funded one is refunded, one in flight finishes
          c = withCampaignState(c, "winding-down", now);
          for (const t of c.tranches) if (t.state === "planned" || t.state === "ready") c = withTrancheState(c, t.index, "skipped" as TrancheState, now);
        } else if (r < 0.05 && c.state === "running") c = withCampaignState(c, "paused", now);
        else if (c.state === "paused" && r < 0.5)
          c = withCampaignState(withCampaignState(c, "reassessing", now), "running", now); // resumed: reassessed, then running (no route change in this world)
        else c = apply(c, rng, now);
        events++;
        check(c, cap, `case ${n} step ${step}`);
      }
      if (c.state === "completed") completed++;
      if (c.state === "cancelled") returned++;
    }
    expect(events).toBeGreaterThan(CASES * 10);
    // liveness: every world ends — completed, or the rest returned (a step committed but never funded when the user
    // returned the rest held its campaign in winding-down forever until the reducer's `abandon`, V6 Stage 13)
    expect(completed + returned, "every world ends").toBe(CASES);
    expect(completed, "worlds run to the end").toBeGreaterThan(CASES / 5);
    expect(returned, "worlds return the rest").toBeGreaterThan(CASES / 5);
  });
});
