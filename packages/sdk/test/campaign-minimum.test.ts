// The band's steps Review states what the steps are held to (the third review round, 2026-11-03): the campaign's per-unit price bound
// over the steps' amount, net of the tips — never the one order's minimum, which no step was held to and which the campaign could
// deliver ~0.5 % under without a pause.
import { describe, expect, it } from "vitest";
import { rateE18, trancheMinimum, CONGESTION_FACTOR, type ExecutionBounds } from "@privacy-wallet/protocol/wallet/campaign";
import { BOUNDS_SLIPPAGE_BPS, campaignMinimumOutput } from "../src/wallet/campaigns";

const slip = (rate: bigint) => (rate * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n;

describe("campaignMinimumOutput (V3 §3, as the Review states it)", () => {
  // 80,000 USDC → BTC: the one order's funding W = 79,195.90 USDC quoted at 1.20 BTC minimum; five steps over 79,177.449980 USDC, a 4.10 USDC tip each
  const toAmountMin = 120_000_000n;
  const quoted = 79_195_900_000n;
  const amount = 79_177_449_980n;
  const tip = 4_100_000n;
  const bounds = {
    minimumOutput: slip(rateE18(toAmountMin, quoted)).toString(),
    minimumOutputNet: slip(rateE18(toAmountMin, quoted - tip)).toString(),
  } as unknown as ExecutionBounds;
  const pieces = [20_000_000_000n, 15_500_000_000n, 18_000_000_000n, 12_677_449_980n, 13_000_000_000n];
  it("is at most what the steps guarantee together at the most each step's tip may be, and within a unit per step of that", () => {
    expect(pieces.reduce((s, p) => s + p, 0n)).toBe(amount);
    const together = pieces.reduce((s, w) => s + trancheMinimum(bounds, w, tip), 0n);
    // the seventh review round (B2): each step's tip is held to the set's × CONGESTION_FACTOR, and the figure counts every step at that
    const most = tip * BigInt(CONGESTION_FACTOR);
    const atMost = pieces.reduce((s, w) => s + trancheMinimum(bounds, w, most), 0n);
    const stated = campaignMinimumOutput({ toAmountMin, quoted, amount, executorTip: tip, steps: pieces.length });
    expect(stated <= atMost, "never above the steps' own floors, whatever tip each pays under the bound").toBe(true);
    expect(atMost - stated <= BigInt(pieces.length) + 1n, "and close to them").toBe(true);
    expect(stated <= together, "below the floors at today's tip").toBe(true);
  });
  it("the reviewer's gas rise under the pause: steps 2–5 pay 2.9× the tip, the steps together still guarantee the stated figure (B2)", () => {
    const tips = [tip, (tip * 29n) / 10n, (tip * 29n) / 10n, (tip * 29n) / 10n, (tip * 29n) / 10n];
    const together = pieces.reduce((s, w, i) => s + trancheMinimum(bounds, w, tips[i]), 0n);
    const stated = campaignMinimumOutput({ toAmountMin, quoted, amount, executorTip: tip, steps: pieces.length });
    expect(together >= stated).toBe(true);
  });
  it("is below the one order's minimum by the slippage and the steps' smaller amount — what the old Review hid", () => {
    const stated = campaignMinimumOutput({ toAmountMin, quoted, amount, executorTip: tip, steps: pieces.length });
    expect(stated < toAmountMin).toBe(true);
    const shortBps = ((toAmountMin - stated) * 10000n) / toAmountMin;
    expect(shortBps >= 50n, "at least the 50 bps the bounds allow").toBe(true);
    expect(shortBps <= 60n, "and about half a per cent more for the steps' own fee notes and tips").toBe(true);
  });
  it("without a tip named, the bound is per unit of the steps' amount; one step is the campaign's floor less a unit", () => {
    const stated = campaignMinimumOutput({ toAmountMin, quoted, amount, executorTip: null, steps: 1 });
    expect(stated).toBe((amount * slip(rateE18(toAmountMin, quoted))) / 10n ** 18n - 1n);
    expect(campaignMinimumOutput({ toAmountMin, quoted, amount: 0n, executorTip: tip, steps: 3 })).toBe(0n);
  });
});
