import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { cspPlugin, SECURITY_HEADERS, zkapiHosts } from "./scripts/csp.mjs";

/**
 * Serves the circuit artifacts the in-browser prover fetches (`/artifacts/*`) straight from
 * ../circuits in dev. For a production build copy them to public/artifacts (or point
 * VITE_ARTIFACT_BASE at a host): the zkey is ~31 MB and the dev setup is insecure by design.
 */
function circuitArtifacts(): Plugin {
  const circuits = fileURLToPath(new URL("../../circuits", import.meta.url));
  const files: Record<string, string> = {
    "/artifacts/transaction.wasm": "build/transaction_js/transaction.wasm",
    "/artifacts/transaction_final.zkey": "build/setup/transaction_final.zkey",
    "/artifacts/verification_key.json": "setup/dev/verification_key.json",
  };
  return {
    name: "circuit-artifacts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rel = files[(req.url ?? "").split("?")[0]];
        if (!rel) return next();
        const p = join(circuits, rel);
        if (!existsSync(p)) { res.statusCode = 404; res.end(`artifact missing: ${rel} (build the circuit and run circuits/scripts/dev-setup.sh)`); return; }
        res.setHeader("content-type", rel.endsWith(".json") ? "application/json" : "application/octet-stream");
        createReadStream(p).pipe(res);
      });
    },
  };
}

/**
 * Serves the Rust core's WASM package (`/core/*`) straight from ../privacy-core/pkg/web in dev (built by
 * privacy-core/scripts/build-wasm.mjs). A production build takes it from public/core (`npm run
 * core:assets`); when neither exists the wallet runs the TypeScript reference instead (packages/sdk/src/core.ts).
 */
function coreWasm(): Plugin {
  const dir = fileURLToPath(new URL("../../privacy-core/pkg/web", import.meta.url));
  const types: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" };
  return {
    name: "core-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/core/")) return next();
        const name = url.slice("/core/".length);
        if (!/^[\w.-]+$/.test(name) || !(extname(name) in types)) return next();
        const p = join(dir, name);
        if (!existsSync(p)) return next(); // then public/core, then 404 → the TypeScript path
        res.setHeader("content-type", types[extname(name)]);
        createReadStream(p).pipe(res);
      });
    },
  };
}

/**
 * The zkAPI browser SDK (Private AI) is a separate clone, not an npm dependency (V6 Stage 2: the lockfile names only
 * registry packages). ZKAPI_SDK_DIR points at it (default: the clone beside this repository, ../zkapi from the repository
 * root); without one the build takes src/zkapi/unavailable.ts — the same exports — and `__ZKAPI__` is false, so the
 * Private AI screen says it is not in this build.
 */
export function zkapiSdk(): { bundled: boolean; alias: { find: RegExp; replacement: string }[] } {
  const dir = process.env.ZKAPI_SDK_DIR ?? fileURLToPath(new URL("../../../zkapi", import.meta.url));
  const bundled = existsSync(join(dir, "package.json")) && existsSync(join(dir, "sdk", "index.js"));
  const stub = fileURLToPath(new URL("./src/zkapi/unavailable.ts", import.meta.url));
  return {
    bundled,
    alias: [
      { find: /^@openanonymity\/zkapi-browser-sdk\/client$/, replacement: bundled ? join(dir, "sdk", "services", "zkapiClient.js") : stub },
      { find: /^@openanonymity\/zkapi-browser-sdk$/, replacement: bundled ? join(dir, "sdk", "index.js") : stub },
    ],
  };
}

/**
 * The screenshot fixtures (spec v2.0 §6, §19; tests/visual): `vite --mode fixtures` serves fixtures.html, a second entry
 * that renders the component preview and the screens' Views from fixtures — never the wallet. In any other mode the dev
 * server answers it 404 and a build leaves it out (apps/web/scripts/check-dist.mjs proves both sentinels absent from dist).
 */
/**
 * V6 Stage 15: the local stack's dev server runs without its websocket (PW_NO_HMR=1, server.ws false). With nobody to
 * answer it, the client's upgrade request hung, and a socket reset under it (a browser closed mid-run) crashed the
 * server on an unhandled ECONNRESET. The upgrade is refused at once instead: the client's two attempts fail
 * immediately, never opened, so it never reloads the page.
 */
function refuseUpgrades(): Plugin {
  return {
    name: "pw-refuse-upgrades",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("upgrade", (_req, socket) => {
        socket.on("error", () => {});
        socket.destroy();
      });
    },
  };
}

function fixturesOnly(mode: string): Plugin {
  return {
    name: "fixtures-only",
    configureServer(server) {
      if (mode === "fixtures") return;
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/fixtures.html") return next();
        res.statusCode = 404;
        res.end("the fixtures are served in fixtures mode only (vite --mode fixtures)");
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  // the build's hosts (VITE_*) name the content security policy's connect-src (spec §20; scripts/csp.mjs)
  const env = loadEnv(mode, root, "VITE_");
  const zkapi = zkapiSdk();
  return {
    plugins: [react(), circuitArtifacts(), coreWasm(), fixturesOnly(mode), cspPlugin(env, zkapiHosts(join(root, "public", "zkapi", "browser-config.json"))), ...(process.env.PW_NO_HMR === "1" ? [refuseUpgrades()] : [])],
    // the prover worker is the first importer of snarkjs; pre-bundling it keeps the dev server from discovering it at the
    // first proof and reloading the page mid-transaction (the wallet would come back locked, the journal intact)
    optimizeDeps: { include: ["snarkjs"] },
    resolve: {
      alias: [
        ...zkapi.alias,
      ],
      // the design system is a package with React as a peer (V6 Stage 4): one React, whatever resolves it
      dedupe: ["react", "react-dom"],
    },
    // __PREVIEW__: the component preview (/__preview) and its chunk exist in every mode but a production build (spec v2.0 §6)
    define: { __ZKAPI__: JSON.stringify(zkapi.bundled), __PREVIEW__: JSON.stringify(mode !== "production") },
    // the fixtures build has a second entry; every other build has the wallet's page only
    ...(mode === "fixtures" ? { build: { outDir: "dist-fixtures", rollupOptions: { input: { main: join(root, "index.html"), fixtures: join(root, "fixtures.html") } } } } : {}),
    server: {
      // V6 Stage 15: the local stack's browser run starts the dev server without its websocket (PW_NO_HMR=1) — going offline
      // would drop it, and Vite reloads the page when it comes back, which ends the session in the middle of a step
      ...(process.env.PW_NO_HMR === "1" ? { ws: false as const, hmr: false } : {}),
      // the repository, and the zkAPI clone beside it when the build carries the SDK
      fs: { allow: [fileURLToPath(new URL("../..", import.meta.url)), ...(zkapi.bundled ? [process.env.ZKAPI_SDK_DIR ?? fileURLToPath(new URL("../../../zkapi", import.meta.url))] : [])] },
      // the zkAPI SDK expects its deployment manifest behind a same-origin rewrite (sdk/README.md);
      // in dev it is proxied to the pinned protocol server of the network the assets were built for
      proxy: { "/zkapi-deployment": { target: `https://zkapi-${process.env.ZKAPI_NETWORK ?? "sepolia"}.openanonymity.ai`, changeOrigin: true, rewrite: (p) => p.replace(/^\/zkapi-deployment/, "") } },
    },
    // `npm run preview` answers with the headers a host must send (docs/deployment.md)
    preview: { headers: { ...SECURITY_HEADERS } },
    worker: { format: "es" },
  };
});
