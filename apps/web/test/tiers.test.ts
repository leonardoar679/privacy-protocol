// The controls per tier (spec §11): the Review and the lint from $20K, protected execution from $50K, the V2–V4
// controls from $100K up unchanged; the constants of protected execution; the words.
import { describe, expect, it } from "vitest";
import { tierLabel } from "@ref/wallet/valuation";
import { controlsFor, PROTECTED_EXECUTION } from "../src/sdk/tiers";

describe("the controls per tier (spec §11)", () => {
  it("standard: one tap, nothing else", () => {
    const c = controlsFor("standard");
    expect(Object.values(c).every((v) => v === false)).toBe(true);
  });
  it("large ($20K): the Review and the lint only", () => {
    const c = controlsFor("large");
    expect(c).toMatchObject({ review: true, lint: true, hold: false, simulation: false, destinationConfirm: false, protectedExecution: false, campaign: false, secondFactor: false });
  });
  it("large-protected ($50K): the hold, the simulation, the confirmed destination, protected execution, provider health, the strict quote, recovery tracking — not the campaign engine's controls", () => {
    const c = controlsFor("large-protected");
    expect(c).toMatchObject({ review: true, lint: true, hold: true, simulation: true, destinationConfirm: true, protectedExecution: true, providerHealth: true, strictQuote: true, recoveryTracking: true });
    expect(c).toMatchObject({ twoQuotes: false, campaign: false, destinationLock: false, coolingOff: false, secondFactor: false, reviewHold: false, export: false, secondDevice: false });
  });
  it("enhanced and above are what V2–V4 pinned; the V5 controls stay on from the band up", () => {
    expect(controlsFor("enhanced")).toMatchObject({ review: true, lint: true, simulation: true, hold: true, campaign: false, secondFactor: false, protectedExecution: true });
    expect(controlsFor("high-value")).toMatchObject({ simulation: true, hold: true, twoQuotes: true, campaign: true, destinationLock: true, coolingOff: true, secondFactor: false });
    expect(controlsFor("high-value-secondary")).toMatchObject({ secondFactor: true, reviewHold: false });
    expect(controlsFor("institutional")).toMatchObject({ secondFactor: true, reviewHold: true, export: true, secondDevice: true });
  });
  it("the constants of protected execution", () => {
    expect(PROTECTED_EXECUTION).toEqual({ MIN_QUOTE_TTL_S: 60, MAX_SLIPPAGE_BPS: 50, MAX_EXECUTE_WINDOW_S: 1800, MAX_IN_FLIGHT: 1, STEP_BPS: 2500, MAX_STEPS: 4, DELAYED_AT_ETA_MULTIPLE: 3, POLL_MS: 15_000 });
  });
  it("the words of the two bands", () => {
    expect(tierLabel.large).toBe("Large transfer");
    expect(tierLabel["large-protected"]).toBe("Protected transfer");
    expect(tierLabel.enhanced).toBe("Large transfer");
  });
});
