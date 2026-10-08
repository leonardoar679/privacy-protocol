// The plan's §117 property test: random order sizes, decimals, bands, caps, provider sets, tranche sizes and settlement
// sequences; after every event the ledger must satisfy I1 (inFlight ≤ cap), I2 (every piece ≤ cap), I6
// (providerExposure ≤ providerLimit) and the accounting identity. The releases go through canRelease exactly as the
// runner's reducer admits them; the world (settled / partial / refund / failure / unknown) is drawn at random.
import { describe, it, expect } from "vitest";
import { canPrepare, canRelease, exposure, planTranches, providerLimit, withTrancheState, IN_FLIGHT, type Campaign, type TrancheState } from "../../../reference/typescript/src/wallet/campaign";
import { campaign, seeded } from "../helpers";

const PROVIDERS = ["thorchain", "chainflip", "mayan", "near-intents"];
const CASES = 1000;

function randomCampaign(rng: () => number): { c: Campaign; cap: bigint } {
  const decimals = rng() < 0.5 ? 18 : 6;
  const units = 10n ** BigInt(decimals);
  const total = BigInt(50 + Math.floor(rng() * 50_000)) * units; // 50 … 50,000 units
  const capBps = [100, 200, 250, 300, 500][Math.floor(rng() * 5)];
  const lower = [100, 150, 200][Math.floor(rng() * 3)];
  const bandBps: [number, number] = [Math.min(lower, capBps), Math.max(Math.min(lower, capBps), Math.min(300, capBps))];
  const maxParallel = 1 + Math.floor(rng() * 3);
  const shareCap = rng() < 0.5 ? 10000 : 2000 + Math.floor(rng() * 8) * 1000;
  const split = planTranches(total, { decimals, bandBps, capBps, sizing: rng() < 0.5 ? "bucket" : "varied", maxParallel, rng });
  const c = campaign(split.pieces, [], {}, { capBps, bandBps, concurrency: maxParallel > 1 ? "parallel" : "sequential", maxParallel, providerShareCapBps: shareCap });
  return { c, cap: (total * BigInt(capBps)) / 10000n };
}

function check(c: Campaign, cap: bigint, where: string): void {
  const e = exposure(c);
  if (e.inFlight > cap) throw new Error(`I1 broken ${where}: inFlight ${e.inFlight} > cap ${cap}`);
  const limit = providerLimit(c);
  for (const [p, v] of Object.entries(e.byProvider)) if (v > limit) throw new Error(`I6 broken ${where}: ${p} ${v} > ${limit}`);
  for (const t of c.tranches) if (BigInt(t.amount) > cap) throw new Error(`I2 broken ${where}: piece ${t.amount} > cap ${cap}`);
  const total = BigInt(c.request.amount);
  if (e.completed + e.inFlight + e.prepared + e.remaining !== total) throw new Error(`the accounting identity broke ${where}`);
}

describe("plan §117: inFlight ≤ exposureCap always holds", () => {
  it(`${CASES} random campaigns and event sequences: I1, I2, I6 and the identity after every event`, () => {
    let events = 0, releases = 0;
    for (let n = 0; n < CASES; n++) {
      const rng = seeded(1000 + n);
      let { c, cap } = randomCampaign(rng);
      check(c, cap, `case ${n} at start`);
      for (let step = 0; step < 400; step++) {
        const open = c.tranches.filter((t) => IN_FLIGHT.includes(t.state));
        const planned = c.tranches.find((t) => t.state === "planned");
        if (!open.length && !planned) break;
        const r = rng();
        if (planned && r < 0.5) {
          // a release the way the runner admits it: the provider drawn at commit, the invariants checked at the hand-over
          const provider = PROVIDERS[Math.floor(rng() * PROVIDERS.length)];
          if (canPrepare(c).ok && canRelease(c, BigInt(planned.amount), provider).ok) { c = withTrancheState(c, planned.index, "executing", step, { provider }); releases++; }
          else if (!open.length) { // nothing in flight and still refused: only the first-tranche rule or the parallel limit can say so — never a stuck campaign
            const why = canRelease(c, BigInt(planned.amount), provider);
            if (!why.ok && !/first tranche|parallel|sequential|I6/.test(why.reason)) throw new Error(`stuck: ${why.reason}`);
            // I6 with nothing in flight means byProvider is stale: impossible, byProvider counts in-flight only
            if (!why.ok && /I6/.test(why.reason)) throw new Error(`I6 refused with nothing in flight: ${why.reason}`);
          }
        } else if (open.length) {
          const t = open[Math.floor(rng() * open.length)];
          const next = rng();
          const to: TrancheState = next < 0.55 ? "settled" : next < 0.7 ? "destination-confirmed" : next < 0.8 ? "partial" : next < 0.9 ? "refunded" : "failed";
          if (to === "partial") {
            const amount = BigInt(t.amount);
            const delivered = (amount * BigInt(1 + Math.floor(rng() * 99))) / 100n;
            c = withTrancheState(c, t.index, "partial", step, { outcome: { delivered: delivered.toString() } });
          } else if (to === "destination-confirmed" && t.state !== "destination-confirmed") c = withTrancheState(c, t.index, "destination-confirmed", step, { deliveredSince: step });
          else if (to !== "destination-confirmed") c = withTrancheState(c, t.index, to, step);
        }
        events++;
        check(c, cap, `case ${n} step ${step}`);
      }
    }
    expect(events).toBeGreaterThan(CASES * 10);
    expect(releases).toBeGreaterThan(CASES * 5);
  });
  it("the counter-example cannot be built: a piece above the cap is refused by I2 before anything else", () => {
    const rng = seeded(42);
    for (let n = 0; n < 200; n++) {
      const { c, cap } = randomCampaign(rng);
      expect(canRelease(c, cap + 1n, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I2") });
    }
  });
});
