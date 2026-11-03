// The band's steps Review states what the steps are held to (the third review round, 2026-11-03): the campaign's per-unit price bound
// over the steps' amount, net of the tips — never the one order's minimum, which no step was held to and which the campaign could
// deliver ~0.5 % under without a pause.
import { describe, expect, it } from "vitest";
import { rateE18, trancheMinimum, type ExecutionBounds } from "@privacy-wallet/protocol/wallet/campaign";
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
  it("is at most what the steps guarantee together, and within a unit per step of it", () => {
    expect(pieces.reduce((s, p) => s + p, 0n)).toBe(amount);
    const together = pieces.reduce((s, w) => s + trancheMinimum(bounds, w, tip), 0n);
    const stated = campaignMinimumOutput({ toAmountMin, quoted, amount, executorTip: tip, steps: pieces.length });
    expect(stated <= together, "never above the steps' own floors").toBe(true);
    expect(together - stated <= BigInt(pieces.length) + 1n, "and close to them").toBe(true);
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
