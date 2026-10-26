// The donation address (the withdraw tab's "Donate"): a build names its own or none; a malformed value is refused.
import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config";

describe("VITE_CLASSIC_DONATION_ADDRESS", () => {
  it("is null when absent or empty, kept when a 0x address, refused otherwise", () => {
    expect(configFromEnv({}).donationAddress).toBeNull();
    expect(configFromEnv({ VITE_CLASSIC_DONATION_ADDRESS: "" }).donationAddress).toBeNull();
    expect(configFromEnv({ VITE_CLASSIC_DONATION_ADDRESS: "0x2222222222222222222222222222222222222222" }).donationAddress).toBe(
      "0x2222222222222222222222222222222222222222",
    );
    expect(() => configFromEnv({ VITE_CLASSIC_DONATION_ADDRESS: "0x1234" })).toThrow(/DONATION_ADDRESS/);
    expect(() => configFromEnv({ VITE_CLASSIC_DONATION_ADDRESS: "2222222222222222222222222222222222222222" })).toThrow(/DONATION_ADDRESS/);
  });
});
