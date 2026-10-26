// The Classic app's tests: Node for the scripts and the configuration, happy-dom for the screens (a `@vitest-environment`
// docblock per file). No network: the chain and the relayers are scripted in the tests.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((ctx) =>
  mergeConfig(typeof viteConfig === "function" ? viteConfig(ctx) : viteConfig, {
    test: {
      include: ["test/**/*.test.{ts,tsx}"],
      exclude: ["test/live/**", "test/fork/**", "node_modules/**"], // the chain-reading suites run under verify-all --live
      environment: "node",
      setupFiles: ["test/setup.ts"],
      testTimeout: 60_000,
    },
  }),
);
