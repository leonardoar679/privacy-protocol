// A protected execution's pieces are bound like a single order (spec v3.0 §3; doc §6 rule 5; V7 Stage 12): the campaign's
// bounds carry the relayer's F and basis points the Review showed, and each piece's funding may pay at most the one fee
// note for delivering the piece under those terms — exact output, as the funding prices it — the stored swap's
// `reviewedFee`, which the funding never exceeds. A campaign from before (no F recorded) stays unbounded. The first full
// local run after Stage 12 found the earlier bound (the piece's privacy share alone plus F) below the relayer's rule.
import { describe, expect, it } from "vitest";
import { PRIVACY_FEE_BPS, feeForWithdrawal, feeMeetsTerms, privacyFee } from "@privacy-wallet/protocol/wallet/fees";
import { stepReviewedFee } from "../src/wallet/campaigns";

describe("stepReviewedFee", () => {
  const F = 11n * 10n ** 14n; // 0.0011 ETH: the relayer's minimum with the wallet's margin
  const piece = 25n * 10n ** 18n; // a 25 ETH step
  it("is the one fee note for delivering the piece under the Review's terms — exact output, p(W + f) + F, as the funding prices it", () => {
    const bound = stepReviewedFee({ maxRelayerFee: F.toString() }, piece)!;
    expect(bound).toBe(feeForWithdrawal(piece, { minimum: F, feePercentBps: PRIVACY_FEE_BPS }));
    expect(bound, "more than the piece's own share plus F: the fee note is part of what leaves").toBeGreaterThan(privacyFee(piece, PRIVACY_FEE_BPS) + F);
    expect(feeMeetsTerms(piece, bound, PRIVACY_FEE_BPS, F).ok, "the relayer's rule for delivering W accepts it").toBe(true);
    // the regression: the piece's privacy share alone plus F is refused by that rule — every step's funding was, as a moved fee
    expect(feeMeetsTerms(piece, privacyFee(piece, PRIVACY_FEE_BPS) + F, PRIVACY_FEE_BPS, F).ok).toBe(false);
  });
  it("holds for the smallest pieces too: the relayer's rule accepts the bound at every size", () => {
    for (const w of [1n, 99n, 100n, 101n, 12_345n, 10n ** 18n]) {
      const bound = stepReviewedFee({ maxRelayerFee: "0" }, w)!;
      expect(feeMeetsTerms(w, bound, PRIVACY_FEE_BPS, 0n).ok, String(w)).toBe(true);
      expect(bound, "never more than one base unit above the rule's requirement").toBeLessThanOrEqual(
        feeMeetsTerms(w, bound, PRIVACY_FEE_BPS, 0n).required + 1n,
      );
    }
  });
  it("takes the relayer's basis points the Review recorded; the product's 1 % when the campaign recorded none", () => {
    expect(stepReviewedFee({ maxRelayerFee: F.toString(), relayerFeeBps: 50 }, piece)).toBe(feeForWithdrawal(piece, { minimum: F, feePercentBps: 50 }));
    expect(stepReviewedFee({ maxRelayerFee: F.toString(), relayerFeeBps: 0 }, piece)).toBe(F);
    expect(stepReviewedFee({ maxRelayerFee: F.toString() }, piece)).toBe(
      stepReviewedFee({ maxRelayerFee: F.toString(), relayerFeeBps: PRIVACY_FEE_BPS }, piece),
    );
  });
  it("is undefined for a campaign whose Review recorded no F (one from before), or a malformed one", () => {
    expect(stepReviewedFee({}, 10n ** 18n)).toBeUndefined();
    expect(stepReviewedFee({ maxRelayerFee: "not a number" }, 10n ** 18n)).toBeUndefined();
  });
});
