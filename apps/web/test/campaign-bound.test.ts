// A protected execution's per-step price bound on its Review (audit round 2, r37): a 1e18 rate of output base units per input
// base unit, said in whole units per whole unit. Formatted as it was (18 decimals), 300 ETH → 10 BTC read "0.000000 BTC per
// ETH" and 500,000 USDC → 5.05 BTC "0.001005 BTC per USDC", a hundred times its value. The bound enforced was right.
import { describe, expect, it } from "vitest";
import { boundPerUnit } from "../src/features/swap/facts";

const rate = (outUnits: bigint, inUnits: bigint) => (outUnits * 10n ** 18n) / inUnits;

describe("the per-step price bound (audit round 2, r37)", () => {
  it("is whole units of the output per whole unit of the input, whatever their decimals", () => {
    expect(boundPerUnit(rate(10n * 10n ** 8n, 300n * 10n ** 18n), 18, 8)).toMatch(/^0\.0333333/); // BTC per ETH
    expect(boundPerUnit(rate(505n * 10n ** 6n, 500_000n * 10n ** 6n), 6, 8)).toMatch(/^0\.0000101/); // BTC per USDC
    expect(boundPerUnit(rate(2_500n * 10n ** 6n, 10n ** 18n), 18, 6)).toBe("2500.000000"); // USDC per ETH
  });
});
