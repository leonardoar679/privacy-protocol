// The privacy assessment (contract §3.11; plan §52, §112, §114): six linkabilities measured from stated facts, the score
// and the level, the basis sentences, and the plan's §112 pattern flagged on amount and timing together.
import { describe, it, expect } from "vitest";
import { BASIS_CODES, assessPrivacy, assessSwapPrivacy, crossChainEffectiveSet, timingOfFunding, type PrivacyAssessmentFacts } from "../src/wallet/privacyAssessment";

const good: PrivacyAssessmentFacts = { sourceIsPool: true, amount: { kind: "bucket" }, delaySeconds: 6 * 3600, destination: "fresh-per-tranche", steps: 40, provider: { linkPublic: true, kind: "deposit-address", coverPerHour: 40, etaSeconds: 1200 }, crossChain: true };

describe("assessPrivacy", () => {
  it("a protected campaign from the pool to fresh addresses on a random cadence: every linkability low, the level Excellent or Good, six basis sentences", () => {
    const a = assessPrivacy(good);
    expect(a.components.source).toBe(0);
    expect(a.components.amount).toBe(0);
    expect(a.components.timing).toBe(0);
    expect(a.components.destination).toBe(0);
    expect(a.components.provider).toBeLessThan(0.5);
    expect(a.components.crossChain).toBeGreaterThan(0);
    expect(a.score).toBeGreaterThanOrEqual(85);
    expect(a.level).toBe("Excellent");
    expect(a.basis).toHaveLength(6);
    expect(a.pattern).toEqual({ sameSizeConsecutive: false, cadenceFixed: false, destinationShared: false });
  });
  it("the plan's §112 pattern — equal pieces on a fixed cadence — flags amount and timing together and drops the level", () => {
    const a = assessPrivacy({ ...good, sameSizeConsecutive: true, cadenceFixed: true });
    expect(a.components.timing).toBe(1);
    expect(a.components.amount).toBeGreaterThanOrEqual(0.7);
    expect(a.pattern).toMatchObject({ sameSizeConsecutive: true, cadenceFixed: true });
    expect(a.score).toBeLessThan(assessPrivacy(good).score);
    expect(a.basis.some((b) => /fixed interval/.test(b))).toBe(true);
    // the same sizes without the clock are the design of bucket sizing: not flagged by themselves
    expect(assessPrivacy({ ...good, sameSizeConsecutive: true }).components.amount).toBe(0);
  });
  it("one entered address shared by every step links the steps; the public wallet as destination is linked; a public source is linked", () => {
    const shared = assessPrivacy({ ...good, destination: "entered" });
    expect(shared.components.destination).toBe(1);
    expect(shared.pattern.destinationShared).toBe(true);
    expect(shared.basis.some((b) => /same entered address/.test(b))).toBe(true);
    expect(assessPrivacy({ ...good, destination: "entered", steps: 1 }).pattern.destinationShared).toBe(false);
    expect(assessPrivacy({ ...good, destination: "public-wallet" }).components.destination).toBe(1);
    expect(assessPrivacy({ ...good, sourceIsPool: false }).components.source).toBe(1);
    expect(assessPrivacy({ ...good, sourceIsPool: false, destination: "public-wallet", amount: { kind: "exact" }, delaySeconds: 0 }).level).toBe("Reduced");
  });
  it("amount and timing scales; the provider and cross-chain legs from the link and the cover traffic", () => {
    expect(assessPrivacy({ ...good, amount: { kind: "pair" } }).components.amount).toBe(0.3);
    expect(assessPrivacy({ ...good, amount: { kind: "exact", uniqueness: 0.95 } }).components.amount).toBe(0.95);
    expect(assessPrivacy({ ...good, amount: { kind: "exact" } }).components.amount).toBe(0.8);
    expect(assessPrivacy({ ...good, delaySeconds: 3600 }).components.timing).toBe(0.3);
    expect(assessPrivacy({ ...good, delaySeconds: 300 }).components.timing).toBe(0.7);
    expect(assessPrivacy({ ...good, delaySeconds: 10 }).components.timing).toBe(1);
    expect(assessPrivacy({ ...good, provider: { linkPublic: null } }).components).toMatchObject({ provider: 0.5, crossChain: 0.5 });
    expect(assessPrivacy({ ...good, provider: { linkPublic: false, kind: "deposit-address" } }).components).toMatchObject({ provider: 0.15, crossChain: 0 });
    expect(assessPrivacy({ ...good, crossChain: false }).components.crossChain).toBe(0);
    // more cover traffic → a larger effective set → a smaller cross-chain linkability
    const thin = assessPrivacy({ ...good, provider: { ...good.provider, coverPerHour: 1 } }).components.crossChain;
    const deep = assessPrivacy({ ...good, provider: { ...good.provider, coverPerHour: 2000 } }).components.crossChain;
    expect(deep).toBeLessThan(thin);
    expect(crossChainEffectiveSet({ coverPerHour: 2000, etaSeconds: 1200 }, true)).toBeGreaterThan(crossChainEffectiveSet({ coverPerHour: 1, etaSeconds: 1200 }, true));
  });

  it("each basis sentence names its code and values, for the app's catalog (audit round 2, r55)", () => {
    const a = assessPrivacy(good);
    expect(a.basisWords).toHaveLength(a.basis.length);
    expect(a.basisWords!.map((w) => w.code)).toEqual(["source-pool", "amount-bucket", "timing-delayed", "dest-fresh-per-step", "provider-public", "crosschain-public"]);
    expect(a.basisWords![2]).toEqual({ code: "timing-delayed", hours: 6 });
    expect(a.basisWords![5].set).toBe(a.basis[5].match(/effective set of ([\d.]+)\./)![1]);
    const facts: PrivacyAssessmentFacts[] = [
      { ...good, sourceIsPool: false, amount: { kind: "pair" }, delaySeconds: 2 * 3600, destination: "entered", steps: 1, provider: { linkPublic: null }, crossChain: false },
      { ...good, amount: { kind: "exact" }, delaySeconds: 0, destination: "entered", provider: { linkPublic: false, kind: "deposit-address" }, cadenceFixed: true, sameSizeConsecutive: true },
      { ...good, destination: "privacy-address", provider: { linkPublic: false }, delaySeconds: 60 },
      { ...good, destination: "fresh", steps: 1 },
      { ...good, destination: "public-wallet" },
      { ...good, provider: { linkPublic: false } },
    ];
    const codes = new Set([assessPrivacy(good), ...facts.map((f) => assessPrivacy(f))].flatMap((x) => x.basisWords!.map((w) => w.code)));
    expect([...codes].sort()).toEqual([...BASIS_CODES].sort());
  });
});

