#!/usr/bin/env node
// Copies the Rust core's WASM package (privacy-core/pkg/web, built by privacy-core/scripts/build-wasm.mjs)
// into public/core so a production build serves it same-origin at /core/* (packages/sdk/src/core.ts loads it
// lazily on the first sync; without it the wallet runs the TypeScript reference). No network, no Rust.
//   npm run core:assets
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "privacy-core", "pkg", "web");
const out = join(here, "..", "public", "core");
const files = ["privacy_core_wasm.js", "privacy_core_wasm_bg.wasm"];
for (const f of files) {
  if (!existsSync(join(src, f))) {
    console.error(`missing ${join(src, f)} — build the package first: node privacy-core/scripts/build-wasm.mjs`);
    process.exit(1);
  }
}
mkdirSync(out, { recursive: true });
for (const f of files) copyFileSync(join(src, f), join(out, f));
const build = existsSync(join(src, "..", "BUILD.json")) ? JSON.parse(readFileSync(join(src, "..", "BUILD.json"), "utf8")) : null;
console.log(`public/core ← ${files.join(", ")}${build ? ` (built ${build.builtAt}, ${(build.wasmBytes / 1024).toFixed(0)} kB)` : ""}`);
