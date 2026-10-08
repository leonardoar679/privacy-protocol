// The privacy lint (whale spec §18): the eleven items with their categories, block only at tier ≥ high-value
// (a warning with the same text below), acknowledgements, the large-piece rule, and the wording rule.
import { describe, it, expect } from "vitest";
import { HOLDERS_FLOOR, lint, lintSummary, unacknowledgedBlocks, type LintFacts } from "../src/wallet/privacyLint";

const base: LintFacts = {
  action: "swap", tier: "standard", sourceIsPool: true, destinationKind: "fresh", destinationIsPublicWallet: false, linkPublic: true, providerIdentityDetached: true,
  delaySeconds: 6 * 3600, amountIsBucket: true, minOutVerified: true, privateSubmission: true, rpcEndpoints: 2, lightClient: true, largePiece: { inAlphabet: true, holders: null },
};
const byId = (items: ReturnType<typeof lint>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe("privacy lint", () => {
  it("a clean high-value swap: every item ok except the public link, which warns with the plan §76 wording", () => {
    const items = lint({ ...base, tier: "high-value" });
    expect(items.map((i) => i.id)).toEqual(["source-not-reused", "private-wallet-used", "destination-fresh", "destination-not-public-wallet", "no-public-linkage", "provider-identity-detached", "timing", "amount-fingerprint", "minimum-protected", "network", "large-piece"]);
    const m = byId(items);
    expect(m["no-public-linkage"].level).toBe("warn");
    expect(m["no-public-linkage"].text).toMatch(/settles publicly.*private source stays protected.*timing and amount may be correlated/);
    expect(items.filter((i) => i.id !== "no-public-linkage").every((i) => i.level === "ok")).toBe(true);
    expect(unacknowledgedBlocks(items)).toEqual([]);
    expect(lintSummary(items)).toEqual({ ok: 10, warn: 1, block: 0 });
    for (const i of items) expect(i.text.toLowerCase()).not.toMatch(/anonymous|100 ?%/);
  });

  it("block items block only from the high-value tier and clear with an acknowledgement", () => {
    const facts: LintFacts = { ...base, destinationIsPublicWallet: true, minOutVerified: false };
    const std = byId(lint(facts));
    expect(std["destination-not-public-wallet"].level).toBe("warn");
    expect(std["minimum-protected"].level).toBe("warn");
    const hv = lint({ ...facts, tier: "high-value" });
    expect(byId(hv)["destination-not-public-wallet"].level).toBe("block");
    expect(byId(hv)["minimum-protected"].level).toBe("block");
    expect(unacknowledgedBlocks(hv).map((i) => i.id)).toEqual(["destination-not-public-wallet", "minimum-protected"]);
    const acked = lint({ ...facts, tier: "institutional", acknowledged: ["destination-not-public-wallet"] });
    expect(byId(acked)["destination-not-public-wallet"]).toMatchObject({ level: "block", acknowledged: true });
    expect(unacknowledgedBlocks(acked).map((i) => i.id)).toEqual(["minimum-protected"]);
  });

  it("entered destinations, short delays, exact amounts, the network and the quotes' identity warn with their category", () => {
    const m = byId(lint({ ...base, destinationKind: "entered", delaySeconds: 3600, amountIsBucket: false, privateSubmission: false, rpcEndpoints: 1, lightClient: false, providerIdentityDetached: false, linkPublic: false }));
    expect(m["destination-fresh"]).toMatchObject({ level: "warn", category: "Destination linkage" });
    expect(m["timing"]).toMatchObject({ level: "warn", category: "Timing risk" });
    expect(m["amount-fingerprint"]).toMatchObject({ level: "warn", category: "Amount fingerprint" });
    expect(m["network"]).toMatchObject({ level: "warn", category: "Network privacy" });
    expect(m["network"].text).toMatch(/connected wallet submits.*one RPC endpoint.*no light client/);
    expect(m["provider-identity-detached"]).toMatchObject({ level: "warn", category: "Provider visibility" });
    expect(m["no-public-linkage"].level).toBe("ok");
    expect(byId(lint({ ...base, delaySeconds: 0 }))["timing"].text).toMatch(/without a delay/);
  });

  it("the large piece: in the alphabet ok; unknown holders warn; 16 holders ok; fewer is a whale among whales", () => {
    expect(byId(lint({ ...base, largePiece: { inAlphabet: false, holders: null } }))["large-piece"].level).toBe("warn");
    expect(byId(lint({ ...base, largePiece: { inAlphabet: false, holders: HOLDERS_FLOOR } }))["large-piece"].level).toBe("ok");
    const few = byId(lint({ ...base, largePiece: { inAlphabet: false, holders: 3 } }))["large-piece"];
    expect(few.level).toBe("warn");
    expect(few.text).toMatch(/whale among whales: only 3 holders/);
    expect(lint({ ...base, largePiece: null }).some((i) => i.id === "large-piece")).toBe(false);
  });

  it("a withdrawal has no provider items; a private transfer has nothing public to time or fingerprint", () => {
    const w = lint({ ...base, action: "withdraw", linkPublic: null, providerIdentityDetached: null, minOutVerified: null });
    expect(w.map((i) => i.id)).not.toContain("no-public-linkage");
    expect(w.map((i) => i.id)).not.toContain("minimum-protected");
    const t = byId(lint({ ...base, action: "transfer", destinationKind: "privacy-address", delaySeconds: 0, amountIsBucket: false, largePiece: null }));
    expect(t["timing"].level).toBe("ok");
    expect(t["amount-fingerprint"].level).toBe("ok");
    expect(t["destination-fresh"].text).toMatch(/privacy address/);
  });
});