describe("V6 timing from the funding's youngest note (spec v2.0 §14.1)", () => {
  const H = 3600;
  it("1 under an hour or ten deposits, 0.7 under six hours or fifty, 0.3 under a day, else 0; an unknown age counts by the deposits", () => {
    expect(timingOfFunding({ ageSeconds: 30 * 60, depositsSince: 500 })).toBe(1);
    expect(timingOfFunding({ ageSeconds: 30 * H, depositsSince: 9 })).toBe(1);
    expect(timingOfFunding({ ageSeconds: 2 * H, depositsSince: 500 })).toBe(0.7);
    expect(timingOfFunding({ ageSeconds: 30 * H, depositsSince: 49 })).toBe(0.7);
    expect(timingOfFunding({ ageSeconds: 12 * H, depositsSince: 500 })).toBe(0.3);
    expect(timingOfFunding({ ageSeconds: 30 * H, depositsSince: 500 })).toBe(0);
    expect(timingOfFunding({ ageSeconds: null, depositsSince: 500 }), "a note a scan found: the deposits alone").toBe(0);
    expect(timingOfFunding({ ageSeconds: null, depositsSince: 5 })).toBe(1);
    expect(timingOfFunding({ ageSeconds: null, depositsSince: null }), "nothing known").toBe(0.3);
  });
  it("a delayed funding ages by the delay's lower bound; the deposits still to come are not held against it", () => {
    expect(timingOfFunding({ ageSeconds: 0, depositsSince: 0, delaySeconds: H })).toBe(0.7);
    expect(timingOfFunding({ ageSeconds: 0, depositsSince: 0, delaySeconds: 6 * H })).toBe(0.3);
  });
  const swap = { sourceIsPool: true, amount: { kind: "bucket" as const }, destination: "fresh" as const, provider: { linkPublic: true, kind: "deposit-address" as const }, crossChain: true };
  it("right after a protect the level is at most medium and 'recent' is the first reason; aged funds read high", () => {
    const fresh = assessSwapPrivacy({ ...swap, timing: { ageSeconds: 60, depositsSince: 2 } });
    expect(fresh).toMatchObject({ recent: true, level: "medium" });
    expect(fresh.reasons[0]).toBe("recent");
    expect(fresh.components.timing).toBe(1);
    const aged = assessSwapPrivacy({ ...swap, timing: { ageSeconds: 3 * 86400, depositsSince: 900 } });
    expect(aged).toMatchObject({ recent: false, level: "high" });
    expect(aged.score).toBeGreaterThan(fresh.score);
  });
  it("an exact amount and an entered destination lower the score and say so", () => {
    const a = assessSwapPrivacy({ ...swap, amount: { kind: "exact", uniqueness: 0.9 }, destination: "entered", timing: { ageSeconds: 3 * 86400, depositsSince: 900 } });
    expect(a.reasons).toEqual(expect.arrayContaining(["exact-amount", "entered-destination", "public-link"]));
    expect(a.level).not.toBe("high");
  });
});
