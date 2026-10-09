// ESLint over the new directories (spec §18, §21): typescript-eslint, the rules of hooks, jsx-a11y strict, and the house
// rules — no storage API outside src/storage, no fetch outside src/api and src/sdk, no window.ethereum outside
// src/features/wallet, no Radix outside the primitives, no inline style and no literal text on a screen, no forbidden
// word anywhere a user reads. The `files` globs list only the conformed directories; each stage appends its own.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

const DESIGN_SYSTEM = ["src/design-system/**/*.{ts,tsx}"];
const APP = ["src/app/**/*.{ts,tsx}"];
const SCREENS = ["src/features/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"];
const CONFORMED = [...DESIGN_SYSTEM, ...SCREENS];
const STORAGE = ["src/storage/**"];
const TRANSPORT = ["src/api/**", "src/sdk/**"];
const WALLET = ["src/features/wallet/**"];
const PRIMITIVES = ["src/design-system/primitives/**"];

const FORBIDDEN = "\\b(anonymous|anonymity|mixer|untraceable|undetectable)\\b";
const forbiddenWord = (selector) => ({ selector, message: "Spec §18: the wallet never says anonymous, mixer, untraceable or undetectable; say private, protected, shielded, reduced public linkage." });

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", "scripts/**", "test/**", "*.config.*"] },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: CONFORMED })),
  {
    files: CONFORMED,
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: { globals: { window: "readonly", document: "readonly", navigator: "readonly", history: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly" } },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-globals": ["error", { name: "localStorage", message: "Spec §8: only src/storage touches the browser's storage." }, { name: "sessionStorage", message: "Spec §8: only src/storage touches the browser's storage." }],
      "no-restricted-syntax": [
        "error",
        forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXAttribute[name.name!="className"][name.name!="data-testid"] > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXExpressionContainer > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
        { selector: 'MemberExpression[object.name="window"][property.name=/^(localStorage|sessionStorage)$/]', message: "Spec §8: only src/storage touches the browser's storage." },
        { selector: 'MemberExpression[property.name="ethereum"]', message: "Spec §7: the injected wallet is read only by src/features/wallet." },
        { selector: 'CallExpression[callee.name="fetch"]', message: "Spec §7: every request goes through src/api/transport.ts." },
      ],
    },
  },
  { files: CONFORMED, ignores: [...PRIMITIVES], rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["@radix-ui/*"], message: "Spec §5: Radix is wrapped once, in src/design-system/primitives." }] }] } },
  { files: STORAGE, rules: { "no-restricted-globals": "off" } },
  { files: TRANSPORT, rules: { "no-restricted-syntax": "off" } },
  { files: WALLET, rules: {} },
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
        { selector: 'CallExpression[callee.name="fetch"]', message: "Spec §7: every request goes through src/api/transport.ts." },
      ],
    },
  },
);
