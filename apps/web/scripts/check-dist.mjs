#!/usr/bin/env node
// What a production build must not carry (spec v2.0 §6, §19; V6 Stage 5): the screenshot fixtures (fixtures.html and
// its entry, marked by "pw-fixture-sentinel") and the component preview (/__preview, marked by "pw-preview-sentinel")
// exist in the dev and fixtures builds only. It must carry the self-hosted typeface. Run after `npm run build`.
//   node scripts/check-dist.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const SENTINELS = ["pw-fixture-sentinel", "pw-preview-sentinel"];

if (!existsSync(join(dist, "index.html"))) {
  console.error("FAIL  no dist/ build to inspect (npm run build first)");
  process.exit(1);
}

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
if (existsSync(join(dist, "fixtures.html"))) problems.push("dist/fixtures.html exists: the fixtures entry is in a production build");
const all = files(dist);
for (const f of all.filter((p) => /\.(js|html|css|json|map)$/.test(p))) {
  const text = readFileSync(f, "utf8");
  for (const s of SENTINELS) if (text.includes(s)) problems.push(`${relative(dist, f)} carries ${s}`);
}
if (all.some((p) => p.endsWith(".map"))) problems.push("dist/ ships a source map");
const fonts = all.filter((p) => /inter-latin-wght-normal-[\w-]+\.woff2$/.test(p));
if (fonts.length !== 1) problems.push(`the self-hosted typeface: ${fonts.length} latin Inter files in dist/ (expected exactly one)`);

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`PASS  dist/: no fixtures, no component preview, no source map; the latin Inter served from this origin (${all.length} files)`);
