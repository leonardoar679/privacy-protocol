// The house rules ESLint enforces across the workspaces (V6 Stage 3; spec v2.0 §4).
//   no-build-env: only apps/web/src/config.ts reads the build's environment (import.meta.env, through any cast); every
//   other module reads the injected configuration (src/sdk/config.ts config()), so importing it stays inert and a
//   native shell can configure the same engine.

const CASTS = new Set(["TSAsExpression", "TSNonNullExpression", "TSTypeAssertion", "TSSatisfiesExpression"]);

const noBuildEnv = {
  meta: {
    type: "problem",
    messages: { env: "Spec v2.0 §4: only apps/web/src/config.ts reads the build's environment; read the configuration (config() of src/sdk/config.ts)." },
    schema: [],
  },
  create(context) {
    return {
      MetaProperty(node) {
        if (node.meta.name !== "import" || node.property.name !== "meta") return;
        let n = node;
        while (n.parent && CASTS.has(n.parent.type)) n = n.parent;
        const m = n.parent;
        if (m && m.type === "MemberExpression" && m.object === n && !m.computed && m.property.type === "Identifier" && m.property.name === "env") {
          context.report({ node: m, messageId: "env" });
        }
      },
    };
  },
};

export const house = { rules: { "no-build-env": noBuildEnv } };
