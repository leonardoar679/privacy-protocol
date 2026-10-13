// The package boundaries of the monorepo (spec v2.0 §4; V6 Stage 4). Over every workspace's code:
//   1. no relative import crosses into another workspace (a package is imported by its name, @privacy-wallet/…);
//   2. a package never imports an app;
//   3. an engine package never imports React, Radix or the UI (it renders nothing);
//   4. the UI never imports the SDK or an engine (presentation only);
//   5. every @privacy-wallet/* import names a workspace the importer declares (dependencies, or devDependencies for its
//      tests, scripts and configs), and the declared workspace graph has no cycle;
//   6. among the wallet's code, only the privacy engine's chain transport makes a viem client (doc §65) — the Private
//      AI's own funding account on its pinned chain excepted (docs/zkapi-integration-spec.md §6);
//   7. only the wallet engine's injected.ts reads the browser's injected provider (window.ethereum).
// Usage: node scripts/check-boundaries.mjs (exit 1 with every violation listed).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "public", "out", "coverage", ".vite"]);
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const APPS = new Set(["@privacy-wallet/web", "@privacy-wallet/relayer", "@privacy-wallet/api"]);
const UI = "@privacy-wallet/ui";
const RENDERING = /^(react|react-dom|@radix-ui\/[\w.-]+)$/;
const ENGINES = new Set([
  "@privacy-wallet/sdk",
  "@privacy-wallet/wallet-engine",
  "@privacy-wallet/privacy-engine",
  "@privacy-wallet/risk-engine",
  "@privacy-wallet/swap-engine",
]);
const WALLET_CODE = [
  "apps/web/src",
  "packages/sdk/src",
  "packages/wallet-engine/src",
  "packages/privacy-engine/src",
  "packages/risk-engine/src",
  "packages/ui/src",
];
const CLIENT_MAKERS = ["packages/privacy-engine/src/transport/chain.ts", "apps/web/src/zkapi/freshAccountProvider.ts"];
const INJECTED_READER = "packages/wallet-engine/src/injected.ts";

const posix = (p) => p.split(sep).join("/");
const rel = (p) => posix(relative(ROOT, p));

function workspaces() {
  const out = [];
  for (const base of ["apps", "packages"]) {
    for (const d of readdirSync(join(ROOT, base))) {
      const pj = join(ROOT, base, d, "package.json");
      if (!existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, "utf8"));
      out.push({
        root: `${base}/${d}`,
        name: j.name,
        deps: new Set(Object.keys({ ...j.dependencies, ...j.peerDependencies })),
        dev: new Set(Object.keys(j.devDependencies ?? {})),
      });
    }
  }
  return out;
}

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (CODE.test(e)) out.push(p);
  }
  return out;
}

// block comments and comment lines go; strings stay (a URL's "//" is not a comment)
const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
const SPECS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
  /\bimport\(\s*["']([^"'\n]+)["']/g,
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*["']([^"'\n]+)["']/g,
  /\brequire\(\s*["']([^"'\n]+)["']/g,
];
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
const packageOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const isDevFile = (r) =>
  /(^|\/)(test|tests|scripts)\//.test(r) || /\.test\.[cm]?[jt]sx?$/.test(r) || /(^|\/)[\w.-]*\.config\.[cm]?[jt]s$/.test(r) || /(^|\/)vitest\.[\w.-]+$/.test(r);

export function check() {
  const ws = workspaces();
  const byName = new Map(ws.map((w) => [w.name, w]));
  const owner = (abs) => ws.filter((w) => posix(abs).startsWith(posix(join(ROOT, w.root)) + "/")).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
  const problems = [];
  const report = (file, line, msg) => problems.push(`${file}:${line}: ${msg}`);

  for (const w of ws) {
    for (const abs of files(join(ROOT, w.root))) {
      const file = rel(abs);
      const src = uncomment(readFileSync(abs, "utf8"));
      const dev = isDevFile(file.slice(w.root.length + 1));
      for (const rx of SPECS) {
        for (const m of src.matchAll(rx)) {
          const spec = m[1];
          const line = lineOf(src, m.index);
          if (spec.startsWith(".")) {
            const target = owner(resolve(dirname(abs), spec));
            if (target && target !== w) report(file, line, `rule 1: a relative import crosses into ${target.root} (${spec}); import ${target.name} by name`);
            continue;
          }
          const pkg = packageOf(spec);
          const isPackage = w.root.startsWith("packages/");
          if (isPackage && APPS.has(pkg)) report(file, line, `rule 2: a package imports the app ${pkg}`);
          if (isPackage && w.name !== UI && (RENDERING.test(pkg) || pkg === UI)) report(file, line, `rule 3: an engine package imports ${pkg}`);
          if (w.name === UI && ENGINES.has(pkg)) report(file, line, `rule 4: the UI imports ${pkg}`);
          if (pkg.startsWith("@privacy-wallet/") && pkg !== w.name) {
            if (!byName.has(pkg)) report(file, line, `rule 5: ${pkg} is not a workspace`);
            else if (!w.deps.has(pkg) && !(dev && w.dev.has(pkg)))
              report(file, line, `rule 5: ${pkg} is not declared in ${w.root}/package.json${dev ? " (dependencies or devDependencies)" : " dependencies"}`);
          }
        }
      }
      if (WALLET_CODE.some((d) => file.startsWith(d + "/"))) {
        for (const m of src.matchAll(/\bcreate(Public|Wallet)Client\s*\(/g))
          if (!CLIENT_MAKERS.includes(file))
            report(
              file,
              lineOf(src, m.index),
              "rule 6: a viem client outside the privacy engine's chain transport (packages/privacy-engine/src/transport/chain.ts)",
            );
        for (const m of src.matchAll(/\(?\s*\bwindow\b[^();\n]*\)?\s*\.\s*ethereum\b/g))
          if (file !== INJECTED_READER) report(file, lineOf(src, m.index), `rule 7: window.ethereum outside ${INJECTED_READER}`);
      }
    }
  }

  // rule 5: the declared workspace graph (dependencies and peers) has no cycle
  const state = new Map();
  const visit = (w, path) => {
    if (state.get(w.name) === "done") return;
    if (state.get(w.name) === "open") {
      problems.push(`package.json: rule 5: a dependency cycle: ${[...path, w.name].join(" → ")}`);
      return;
    }
    state.set(w.name, "open");
    for (const d of w.deps) if (byName.has(d)) visit(byName.get(d), [...path, w.name]);
    state.set(w.name, "done");
  };
  for (const w of ws) visit(w, []);
  return { problems, workspaces: ws.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, workspaces: n } = check();
  if (problems.length) {
    console.error(`package boundaries: ${problems.length} violation(s)\n` + problems.map((p) => "  " + p).join("\n"));
    process.exit(1);
  }
  console.log(`package boundaries: ${n} workspaces, every import within its rules`);
}
