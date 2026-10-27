// The Classic app's mainnet-fork suite (V7 Stage 10; spec v3.0 §7.9): the real pools, router and registries on a Hardhat
// fork of Ethereum mainnet — a deposit, the delta synced onto the served snapshot, a proof in Node, the withdrawal through
// the router by a relayer stand-in and by the wallet, the root aging out of the pool's hundred. Opt-in: CLASSIC_FORK_RPC names
// the fork node (scripts/local-stack: `npx hardhat node --port 8547 --fork <mainnet rpc>`); without it every test is skipped.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((ctx) =>
  mergeConfig(typeof viteConfig === "function" ? viteConfig(ctx) : viteConfig, {
    test: {
      include: ["test/fork/**/*.test.{ts,tsx}"],
      environment: "node",
      setupFiles: ["test/setup.ts"],
      testTimeout: 1_800_000,
      hookTimeout: 1_800_000,
    },
  }),
);
