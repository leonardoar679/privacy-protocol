// The design system's suites: the tokens, the components and patterns per state, the sheets, the shell's layout, axe
// over the preview. DOM suites pick happy-dom or jsdom with a `@vitest-environment` docblock.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
  },
});
