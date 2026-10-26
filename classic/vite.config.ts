// The Classic app's build (spec v3.0 §7.8): its own Vite configuration, served under /classic/, its own content security
// policy written into the built index.html (scripts/csp.mjs), the manifest scripts/check-budget.mjs reads, the dev
// server confined to this directory (it never serves the Privacy Wallet's files), the prover worker as an ES module.
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { buildCsp, cspPlugin, SECURITY_HEADERS } from "./scripts/csp.mjs";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "VITE_");
  return {
    base: "/classic/",
    plugins: [react(), cspPlugin(env)],
    build: { manifest: true, sourcemap: false },
    server: { port: 5174, strictPort: true, fs: { allow: [root] } },
    // `npm run preview` answers with the headers a host must send (the whole policy as a header too)
    preview: { port: 5174, headers: { ...SECURITY_HEADERS, "Content-Security-Policy": `${buildCsp(env)}; frame-ancestors 'none'` } },
    worker: { format: "es" },
  };
});
