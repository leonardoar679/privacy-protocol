#!/usr/bin/env node
// The documentation's paths (V6 Stage 1, the monorepo move): every repository path a document writes in backticks
// must exist, and no path of the old layout may remain. Run by verify-all.
//   1. a backticked token that starts with a top-level directory of this repository (apps/, packages/, privacy-core/,
//      contracts/, circuits/, tests/, scripts/, docs/, benchmarks/, tools/, reference/) names a file or directory that
//      exists — after dropping a `:line` / `#anchor` suffix and expanding `{a,b}` braces; generated outputs (build
//      directories, packages, run logs) and globs are not checked; a historical file a document names on purpose is
//      listed in scripts/doc-paths-allowlist.txt with its reason;
//   2. no document names the old roots (frontend/, services/, core/rust, reference/typescript) except to say what a
//      path "was".
// Scanned: README.md, docs/**/*.md, and the README.md of every directory; not scripts/local-stack/results (reports).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOP = ["apps", "packages", "privacy-core", "contracts", "circuits", "tests", "scripts", "docs", "benchmarks", "tools", "reference"];
const GENERATED = [/^circuits\/build\//, /^privacy-core\/(target|pkg)\//, /^apps\/web\/(dist|public\/(core|zkapi))\//, /^scripts\/local-stack\/(run|results)\//, /\/node_modules\//, /^contracts\/(out|cache|broadcast)\//, /^tests\/visual\/run\//];
const OLD = /(?<![\w.-])(frontend\/|services\/(private-swap|relayer|zkapi-lab)|core\/rust|reference\/typescript)/;

const allow = new Map();
const allowFile = join(root, "scripts/doc-paths-allowlist.txt");
if (existsSync(allowFile)) for (const line of readFileSync(allowFile, "utf8").split("\n")) {
  const m = line.match(/^(\S+)\s+#\s*(.+)$/);
  if (m) allow.set(m[1], m[2]);
}

function docs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "target" || e.name === "results" || e.name === "run" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) docs(p, out);
    else if (e.name.endsWith(".md") && (e.name === "README.md" || relative(root, p).startsWith("docs"))) out.push(p);
  }
  return out;
}

const expand = (s) => {
  const m = s.match(/\{([^{}]*)\}/);
  if (!m) return [s];
  return m[1].split(",").flatMap((alt) => expand(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
};

const problems = [];
let checked = 0;
for (const file of docs(root)) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, k) => {
    // every old-layout path on the line, each allowed only right after "was" ("apps/web (was `frontend`)")
    const wasBefore = (i) => /\bwas\s*`?$/.test(line.slice(0, i));
    for (const old of line.matchAll(new RegExp(OLD.source, "g"))) {
      if (!wasBefore(old.index)) problems.push(`${rel}:${k + 1}: an old-layout path: ${old[0]}`);
    }
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      if (wasBefore(m.index + 1)) continue; // a historical name, said to be one
      let token = m[1].replace(/[),.;]+$/, "").replace(/::.*$/, "").replace(/:\d+(-\d+)?(:\d+)?$/, "").replace(/#.*$/, "");
      if (!TOP.some((t) => token === t || token.startsWith(t + "/"))) continue;
      if (/[*?<>]|\.\.\.|…/.test(token)) continue; // globs and placeholders
      for (const p of expand(token)) {
        if (GENERATED.some((g) => g.test(p))) continue;
        checked++;
        // a README may name paths relative to its own directory
        const here = rel.endsWith("README.md") ? existsSync(join(dirname(file), p)) : false;
        if (!here && !existsSync(join(root, p)) && !allow.has(p)) problems.push(`${rel}:${k + 1}: no such path: ${p}`);
      }
    }
  });
}

// an allowlisted path that exists now (its stage landed) leaves the list
for (const [p, why] of allow) if (existsSync(join(root, p))) problems.push(`scripts/doc-paths-allowlist.txt: ${p} exists now (${why}): remove the line`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} documentation path problem(s) (${checked} paths checked)`);
  process.exit(1);
}
console.log(`documentation paths: ${checked} checked, all present; no old-layout path`);
