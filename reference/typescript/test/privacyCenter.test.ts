// The Privacy Center model (plan V2 §75, §93): six categories with word levels from the scorecard's
// calibration, the overall is the weakest known level, the limits are always stated, and nothing says "anonymous".
import { describe, it, expect } from "vitest";
import { LIMITS, levelOf, privacyPosture } from "../src/wallet/privacyCenter";

const base = { poolSize: 2000, delayWindow: [3600, 86400] as [number, number], privateSubmission: true, rpcEndpoints: 2, lightClient: true, freshDestinations: true };

describe("privacy posture", () => {
  it("levels: 85+ Excellent, 60+ Good, below Reduced", () => {
    expect(levelOf(85)).toBe("Excellent");
    expect(levelOf(84)).toBe("Good");
    expect(levelOf(60)).toBe("Good");
    expect(levelOf(59)).toBe("Reduced");
  });

  it("a relayer, two endpoints, the light client and a balanced window are Good overall; best-privacy lifts timing to Excellent", () => {
    const p = privacyPosture(base);
    expect(p.categories.map((c) => c.id)).toEqual(["financial", "addresses", "network", "rpc", "timing", "crossChain"]);
    expect(p.categories.find((c) => c.id === "timing")!.level).toBe("Good");
    expect(p.categories.find((c) => c.id === "addresses")!.level).toBe("Excellent");
    expect(p.overall).toBe("Good");
    const slow = privacyPosture({ ...base, delayWindow: [6 * 3600, 72 * 3600] });
    expect(slow.categories.find((c) => c.id === "timing")!.level).toBe("Excellent");
  });

  it("fastest, one endpoint or a public submission are Reduced, and the overall follows the weakest", () => {
    expect(privacyPosture({ ...base, delayWindow: [0, 0] }).categories.find((c) => c.id === "timing")!.level).toBe("Reduced");
    expect(privacyPosture({ ...base, rpcEndpoints: 1 }).categories.find((c) => c.id === "rpc")!.level).toBe("Reduced");
    expect(privacyPosture({ ...base, privateSubmission: false }).overall).toBe("Reduced");
  });

  it("the pool is unknown until the first sync; the limits are stated and never promise anonymity", () => {
    const p = privacyPosture({ ...base, poolSize: null });
    const fin = p.categories.find((c) => c.id === "financial")!;
    expect(fin.score).toBeNull();
    expect(fin.level).toBeNull();
    expect(fin.why[0]).toMatch(/first sync/);
    expect(p.overall).toBe("Good"); // the unknown category does not count
    expect(p.limits).toEqual([...LIMITS]);
    for (const text of [...p.limits, ...p.categories.flatMap((c) => c.why)]) expect(text.toLowerCase()).not.toMatch(/anonymous|100 ?%/);
    const linked = privacyPosture({ ...base, crossChain: { privacy: 72, linkPublic: true } }).categories.find((c) => c.id === "crossChain")!;
    expect(linked.score).toBe(67);
    expect(linked.why[1]).toMatch(/publishes/);
  });
});
