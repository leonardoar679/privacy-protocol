// ESLint over all of src (spec §18, §21; Stage 11): typescript-eslint, the rules of hooks, jsx-a11y strict, and the house
// rules — no storage API outside src/storage, no fetch (every request goes through the privacy engine's transport), no
// window.ethereum (the wallet engine reads it), no Radix (the UI package wraps it), no inline style and no literal text
// on a screen, no forbidden word anywhere a user reads. The engine and the design system are packages since V6 Stage 4,
// linted by the root eslint.config.mjs under the rules they had here. The components still mounted (LEGACY) type their
// RPC and provider edges loosely and keep bare inputs: `no-explicit-any` and the label rule are off there until rebuilt.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { house } from "../../eslint.house.mjs";

const SCREENS = ["src/features/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"];
const CONFORMED = ["src/**/*.{ts,tsx}"]; // Stage 11: everywhere (STORAGE, WALLET and SCREENS keep their own blocks)
const LEGACY = ["src/components/**", "src/prover/**", "src/zkapi/**", "src/*.ts", "src/*.tsx"];
const STORAGE = ["src/storage/**"];
const WALLET = ["src/features/wallet/**"];
// V6 Stage 6 (spec v2.0 §7): a screen's View is pure — a view-model in, callbacks out; its model.ts reads the engine
const VIEWS = ["src/features/**/View.tsx", "src/features/viewKit.tsx", "src/features/**/fixtures.ts", "src/features/fixtureAmounts.ts", "src/features/flowFixtures.ts"];

const FORBIDDEN = "\\b(anonymous|anonymity|mixer|untraceable|undetectable)\\b";
const forbiddenWord = (selector) => ({ selector, message: "Spec §18: the wallet never says anonymous, mixer, untraceable or undetectable; say private, protected, shielded, reduced public linkage." });
const RADIX = { group: ["@radix-ui/*"], message: "Spec §5: Radix is wrapped once, in the UI package's primitives (packages/ui/src/primitives)." };
const PURE = "Spec v2.0 §7: a View is pure — a view-model in, callbacks out; the screen's model.ts reads the engine and the stores.";
// fetch handed on as a value (a default parameter, an argument, a variable, a property) or called on a global — the call rule
// alone had let `fetchImpl: typeof fetch = fetch` past it (audit round 2, n73)
const FETCH_VALUE = {
  selector: ':matches(AssignmentPattern > Identifier.right, CallExpression > Identifier.arguments, VariableDeclarator > Identifier.init, Property > Identifier.value)[name="fetch"]',
  message: "Spec §7: fetch is never handed on either — pass fetchFor(purpose) from the privacy engine's transport.",
};
const FETCH_GLOBAL = {
  selector: 'CallExpression > MemberExpression.callee[property.name="fetch"][object.name=/^(globalThis|window|self)$/]',
  message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts).",
};
const ETHEREUM_RULE = { selector: 'MemberExpression[property.name="ethereum"]', message: "Spec §7: the injected wallet is read only by the wallet engine (packages/wallet-engine/src/injected.ts)." };

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", "scripts/**", "test/**", "*.config.*"] },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: CONFORMED })),
  {
    files: CONFORMED,
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: { globals: { window: "readonly", document: "readonly", navigator: "readonly", history: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly" } },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // a rich label (a title, a note, a description around a native radio or checkbox) nests its text three deep
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-restricted-globals": ["error", { name: "localStorage", message: "Spec §8: only src/storage touches the browser's storage." }, { name: "sessionStorage", message: "Spec §8: only src/storage touches the browser's storage." }],
      "no-restricted-syntax": [
        "error",
        forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXAttribute[name.name!="className"][name.name!="data-testid"] > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXExpressionContainer > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
        { selector: 'MemberExpression[object.name="window"][property.name=/^(localStorage|sessionStorage)$/]', message: "Spec §8: only src/storage touches the browser's storage." },
        ETHEREUM_RULE,
        { selector: 'CallExpression[callee.name="fetch"]', message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts)." },
        FETCH_VALUE,
        FETCH_GLOBAL,
      ],
    },
  },
  { files: CONFORMED, rules: { "no-restricted-imports": ["error", { patterns: [RADIX] }] } },
  {
    files: VIEWS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            RADIX,
            { group: ["@privacy-wallet/*", "!@privacy-wallet/ui", "!@privacy-wallet/protocol-types"], message: PURE },
            { group: ["@privacy-wallet/ui/*", "@privacy-wallet/protocol-types/*", "viem", "viem/*"], message: PURE },
            { regex: "(^|/)(hooks|storage|platform|model)(/|$)", message: PURE },
          ],
        },
      ],
    },
  },
  // V6 Stage 3 (spec v2.0 §4): the build's environment is read by src/config.ts alone
  { files: CONFORMED, ignores: ["src/config.ts"], plugins: { house }, rules: { "house/no-build-env": "error" } },
  { files: STORAGE, rules: { "no-restricted-globals": "off" } },
  { files: LEGACY, rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["src/components/**"], rules: { "jsx-a11y/label-has-associated-control": "off" } },
  {
    files: WALLET,
    rules: {
      "no-restricted-syntax": [
        "error",
        forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
        { selector: 'JSXAttribute[name.name="style"]', message: "Spec §5: a screen composes the design system and carries no inline style." },
        { selector: "JSXText[value=/[A-Za-z]{3,}/]", message: "Spec §19: user-facing text comes from the message catalog (useT)." },
        { selector: 'CallExpression[callee.name="fetch"]', message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts)." },
        FETCH_VALUE,
        FETCH_GLOBAL,
      ],
    },
  },
  {
    files: SCREENS,
    rules: {
      "no-restricted-syntax": [
        "error",
        forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXAttribute[name.name!="className"][name.name!="data-testid"] > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
        { selector: 'JSXAttribute[name.name="style"]', message: "Spec §5: a screen composes the design system and carries no inline style." },
        { selector: "JSXText[value=/[A-Za-z]{3,}/]", message: "Spec §19: user-facing text comes from the message catalog (useT)." },
        { selector: 'MemberExpression[object.name="window"][property.name=/^(localStorage|sessionStorage)$/]', message: "Spec §8: only src/storage touches the browser's storage." },
        { selector: 'CallExpression[callee.name="fetch"]', message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts)." },
        FETCH_VALUE,
        FETCH_GLOBAL,
      ],
    },
  },
);
