// ESLint over the packages V6 adds (spec v2.0 §4): typescript-eslint and the house rules. apps/web keeps its own config
// (apps/web/eslint.config.js); the code of earlier passes in packages/protocol, packages/swap-engine and apps/relayer is
// not linted yet. Each V6 stage appends its new packages to V6_PACKAGES.
import tseslint from "typescript-eslint";
import { house } from "./eslint.house.mjs";

const V6_PACKAGES = ["packages/protocol-types", "packages/config", "packages/contracts"];
const FILES = V6_PACKAGES.map((p) => `${p}/**/*.ts`);

export default tseslint.config({ ignores: ["**/node_modules/**", "**/dist/**"] }, ...tseslint.configs.recommended.map((c) => ({ ...c, files: FILES })), {
  files: FILES,
  plugins: { house },
  rules: {
    "house/no-build-env": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
    ],
    // an engine package renders nothing: React and the design system belong to apps/web and packages/ui (spec v2.0 §4)
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["react", "react-dom", "react/*", "@privacy-wallet/ui", "@privacy-wallet/ui/*"],
            message: "Spec v2.0 §4: engine packages never import React or the UI.",
          },
        ],
      },
    ],
  },
});
