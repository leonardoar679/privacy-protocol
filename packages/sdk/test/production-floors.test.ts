// A production build never weakens what protects the user below the defaults (a V6 follow-up of 2026-10-14): the
// keystore's scrypt cost, Hold to Confirm (spec v2.0 §7.6) and the institutional review hold may be raised by the build's
// environment, never lowered. A test or dev build may lower them: the suites and the local stack do.
import { afterEach, describe, expect, it } from "vitest";
import { configure, defaultConfig, DEFAULTS } from "../src/config";
import { holdMs, reviewHoldMinutes } from "../src/tiers";
import { kdfFromConfig } from "../src/wallet/session";
import { KDF_DEFAULT } from "../src/wallet/keystore";

afterEach(() => configure(defaultConfig()));

describe("the production floors", () => {
  it("a test or dev build may lower the hold, the review hold and the scrypt cost", () => {
    configure(defaultConfig({ holdMs: 30, reviewHoldMinutes: 1, kdfLog2N: 12 }));
    expect(holdMs()).toBe(30);
    expect(reviewHoldMinutes()).toBe(1);
    expect(kdfFromConfig().N).toBe(1 << 12);
  });

  it("a production build keeps the defaults as floors, and may go above them", () => {
    configure(defaultConfig({ production: true, holdMs: 30, reviewHoldMinutes: 1, kdfLog2N: 12 }));
    expect(holdMs()).toBe(DEFAULTS.holdMs);
    expect(reviewHoldMinutes()).toBe(DEFAULTS.reviewHoldMinutes);
    expect(kdfFromConfig()).toEqual(KDF_DEFAULT);
    configure(defaultConfig({ production: true, holdMs: 3000, reviewHoldMinutes: 60, kdfLog2N: 18 }));
    expect(holdMs()).toBe(3000);
    expect(reviewHoldMinutes()).toBe(60);
    expect(kdfFromConfig()).toEqual({ ...KDF_DEFAULT, N: 1 << 18 });
  });
});
