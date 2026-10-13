// Node-side tests of the wallet's non-UI modules (zkAPI policy, fresh funding provider, tree sync,
// withdrawal planning, keystore / journal, fresh addresses) plus the DOM tests (happy-dom or jsdom,
// selected per file with a `@vitest-environment` docblock). They reuse vite.config.ts for the @ref alias;
// no browser, no network beyond local mock JSON-RPC servers started by the tests.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((ctx) =>
  mergeConfig(
    typeof viteConfig === "function" ? viteConfig(ctx) : viteConfig,
    {
      test: {
        include: ["test/**/*.test.{ts,tsx}"],
        exclude: ["test/live/**", "node_modules/**"], // network suites: vitest.live.config.ts (verify-all --live)
        environment: "node",
        setupFiles: ["test/setup.ts"], // jest-dom matchers, Testing Library cleanup, the platform pieces Radix expects (V5)
        testTimeout: 60_000, // the configuration of the suites (a cheap scrypt, a short hold) is test/setup.ts's applyConfig(testConfig())
      },
    },
  ),
);
