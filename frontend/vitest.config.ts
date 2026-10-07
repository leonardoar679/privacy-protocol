// Node-side tests of the wallet's non-UI modules (zkAPI policy, fresh funding provider, tree sync,
// withdrawal planning). They reuse vite.config.ts for the @ref alias; no browser, no network beyond
// a local mock JSON-RPC server started by the tests themselves.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
  }),
);
