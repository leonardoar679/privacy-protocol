// The Classic app's live suites (verify-all --live): the deployment pins against Ethereum mainnet through the public RPC
// endpoints and the Sourcify records; the network, so apart from the default run (vitest.config.ts excludes test/live).
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((ctx) =>
  mergeConfig(typeof viteConfig === "function" ? viteConfig(ctx) : viteConfig, {
    test: {
      include: ["test/live/**/*.test.{ts,tsx}"],
      environment: "node",
      setupFiles: ["test/setup.ts"],
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  }),
);
