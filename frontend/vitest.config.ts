// Node-side tests of the wallet's non-UI modules (zkAPI policy, fresh funding provider, tree sync,
// withdrawal planning, keystore / journal, fresh addresses) plus the first-launch DOM test
// (happy-dom, selected per file with a `@vitest-environment` docblock). They reuse vite.config.ts for
// the @ref alias; no browser, no network beyond local mock JSON-RPC servers started by the tests.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["test/**/*.test.{ts,tsx}"],
      exclude: ["test/live/**", "node_modules/**"], // network suites: vitest.live.config.ts (verify-all --live)
      environment: "node",
      testTimeout: 60_000,
      env: { VITE_KDF_LOG2N: "12", VITE_HOLD_MS: "40" }, // fast scrypt and a short hold-to-confirm for the session under test; production ignores both
    },
  }),
);
