// The gas pins (spec v2.0 §3) against forge's measurement: never below it (a cost would be under-priced), never more
// than 10 % above it (a cost would be over-charged). contracts/test/gas/PeripheryGasBench.t.sol keeps the vector current.
import { describe, expect, it } from "vitest";
import { GAS_UNITS } from "../src/gas";
import measured from "../../../contracts/test/periphery/vectors/gas.json";

describe("the gas pins (spec v2.0 §3)", () => {
  const m = measured as Record<string, number>;
  it("every measured path has a pin, and every pin a measurement", () => {
    expect(Object.keys(GAS_UNITS).sort()).toEqual(Object.keys(m).sort());
  });
  for (const [path, pin] of Object.entries(GAS_UNITS)) {
    it(`${path}: ${pin} units against forge's ${m[path]}`, () => {
      const measuredUnits = BigInt(m[path]);
      expect(pin >= measuredUnits, "a pin below the measurement under-prices the path").toBe(true);
      expect(pin * 100n <= measuredUnits * 110n, "a pin more than 10 % above the measurement over-charges it").toBe(true);
    });
  }
});
