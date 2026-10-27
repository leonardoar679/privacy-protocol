// A protected execution's pieces are bound like a single order (spec v3.0 §3; doc §6 rule 5; V7 Stage 12): the campaign's
// bounds carry the relayer's F the Review showed, and each piece's funding may pay at most its privacy share plus that F —
// the stored swap's `reviewedFee`, which the funding never exceeds. A campaign from before (no F recorded) stays unbounded.
import { describe, expect, it } from "vitest";
import { PRIVACY_FEE_BPS, privacyFee } from "@privacy-wallet/protocol/wallet/fees";
import { stepReviewedFee } from "../src/wallet/campaigns";

describe("stepReviewedFee", () => {
  it("is the piece's privacy share plus the Review's F, in base units", () => {
    const F = 11n * 10n ** 14n; // 0.0011 ETH: the relayer's minimum with the wallet's margin
    const piece = 25n * 10n ** 18n; // a 25 ETH step
    expect(stepReviewedFee({ maxRelayerFee: F.toString() }, piece)).toBe(privacyFee(piece, PRIVACY_FEE_BPS) + F);
    expect(stepReviewedFee({ maxRelayerFee: F.toString() }, piece)).toBe(25n * 10n ** 16n + F); // exactly 1 % of a round piece
  });
  it("rounds the share up by at most one base unit, as the single order's fee does", () => {
    expect(stepReviewedFee({ maxRelayerFee: "0" }, 1n)).toBe(1n);
    expect(stepReviewedFee({ maxRelayerFee: "0" }, 99n)).toBe(1n);
    expect(stepReviewedFee({ maxRelayerFee: "0" }, 100n)).toBe(1n);
    expect(stepReviewedFee({ maxRelayerFee: "0" }, 101n)).toBe(2n);
  });
  it("is undefined for a campaign whose Review recorded no F (one from before), or a malformed one", () => {
    expect(stepReviewedFee({}, 10n ** 18n)).toBeUndefined();
    expect(stepReviewedFee({ maxRelayerFee: "not a number" }, 10n ** 18n)).toBeUndefined();
  });
});
