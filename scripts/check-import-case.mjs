#!/usr/bin/env node
// Relative imports resolve with the exact case of the files they name (V6 Stage 2): this machine's file system ignores
// case, the CI runner's does not, so `./Recovery` beside `recovery.ts` builds here and breaks there. Every relative
// specifier (import / export from, import(), require(), new URL(…, import.meta.url)) in the TypeScript and JavaScript
// of apps/, packages/, tests/ and scripts/ is resolved segment by segment against the directory listings.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["apps", "packages", "tests", "scripts"];
const SKIP = new Set(["node_modules", "dist", "run", "results", "target", "pkg", ".vite", "coverage"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs|jsx)$/;
const SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|new URL\s*\(\s*)(["'])(\.\.?\/[^"']*)\1/g;
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

const listing = new Map();
const names = (dir) => {
  if (!listing.has(dir)) {
    try {
      listing.set(dir, new Set(readdirSync(dir)));
    } catch {
      listing.set(dir, null);
    }
  }
  return listing.get(dir);
};

/** true when every segment of `abs` below `root` exists with this exact case */
function exactCase(abs) {
  const parts = relative(root, abs).split(sep);
  let dir = root;
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      dir = dirname(dir);
      continue;
    }
    const n = names(dir);
    if (!n || !n.has(p)) return false;
    dir = join(dir, p);
  }
  return true;
}
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
let checked = 0;
for (const top of ROOTS) {
  let all;
  try {
    all = files(join(root, top));
  } catch {
    continue;
  }
  for (const f of all) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(SPEC)) {
      const spec = m[2].split("?")[0];
      const base = join(dirname(f), spec);
      // every candidate this case-insensitive file system finds; one of them must match exactly (Recovery.tsx may sit
      // beside recovery.ts)
      const hits = EXTS.map((e) => base + e).filter(isFile);
      if (!hits.length) continue; // unresolvable here: the type checker and the tests report it
      checked++;
      if (!hits.some(exactCase)) problems.push(`${relative(root, f)}: "${m[2]}" differs in case from the file on disk`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} import(s) whose case differs from the file (a case-sensitive file system will not find them)`);
  process.exit(1);
}
console.log(`import case: ${checked} relative imports resolve with the exact case of their files`);
