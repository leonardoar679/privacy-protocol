#!/usr/bin/env node
// The performance budget (spec v2.0 §19; doc §89 Step 20; V6 Stage 16), over the production build's Vite manifest
// (apps/web/dist/.vite/manifest.json):
//   - the first route — the entry chunk and every chunk it imports statically — is at most 250 KB of gzipped JS;
//   - Home adds at most 80 KB: the shell's chunk and Home's own, with what they import statically, beyond the first
//     route (the background runners, loaded after the shell renders, do not count);
//   - neither carries snarkjs (it loads with the first proof, in the crypto worker) nor a WASM asset (the core and the
//     witness generator load when first needed).
//   node scripts/check-budget.mjs [dist]
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = process.argv[2] ?? join(root, "apps/web/dist");
const manifestPath = join(dist, ".vite/manifest.json");
export const FIRST_ROUTE_KB = 250;
export const HOME_KB = 80;
/** The chunks that render Home after the unlock: the manifest keys a chunk by its source path, or (a chunk that also
 *  holds shared modules) by `_<name>-<hash>.js`, so a lazy chunk is found by either. */
export const HOME_CHUNKS = [
  { src: "src/app/Shell.tsx", name: "Shell" },
  { src: "src/features/wallet/Home.tsx", name: "Home" },
];

if (!existsSync(manifestPath)) {
  console.error(`FAIL  no manifest at ${relative(root, manifestPath)} (npm run build in apps/web first)`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/** A chunk and everything it imports statically (never its dynamic imports). */
function closure(keys) {
  const seen = new Set();
  const visit = (k) => {
    if (seen.has(k) || !manifest[k]) return;
    seen.add(k);
    for (const i of manifest[k].imports ?? []) visit(i);
  };
  for (const k of keys) visit(k);
  return seen;
}
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1);
const jsOf = (keys) => [...keys].map((k) => manifest[k].file).filter((f) => f.endsWith(".js"));
const sizeOf = (keys) => jsOf(keys).reduce((n, f) => n + gz(f), 0);

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && k.endsWith("index.html"));
if (!entryKey) {
  console.error("FAIL  the manifest has no index.html entry");
  process.exit(1);
}
const first = closure([entryKey]);
const keyOf = (c) => (manifest[c.src] ? c.src : Object.keys(manifest).find((k) => manifest[k].isDynamicEntry && manifest[k].name === c.name));
const missing = HOME_CHUNKS.filter((c) => !keyOf(c)).map((c) => c.src);
const home = closure(HOME_CHUNKS.map(keyOf).filter(Boolean));
for (const k of first) home.delete(k);

const problems = [];
const firstBytes = sizeOf(first);
const homeBytes = sizeOf(home);
if (missing.length) problems.push(`Home's chunks are not separate: ${missing.join(", ")} (each must be its own lazily loaded chunk)`);
if (firstBytes > FIRST_ROUTE_KB * 1024)
  problems.push(`the first route is ${kb(firstBytes)} KB gzipped (budget ${FIRST_ROUTE_KB} KB): ${jsOf(first).join(", ")}`);
if (homeBytes > HOME_KB * 1024) problems.push(`Home adds ${kb(homeBytes)} KB gzipped (budget ${HOME_KB} KB): ${jsOf(home).join(", ")}`);
for (const k of [...first, ...home]) {
  const m = manifest[k];
  if ((m.assets ?? []).some((a) => a.endsWith(".wasm"))) problems.push(`${m.file} carries a WASM asset before it is needed`);
  if (m.file.endsWith(".js") && /\bfullProve\b/.test(readFileSync(join(dist, m.file), "utf8")))
    problems.push(`${m.file} carries snarkjs (it belongs to the crypto worker's first proof)`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(
  `PASS  budget: the first route ${kb(firstBytes)} KB gzipped (≤ ${FIRST_ROUTE_KB}), Home +${kb(homeBytes)} KB (≤ ${HOME_KB}); no snarkjs and no WASM before they are needed (${first.size} + ${home.size} chunks)`,
);
