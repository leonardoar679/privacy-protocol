// The wallet's LIVE suites (verify-all --live): public beacon APIs and RPCs, read-only. Kept out of the
// default run, which stays offline (vitest.config.ts excludes test/live).
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((ctx) =>
  mergeConfig(typeof viteConfig === "function" ? viteConfig(ctx) : viteConfig, { test: { include: ["test/live/**/*.test.ts"], environment: "node", testTimeout: 180_000 } }),
);
