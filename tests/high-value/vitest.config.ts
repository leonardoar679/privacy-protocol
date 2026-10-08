// The high-value tests tree (High-Value Execution Engine plan §116; contract §5): one directory per area, pure modules
// only (the reference core, the service's engine and risk layer, the labs) — no browser, no network. Run from the
// repository root: node node_modules/vitest/vitest.mjs run --root tests/high-value (scripts/verify-all.mjs does).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
