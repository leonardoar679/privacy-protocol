// Privacy (plan §48–§54, §112, §114; contract §3.11): the eight privacy invariants measured, not promised —
// I-P 1 no permanent identity, 2 fresh execution addresses preferred, 3 destination reuse discouraged, 4 identical
// patterns discouraged, 5 the timing fingerprint measured, 6 the amount fingerprint measured, 7 provider correlation
// measured, 8 the assessment exists before signing (its level is what the Review shows); the plan's §112 test.
import { describe, it, expect } from "vitest";
import { assessPrivacy } from "../../../packages/protocol/src/wallet/privacyAssessment";
import { lint, type LintFacts } from "../../../packages/protocol/src/wallet/privacyLint";
import { addEntry, markSettled, markUsed, selectable } from "../../../packages/protocol/src/wallet/addressBook";

const base = { sourceIsPool: true, amount: { kind: "bucket" as const }, delaySeconds: 6 * 3600, destination: "fresh-per-tranche" as const, steps: 40, provider: { linkPublic: true, kind: "deposit-address" as const, coverPerHour: 60, etaSeconds: 1200 }, crossChain: true };
const lintFacts = (campaign: NonNullable<LintFacts["campaign"]>): LintFacts => ({ action: "swap", tier: "high-value", sourceIsPool: true, destinationKind: "fresh", destinationIsPublicWallet: false, linkPublic: true, providerIdentityDetached: true, delaySeconds: 3600, amountIsBucket: true, minOutVerified: true, privateSubmission: true, rpcEndpoints: 2, lightClient: true, largePiece: null, campaign });

describe("the privacy invariants (plan §114)", () => {
  it("I-P 1 and 2: the pool pays a one-time escrow (no permanent identity) and fresh addresses are the default destination — both score 0 linkability", () => {
    const a = assessPrivacy(base);
    expect(a.components.source).toBe(0);
    expect(a.components.destination).toBe(0);
    expect(assessPrivacy({ ...base, sourceIsPool: false }).components.source).toBe(1);
  });
  it("I-P 3: destination reuse is discouraged — a shared entered address links the steps, the lint says so, a fresh address retires after one use", () => {
    expect(assessPrivacy({ ...base, destination: "entered" }).components.destination).toBe(1);
    const items = lint(lintFacts({ sizing: "varied", consecutiveSameSize: false, destinationPerTranche: false, cadenceFixed: false, destinationCooling: false }));
    expect(items.find((i) => i.id === "tranche-link")).toMatchObject({ level: "warn" });
    const fresh = addEntry({ id: "f", chain: "bitcoin", address: "bc1qf", normalized: "bc1qf", source: "fresh", now: 1 });
    expect(selectable([markSettled(markUsed(fresh, "c1", 2), 3)])).toEqual([]);
  });
  it("I-P 4, 5, 6: identical patterns, the timing and the amount fingerprints are measured — the plan's §112 case ($250K every 60 s) is flagged on both", () => {
    const clocked = assessPrivacy({ ...base, amount: { kind: "bucket" }, delaySeconds: 60, sameSizeConsecutive: true, cadenceFixed: true });
    expect(clocked.components.timing).toBe(1);
    expect(clocked.components.amount).toBeGreaterThanOrEqual(0.7);
    expect(clocked.pattern).toEqual({ sameSizeConsecutive: true, cadenceFixed: true, destinationShared: false });
    expect(clocked.score).toBeLessThan(assessPrivacy(base).score);
    const items = lint(lintFacts({ sizing: "varied", consecutiveSameSize: true, destinationPerTranche: true, cadenceFixed: true, destinationCooling: false }));
    expect(items.find((i) => i.id === "exact-cadence")).toMatchObject({ level: "block" });
    expect(items.find((i) => i.id === "same-size-consecutive")).toMatchObject({ level: "warn" });
    expect(assessPrivacy({ ...base, amount: { kind: "exact", uniqueness: 0.9 } }).components.amount).toBe(0.9);
    expect(assessPrivacy({ ...base, delaySeconds: 10 }).components.timing).toBe(1);
  });
  it("I-P 7: provider correlation is measured from the published link and the cover traffic", () => {
    const thin = assessPrivacy({ ...base, provider: { ...base.provider, coverPerHour: 1 } });
    const deep = assessPrivacy({ ...base, provider: { ...base.provider, coverPerHour: 5000 } });
    expect(deep.components.crossChain).toBeLessThan(thin.components.crossChain);
    expect(assessPrivacy({ ...base, provider: { linkPublic: false, kind: "deposit-address" } }).components.crossChain).toBe(0);
    expect(assessPrivacy({ ...base, provider: { linkPublic: null } }).components.provider).toBe(0.5);
  });
  it("I-P 8: the assessment is a level with a basis sentence per component — what the Review shows beside SECURITY", () => {
    const a = assessPrivacy(base);
    expect(["Excellent", "Good", "Reduced"]).toContain(a.level);
    expect(a.basis).toHaveLength(6);
    expect(a.basis.join(" ")).not.toMatch(/anonymous/i);
  });
});
