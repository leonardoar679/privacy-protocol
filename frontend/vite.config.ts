import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Serves the circuit artifacts the in-browser prover fetches (`/artifacts/*`) straight from
 * ../circuits in dev. For a production build copy them to public/artifacts (or point
 * VITE_ARTIFACT_BASE at a host): the zkey is ~31 MB and the dev setup is insecure by design.
 */
function circuitArtifacts(): Plugin {
  const circuits = fileURLToPath(new URL("../circuits", import.meta.url));
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

export default defineConfig({
  plugins: [react(), circuitArtifacts()],
  resolve: {
    alias: {
      // the normative wallet crypto (Poseidon2, notes, key derivation) — one implementation, used as-is
      "@ref": fileURLToPath(new URL("../reference/typescript/src", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    // the zkAPI SDK expects its deployment manifest behind a same-origin rewrite (sdk/README.md);
    // in dev it is proxied to the pinned protocol server of the network the assets were built for
    proxy: { "/zkapi-deployment": { target: `https://zkapi-${process.env.ZKAPI_NETWORK ?? "sepolia"}.openanonymity.ai`, changeOrigin: true, rewrite: (p) => p.replace(/^\/zkapi-deployment/, "") } },
  },
  worker: { format: "es" },
});
