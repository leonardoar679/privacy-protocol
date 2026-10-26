// ESLint over the Classic app (spec v3.0 §7.8–§7.9): typescript-eslint, the rules of hooks, jsx-a11y strict, and the
// house rules the Privacy Wallet keeps — only src/config.ts reads the build's environment; no browser storage API
// outside src/storage (nothing secret is ever stored, spec §7.8); no fetch outside the Classic transport (src/net); the
// injected wallet read only by src/wallet/injected.ts; no @privacy-wallet import (the apps share no runtime code); no
// promise word anywhere a user reads (scripts/words.mjs lists them; the original's statistics labels are allowed).
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { house } from "../eslint.house.mjs";

const SRC = ["src/**/*.{ts,tsx}"];
const TESTS = ["test/**/*.{ts,tsx}"];
const FORBIDDEN = "\\b(anonymous|mixers?|untraceable|undetectable|invisible)\\b";
const forbiddenWord = (selector) => ({
  selector,
  message: "Spec v3.0 §7.9: the Classic app never promises; it never says anonymous, mixer, untraceable, undetectable or invisible.",
});
const STORAGE_MEMBER = {
  selector: 'MemberExpression[object.name="window"][property.name=/^(localStorage|sessionStorage)$/]',
  message: "Spec v3.0 §7.8: only src/storage touches the browser's storage, and never a note.",
};
const ETHEREUM = {
  selector: 'MemberExpression[property.name="ethereum"]',
  message: "Spec v3.0 §7.5: the injected wallet is read only by src/wallet/injected.ts.",
};
const FETCH = { selector: 'CallExpression[callee.name="fetch"]', message: "Spec v3.0 §7.5: every request goes through the Classic transport (src/net)." };
const FETCH_VALUE = {
  selector:
    ':matches(AssignmentPattern > Identifier.right, CallExpression > Identifier.arguments, VariableDeclarator > Identifier.init, Property > Identifier.value)[name="fetch"]',
  message: "Spec v3.0 §7.5: fetch is never handed on either — use the Classic transport (src/net).",
};
const FETCH_GLOBAL = {
  selector: 'CallExpression > MemberExpression.callee[property.name="fetch"][object.name=/^(globalThis|window|self)$/]',
  message: "Spec v3.0 §7.5: every request goes through the Classic transport (src/net).",
};
const WORDS = [
  forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
  forbiddenWord(`JSXAttribute[name.name!="className"][name.name!="data-testid"] > Literal[value=/${FORBIDDEN}/i]`),
  forbiddenWord(`JSXExpressionContainer > Literal[value=/${FORBIDDEN}/i]`),
  forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
  forbiddenWord(`Literal[value=/${FORBIDDEN}/i]`),
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", "scripts/**", "*.config.*"] },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: [...SRC, ...TESTS] })),
  {
    files: SRC,
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y, house },
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "house/no-build-env": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Spec v3.0 §7.8: only src/storage touches the browser's storage." },
        { name: "sessionStorage", message: "Spec v3.0 §7.8: only src/storage touches the browser's storage." },
      ],
      "no-restricted-syntax": ["error", ...WORDS, STORAGE_MEMBER, ETHEREUM, FETCH, FETCH_VALUE, FETCH_GLOBAL],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@privacy-wallet/*"], message: "Spec v3.0 §7.8: the Classic app shares no runtime code with the Privacy Wallet." }] },
      ],
    },
  },
  { files: ["src/config.ts"], rules: { "house/no-build-env": "off" } },
  { files: ["src/net/**"], rules: { "no-restricted-syntax": ["error", ...WORDS, STORAGE_MEMBER, ETHEREUM] } },
  { files: ["src/wallet/injected.ts"], rules: { "no-restricted-syntax": ["error", ...WORDS, STORAGE_MEMBER, FETCH, FETCH_VALUE, FETCH_GLOBAL] } },
  {
    files: ["src/storage/**"],
    rules: { "no-restricted-globals": "off", "no-restricted-syntax": ["error", ...WORDS, ETHEREUM, FETCH, FETCH_VALUE, FETCH_GLOBAL] },
  },
  { files: TESTS, rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
