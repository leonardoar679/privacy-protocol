// @vitest-environment happy-dom
// Import purity (V6 Stage 3; spec v2.0 §4): every engine module can be imported before the platform configures the engine
// — nothing reads a setting at import time, so no module can freeze a stale value — and the first read before
// configure() says so instead of using defaults. A native shell will import the same modules and configure them itself.
import { describe, expect, it, vi } from "vitest";

// V6 Stage 4: the engine packages whole, and the web platform's own modules (its store, its prover, the words of the
// operations, the fee engine)
const ENGINE = import.meta.glob([
  "../../../packages/sdk/src/**/*.ts",
  "../../../packages/wallet-engine/src/**/*.ts",
  "../../../packages/privacy-engine/src/**/*.ts",
  "../../../packages/risk-engine/src/**/*.ts",
  "../src/storage/**/*.ts",
  "../src/prover/client.ts",
  "../src/prover/pins.ts",
  "../src/features/operations/*.ts",
  "../src/features/fees/feeEngine.ts",
]);

describe("the engine before configure()", () => {
  it("imports every module without reading a setting", async () => {
    vi.resetModules();
    const names = Object.keys(ENGINE);
    expect(names.length).toBeGreaterThan(60);
    for (const name of names) await expect(ENGINE[name](), name).resolves.toBeDefined();
  });

  it("refuses to be read before it is configured", async () => {
    vi.resetModules();
    const { config, isConfigured } = await import("@privacy-wallet/sdk/config");
    const { holdMs } = await import("@privacy-wallet/sdk/tiers");
    const { defaultRelayerUrl } = await import("@privacy-wallet/sdk/relayer");
    expect(isConfigured()).toBe(false);
    expect(() => config()).toThrow(/not configured/);
    expect(() => holdMs()).toThrow(/not configured/);
    expect(() => defaultRelayerUrl()).toThrow(/not configured/);
  });
});
