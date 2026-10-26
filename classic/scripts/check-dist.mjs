// What the Classic app's production build must and must not carry (spec v3.0 §7.8): the content security policy meta
// (no inline script, no eval), the Vite manifest the budget reads, the artifact pin file; no source map, none of the
// Privacy Wallet's fixture or preview sentinels. Run after `npm run build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cspOfHtml } from "./csp.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
export const DIST = join(here, "..", "dist");
const SENTINELS = ["pw-fixture-sentinel", "pw-preview-sentinel"];

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

export function checkDist(dist = DIST) {
  const problems = [];
  if (!existsSync(join(dist, "index.html"))) return { ok: false, problems: ["no dist/ build to inspect (npm run build first)"], files: 0 };
  const csp = cspOfHtml(readFileSync(join(dist, "index.html"), "utf8"));
  if (!csp) problems.push("dist/index.html carries no content security policy meta");
  else {
    if (!/default-src 'self'/.test(csp) || !/object-src 'none'/.test(csp)) problems.push("the policy lacks default-src 'self' or object-src 'none'");
    if (/'unsafe-inline'|'unsafe-eval'/.test(csp)) problems.push("the policy allows inline script or eval");
  }
  if (!existsSync(join(dist, ".vite", "manifest.json"))) problems.push("dist/.vite/manifest.json is missing (build.manifest)");
  if (!existsSync(join(dist, "artifacts.json"))) problems.push("dist/artifacts.json is missing (public/artifacts.json ships with the build)");
  const all = files(dist);
  if (all.some((p) => p.endsWith(".map"))) problems.push("dist/ ships a source map");
  for (const f of all.filter((p) => /\.(js|html|css|json)$/.test(p))) {
    const text = readFileSync(f, "utf8");
    for (const s of SENTINELS) if (text.includes(s)) problems.push(`${relative(dist, f)} carries ${s}`);
    if (f.endsWith(".js") && /sourceMappingURL=/.test(text)) problems.push(`${relative(dist, f)} names a source map`);
  }
  return { ok: problems.length === 0, problems, files: all.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkDist();
  for (const p of r.problems) console.error(`FAIL  ${p}`);
  if (r.ok) console.log(`PASS  dist/: the policy meta, the manifest, the pin file; no source map, no sentinel (${r.files} files)`);
  process.exit(r.ok ? 0 : 1);
}
