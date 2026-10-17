// Every number a service reads from its environment goes through the server kit's strict reader (a V6 follow-up of
// 2026-10-15): a bare Number() read "1k" as NaN, which polled every millisecond, capped nothing or allowed nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bpsOf } from "@privacy-wallet/protocol/wallet/fees";

describe("the settings", () => {
  it("server.ts reads no number with a bare Number() or BigInt()", () => {
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
    expect(server).not.toMatch(/(Number|BigInt|parseInt|parseFloat)\((env\(|env\.|process\.env)/);
    expect(server).toMatch(/intSetting/);
  });
  it("the fee percentage it accepts is one the fee rule computes (the audit's unverified m03): 10000 had started and answered every withdrawal 500", () => {
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
    const m = server.match(/int\("FEE_PERCENT_BPS", \d+, (\d+), ([\d_]+)\)/);
    expect(m, "FEE_PERCENT_BPS is read with its range").not.toBeNull();
    const max = Number(m![2].replace(/_/g, ""));
    expect(() => bpsOf(max)).not.toThrow();
    expect(() => bpsOf(10_000)).toThrow(RangeError);
  });
});
