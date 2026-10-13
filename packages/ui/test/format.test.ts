// The numbers on screen (spec v2.0 §5; doc §92): an amount from base units with the asset's display decimals and
// grouping — never a raw base-unit or 18-decimal string —, the rounding a balance, a fee and a quote each need, dust
// that rounds to zero said as "< 0.0001", USD from integer cents, an address as 0x43…82C1. bigint only.
import { describe, expect, it } from "vitest";
import { formatAmount, formatUsdCents, shortAddress } from "../src/format";

const ETH = { decimals: 18, displayDecimals: 4 };
const USDC = { decimals: 6, displayDecimals: 2, minDecimals: 2 };

describe("formatAmount", () => {
  it("V5's raw 3251.795247999961984 ETH becomes 3,251.7952 (rounded down) or 3,251.7952 (nearest)", () => {
    const v = 3_251_795_247_999_961_984_000n;
    expect(formatAmount(v, { ...ETH, rounding: "down" })).toBe("3,251.7952");
    expect(formatAmount(v, ETH)).toBe("3,251.7952");
    expect(formatAmount(v, { ...ETH, rounding: "up" })).toBe("3,251.7953");
  });

  it("drops trailing zeros beyond minDecimals; a fiat-like amount keeps two", () => {
    expect(formatAmount(231n * 10n ** 16n, ETH)).toBe("2.31");
    expect(formatAmount(2n * 10n ** 18n, ETH)).toBe("2");
    expect(formatAmount(2_470_900_000n, USDC)).toBe("2,470.90");
    expect(formatAmount(2_500_000_000n, USDC)).toBe("2,500.00");
    expect(formatAmount(4_100_000n, USDC)).toBe("4.10");
  });

  it("money-like (pad): a fraction keeps both decimals, a whole amount shows none", () => {
    const money = { decimals: 6, displayDecimals: 2, pad: true };
    expect(formatAmount(2_470_900_000n, money)).toBe("2,470.90");
    expect(formatAmount(4_100_000n, money)).toBe("4.10");
    expect(formatAmount(4_950_000_000n, money)).toBe("4,950");
    expect(formatAmount(25_000_000n, money)).toBe("25");
    expect(formatAmount(2_470_900_000n, { decimals: 6, displayDecimals: 2 })).toBe("2,470.9");
  });

  it("rounding: half up for nearest, a carry into the whole part, up for a fee, down for a balance", () => {
    expect(formatAmount(1_005n, { decimals: 3, displayDecimals: 2 })).toBe("1.01");
    expect(formatAmount(1_004n, { decimals: 3, displayDecimals: 2 })).toBe("1");
    expect(formatAmount(1_999_999n, { decimals: 6, displayDecimals: 2 })).toBe("2");
    expect(formatAmount(1_000_001n, { decimals: 6, displayDecimals: 2, rounding: "up" })).toBe("1.01");
    expect(formatAmount(1_009_999n, { decimals: 6, displayDecimals: 2, rounding: "down" })).toBe("1");
  });

  it("dust that would read as zero says it is there; zero is 0; negatives use the minus sign", () => {
    expect(formatAmount(1n, { decimals: 18, displayDecimals: 6 })).toBe("< 0.000001");
    expect(formatAmount(1n, { decimals: 8, displayDecimals: 0 })).toBe("< 1");
    expect(formatAmount(0n, ETH)).toBe("0");
    expect(formatAmount(-1_500_000n, USDC)).toBe("−1.50");
    expect(formatAmount(-1n, { decimals: 18, displayDecimals: 4 })).toBe("−< 0.0001");
  });

  it("display decimals never exceed the asset's; grouping follows the locale; 2^255 stays exact", () => {
    expect(formatAmount(12_345_678n, { decimals: 2, displayDecimals: 6 })).toBe("123,456.78");
    expect(formatAmount(1_234_567_890n, { decimals: 2, displayDecimals: 2, locale: "de-DE" })).toBe("12.345.678,9");
    const huge = 2n ** 255n;
    expect(formatAmount(huge, { decimals: 0, displayDecimals: 0 }).replace(/,/g, "")).toBe(huge.toString());
  });
});

describe("formatUsdCents and shortAddress", () => {
  it("USD from integer cents, signed on request", () => {
    expect(formatUsdCents(1_000_000n)).toBe("$10,000.00");
    expect(formatUsdCents(410n)).toBe("$4.10");
    expect(formatUsdCents(5n)).toBe("$0.05");
    expect(formatUsdCents(-1_234n)).toBe("−$12.34");
    expect(formatUsdCents(250n, { signed: true })).toBe("+$2.50");
    expect(formatUsdCents(0n, { signed: true })).toBe("$0.00");
  });

  it("an address as a chip shows it: four characters, an ellipsis, four characters", () => {
    expect(shortAddress("0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1")).toBe("0x43…82C1");
    expect(shortAddress("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx82c1")).toBe("bc1q…82c1");
    expect(shortAddress("pp1short")).toBe("pp1short");
  });
});
