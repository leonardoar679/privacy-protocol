// ESLint over the packages V6 adds (spec v2.0 §4): typescript-eslint and the house rules, and for the UI package the rules
// of hooks and jsx-a11y strict. apps/web keeps its own config (apps/web/eslint.config.js); the code of earlier passes in
// packages/protocol, packages/swap-engine and apps/relayer is not linted yet. The engine and the design system moved out
// of apps/web in V6 Stage 4 under the rules they had there: the V1.1–V4 engine (LEGACY) without `no-explicit-any`, its
// one fetch wrapper (the transport) free to call fetch. Each V6 stage appends its new packages.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { house } from "./eslint.house.mjs";

const ENGINE_PACKAGES = [
  "packages/protocol-types",
  "packages/config",
  "packages/contracts",
  "packages/sdk",
  "packages/wallet-engine",
  "packages/privacy-engine",
  "packages/risk-engine",
];
const UI_PACKAGES = ["packages/ui"];
// V6 Stage 9: the API and what it shares with the relayer — services, so no browser transport rule, and no console
const SERVER_PACKAGES = ["packages/server-kit", "apps/api"];
const ENGINE = ENGINE_PACKAGES.map((p) => `${p}/**/*.ts`);
const UI = UI_PACKAGES.map((p) => `${p}/**/*.{ts,tsx}`);
const SERVER = SERVER_PACKAGES.map((p) => `${p}/**/*.ts`);
const ALL = [...ENGINE, ...UI, ...SERVER];
// the V1.1–V4 engine as it came from apps/web (src/sdk, src/wallet, src/keys): its RPC and provider edges are typed loosely
const LEGACY = ["packages/sdk/src/**", "packages/wallet-engine/src/injected.ts"];
const LEGACY_EXCEPT = ["packages/sdk/src/index.ts", "packages/sdk/src/operations/**"];
// the one module that wraps fetch, and the modules that were apps/web's src/sdk (no-restricted-syntax was off there; the
// wallet, the keys and the operation logic keep it on, as they had it)
const TRANSPORT = [
  "packages/privacy-engine/src/transport/http.ts",
  "packages/sdk/src/*.ts",
  "packages/sdk/src/lightclient/**",
  "packages/wallet-engine/src/injected.ts",
];
const TRANSPORT_EXCEPT = ["packages/sdk/src/index.ts"];
const PRIMITIVES = ["packages/ui/src/primitives/**"];

const FORBIDDEN = "\\b(anonymous|anonymity|mixer|untraceable|undetectable)\\b";
const forbiddenWord = (selector) => ({
  selector,
  message: "Spec §18: the wallet never says anonymous, mixer, untraceable or undetectable; say private, protected, shielded, reduced public linkage.",
});
const STORAGE_MEMBER = {
  selector: 'MemberExpression[object.name="window"][property.name=/^(localStorage|sessionStorage)$/]',
  message: "Spec §8: the engine never touches the browser's storage; the platform passes its store to configure().",
};
const FETCH = {
  selector: 'CallExpression[callee.name="fetch"]',
  message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts).",
};
// fetch handed on as a value or called on a global (audit round 2, n73): the call rule alone had let a default parameter past
const FETCH_VALUE = {
  selector:
    ':matches(AssignmentPattern > Identifier.right, CallExpression > Identifier.arguments, VariableDeclarator > Identifier.init, Property > Identifier.value)[name="fetch"]',
  message: "Spec §7: fetch is never handed on either — pass fetchFor(purpose) from the privacy engine's transport.",
};
const FETCH_GLOBAL = {
  selector: 'CallExpression > MemberExpression.callee[property.name="fetch"][object.name=/^(globalThis|window|self)$/]',
  message: "Spec §7: every request goes through the privacy engine's transport (packages/privacy-engine/src/transport/http.ts).",
};
const ETHEREUM = {
  selector: 'MemberExpression[property.name="ethereum"]',
  message: "Spec §7: the injected wallet is read only by the wallet engine (packages/wallet-engine/src/injected.ts).",
};
const STORAGE_GLOBALS = [
  "error",
  { name: "localStorage", message: "Spec §8: the platform's store only (configure())." },
  { name: "sessionStorage", message: "Spec §8: the platform's store only (configure())." },
];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ALL })),
  {
    files: ALL,
    plugins: { house },
    rules: {
      "house/no-build-env": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-restricted-globals": STORAGE_GLOBALS,
    },
  },
  {
    files: ENGINE,
    rules: {
      // an engine package renders nothing: React and the design system belong to apps/web and packages/ui (spec v2.0 §4)
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react/*", "@radix-ui/*", "@privacy-wallet/ui", "@privacy-wallet/ui/*"],
              message: "Spec v2.0 §4: engine packages never import React or the UI.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`), STORAGE_MEMBER, FETCH, FETCH_VALUE, FETCH_GLOBAL],
    },
  },
  {
    files: SERVER,
    rules: {
      // doc §67: a service writes through the typed logger (packages/server-kit/src/logger.ts) and nothing else
      "no-console": "error",
      "no-restricted-syntax": ["error", forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`), forbiddenWord(`Literal[value=/${FORBIDDEN}/i]`)],
    },
  },
  // the tests' harness reads answers loosely typed
  { files: ["apps/api/test/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: LEGACY, ignores: LEGACY_EXCEPT, rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: TRANSPORT, ignores: TRANSPORT_EXCEPT, rules: { "no-restricted-syntax": "off" } },
  {
    files: UI,
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // a rich label (a title, a note, a description around a native radio or checkbox) nests its text three deep
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-syntax": [
        "error",
        forbiddenWord(`JSXText[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXAttribute[name.name!="className"][name.name!="data-testid"] > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`JSXExpressionContainer > Literal[value=/${FORBIDDEN}/i]`),
        forbiddenWord(`TemplateElement[value.cooked=/${FORBIDDEN}/i]`),
        STORAGE_MEMBER,
        ETHEREUM,
        FETCH,
        FETCH_VALUE,
        FETCH_GLOBAL,
      ],
    },
  },
  {
    files: UI,
    ignores: PRIMITIVES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@radix-ui/*"], message: "Spec §5: Radix is wrapped once, in packages/ui/src/primitives." },
            {
              group: ["@privacy-wallet/sdk", "@privacy-wallet/sdk/*", "@privacy-wallet/*-engine", "@privacy-wallet/*-engine/*"],
              message: "Spec v2.0 §4: the UI is presentation only; the app connects it to the SDK.",
            },
          ],
        },
      ],
    },
  },
);
