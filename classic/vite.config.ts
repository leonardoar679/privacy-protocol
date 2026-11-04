// The Classic app's build (spec v3.0 §7.8): its own Vite configuration, served under /classic/, its own content security
// policy written into the built index.html (scripts/csp.mjs), the manifest scripts/check-budget.mjs reads, the dev
// server confined to this directory (it never serves the Privacy Wallet's files), the prover worker as an ES module; and
// the screenshot fixtures (fixtures.html, src/fixtures) served by `vite --mode fixtures` only — any other mode answers
// them 404, and no build carries them (scripts/check-dist.mjs proves the sentinel absent).
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { buildCsp, cspPlugin, curatedRelayerOrigins, SECURITY_HEADERS } from "./scripts/csp.mjs";
import { boundaryPlugin } from "./scripts/boundary.mjs";
import { assertLiveCleared } from "./scripts/live-gate.mjs";

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

/**
 * The local stack's browser run (V7 Stage 10) starts this dev server without its websocket (PW_NO_HMR=1, as the wallet's):
 * the Classic app is reached through the wallet's dev server proxy, where an HMR client would have nobody to talk to. The
 * upgrade requests are refused at once (a hung upgrade under a socket reset once crashed the wallet's server).
 */
function refuseUpgrades(): Plugin {
  return {
    name: "classic-refuse-upgrades",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("upgrade", (_req, socket) => {
        socket.on("error", () => {});
        socket.destroy();
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // a production build with NODE_ENV=production (the tenth review round, D-8): the production floors key on import.meta.env.PROD
  if (command === "build" && mode === "production" && process.env.NODE_ENV !== "production")
    throw new Error(`a production build of Classic needs NODE_ENV=production (it is ${process.env.NODE_ENV ?? "unset"})`);
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "VITE_");
  // a production build switches a pool function on only when the legal review's record clears it (the tenth review round, C10-15)
  if (command === "build" && mode === "production") assertLiveCleared(env.VITE_CLASSIC_LIVE ?? process.env.VITE_CLASSIC_LIVE, root);
  // the curated relayers (relayers.json) are allowed by the policy beside the environment's hosts
  const relayers = curatedRelayerOrigins();
  return {
    base: "/classic/",
    plugins: [
      react(),
      boundaryPlugin({ root }),
      fixturesOnly(mode),
      cspPlugin(env, relayers, { production: mode === "production" }),
      ...(process.env.PW_NO_HMR === "1" ? [refuseUpgrades()] : []),
    ],
    build: { manifest: true, sourcemap: false },
    server: { port: 5174, strictPort: true, fs: { allow: [root] }, ...(process.env.PW_NO_HMR === "1" ? { ws: false as const, hmr: false } : {}) },
    // `npm run preview` answers with the headers a host must send (the whole policy as a header too)
    preview: {
      port: 5174,
      headers: { ...SECURITY_HEADERS, "Content-Security-Policy": `${buildCsp(env, relayers, { production: mode === "production" })}; frame-ancestors 'none'` },
    },
    worker: { format: "es" },
  };
});
