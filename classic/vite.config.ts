// The Classic app's build (spec v3.0 §7.8): its own Vite configuration, served under /classic/, its own content security
// policy written into the built index.html (scripts/csp.mjs), the manifest scripts/check-budget.mjs reads, the dev
// server confined to this directory (it never serves the Privacy Wallet's files), the prover worker as an ES module; and
// the screenshot fixtures (fixtures.html, src/fixtures) served by `vite --mode fixtures` only — any other mode answers
// them 404, and no build carries them (scripts/check-dist.mjs proves the sentinel absent).
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { buildCsp, cspPlugin, curatedRelayerOrigins, SECURITY_HEADERS } from "./scripts/csp.mjs";

function fixturesOnly(mode: string): Plugin {
  return {
    name: "classic-fixtures-only",
    configureServer(server) {
      if (mode === "fixtures") return;
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== "/classic/fixtures.html" && path !== "/fixtures.html") return next();
        res.statusCode = 404;
        res.end("the fixtures are served in fixtures mode only (vite --mode fixtures)");
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "VITE_");
  // the curated relayers (relayers.json) are allowed by the policy beside the environment's hosts
  const relayers = curatedRelayerOrigins();
  return {
    base: "/classic/",
    plugins: [react(), fixturesOnly(mode), cspPlugin(env, relayers)],
    build: { manifest: true, sourcemap: false },
    server: { port: 5174, strictPort: true, fs: { allow: [root] } },
    // `npm run preview` answers with the headers a host must send (the whole policy as a header too)
    preview: { port: 5174, headers: { ...SECURITY_HEADERS, "Content-Security-Policy": `${buildCsp(env, relayers)}; frame-ancestors 'none'` } },
    worker: { format: "es" },
  };
});
