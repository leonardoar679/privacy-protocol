// The privacy assessment (contract §3.11; plan §52, §112, §114): six linkabilities measured from stated facts, the score
// and the level, the basis sentences, and the plan's §112 pattern flagged on amount and timing together.
import { describe, it, expect } from "vitest";
import { assessPrivacy, crossChainEffectiveSet, type PrivacyAssessmentFacts } from "../src/wallet/privacyAssessment";

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
});
