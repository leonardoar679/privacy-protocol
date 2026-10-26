// Every bare import of the Classic app names a package its own manifest declares (spec v3.0 §7.8): the app sits below the
// monorepo's root, so Node and Vite would silently resolve an undeclared package from the Privacy Wallet's node_modules —
// a dependency the Classic lockfile never recorded. src/ may use dependencies; test/, scripts/ and the configs may use
// devDependencies too; src/ never imports a Node built-in or a @privacy-wallet package.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP = join(here, "..");
const CODE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const SPECS = [
  /(?<=[\s}*])from\s*["']([^"'\n]+)["']/g,
  /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
  /\bimport\(\s*["']([^"'\n]+)["']/g,
  /\brequire\(\s*["']([^"'\n]+)["']/g,
];
const uncomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
const packageOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const isBuiltin = (name) => name.startsWith("node:") || builtinModules.includes(name);
// files whose text quotes requires that are not theirs: the conversion lists (the originals' requires, replaced) and
// websnark's Node worker bootstrap string (a require of worker_threads executed in a Node worker thread only)
const QUOTED = new Set(["scripts/vendor.mjs", "src/prover/legacy/groth16.js"]);

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "public" || e === "contracts" || e === "vendor" || e.startsWith(".")) continue; // contracts/: the records and the downloaded compiler builds; vendor/: the pristine originals, never built
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (CODE.test(e)) out.push(p);
  }
  return out;
}

export function checkDeps(app = APP) {
  const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const problems = [];
  let checked = 0;
  for (const abs of files(app)) {
    const file = relative(app, abs).replace(/\\/g, "/");
    if (QUOTED.has(file)) continue;
    const isSrc = file.startsWith("src/");
    const src = uncomment(readFileSync(abs, "utf8"));
    for (const rx of SPECS) {
      for (const m of src.matchAll(rx)) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        checked++;
        const pkgName = packageOf(spec);
        if (isBuiltin(pkgName)) {
          if (isSrc) problems.push(`${file}: src imports the Node built-in ${spec}`);
          continue;
        }
        if (pkgName.startsWith("@privacy-wallet/")) {
          problems.push(`${file}: imports ${spec} — the Classic app shares no runtime code with the Privacy Wallet (spec v3.0 §7.8)`);
          continue;
        }
        if (deps.has(pkgName)) continue;
        if (!isSrc && dev.has(pkgName)) continue;
        if (pkgName === "vitest" || pkgName === "vite") {
          if (isSrc) problems.push(`${file}: src imports ${spec}`);
          continue;
        }
        problems.push(`${file}: imports ${spec}, which classic/package.json does not declare${isSrc ? " in dependencies" : ""}`);
      }
    }
  }
  return { ok: problems.length === 0, problems, checked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkDeps();
  if (!r.ok) {
    console.error(r.problems.join("\n"));
    process.exit(1);
  }
  console.log(`PASS  deps: ${r.checked} bare imports, every one declared by classic/package.json`);
}
