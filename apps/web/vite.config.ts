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
 * core:assets`); when neither exists the wallet runs the TypeScript reference instead (src/sdk/core.ts).
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

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  // the build's hosts (VITE_*) name the content security policy's connect-src (spec §20; scripts/csp.mjs)
  const env = loadEnv(mode, root, "VITE_");
  const zkapi = zkapiSdk();
  return {
    plugins: [react(), circuitArtifacts(), coreWasm(), cspPlugin(env, zkapiHosts(join(root, "public", "zkapi", "browser-config.json")))],
    // the prover worker is the first importer of snarkjs; pre-bundling it keeps the dev server from discovering it at the
    // first proof and reloading the page mid-transaction (the wallet would come back locked, the journal intact)
    optimizeDeps: { include: ["snarkjs"] },
    resolve: {
      alias: [
        ...zkapi.alias,
      ],
    },
    define: { __ZKAPI__: JSON.stringify(zkapi.bundled) },
    server: {
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
