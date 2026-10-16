// Numeric settings read strictly (a V6 follow-up of 2026-10-15): a value that is not a whole number in its range stops the
// service at start, naming the setting; unset or empty, the default. A bare Number() read "1k" as NaN, which polled
// every millisecond or capped nothing.
import { describe, expect, it } from "vitest";
import { addressListSetting, bigintSetting, intSetting } from "../src/env";

describe("numeric settings", () => {
  const range = { min: 500, max: 600_000 };
  it("unset or empty is the default; a whole number in range is itself", () => {
    expect(intSetting({}, "SWAP_POLL_MS", 15_000, range)).toBe(15_000);
    expect(intSetting({ SWAP_POLL_MS: " " }, "SWAP_POLL_MS", 15_000, range)).toBe(15_000);
    expect(intSetting({ SWAP_POLL_MS: "5000" }, "SWAP_POLL_MS", 15_000, range)).toBe(5000);
    expect(bigintSetting({}, "MIN_FEE_WEI", 7n)).toBe(7n);
    expect(bigintSetting({ MIN_FEE_WEI: "1800000000000000000000" }, "MIN_FEE_WEI", 0n)).toBe(1_800_000_000_000_000_000_000n);
  });
  it("anything else stops the start, naming the setting", () => {
    for (const bad of ["1k", "1.5", "5e3", "0x10", "NaN", "Infinity", "499", "600001", "-5000"])
      expect(() => intSetting({ SWAP_POLL_MS: bad }, "SWAP_POLL_MS", 15_000, range), bad).toThrow(/^SWAP_POLL_MS must be a whole number from 500 to 600000/);
    for (const bad of ["-1", "1.0", "1e18", "abc"])
      expect(() => bigintSetting({ MIN_FEE_WEI: bad }, "MIN_FEE_WEI", 0n), bad).toThrow(/^MIN_FEE_WEI must be a whole number/);
  });
  it("a list of addresses: none when unset, each one checked (a key's rotation names two)", () => {
    const a = "0x" + "aa".repeat(20),
      b = "0x" + "bb".repeat(20);
    expect(addressListSetting({}, "API_VOUCHER")).toEqual([]);
    expect(addressListSetting({ API_VOUCHER: ` ${a} , ${b} ` }, "API_VOUCHER")).toEqual([a, b]);
    for (const bad of [`${a},`, `${a};${b}`, "0x1234", `${a},nope`])
      expect(() => addressListSetting({ API_VOUCHER: bad }, "API_VOUCHER"), bad).toThrow(/^API_VOUCHER must list 0x addresses/);
  });
});
