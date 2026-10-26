// The Classic app's performance budget (spec v3.0 §7.8, §10), over the production build's Vite manifest: the first route
// — the entry chunk and every chunk it imports statically — is at most 200 KB of gzipped JavaScript, and it never
// carries the prover (websnark's genWitnessAndProve / buildGroth16, the witness calculator) or a WASM asset: those load
// in the prover worker at the first withdrawal (spec §7.3).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
export const DIST = join(here, "..", "dist");
export const FIRST_ROUTE_KB = 200;
// the prover's names, websnark's WebAssembly module in base64 (the bytes "\0asm"), its sub-worker protocol
// … and the vendored arithmetic (the MiMC seed, the Pedersen generators), which only the worker may load
const PROVER = /\b(genWitnessAndProve|buildGroth16|calculateWitness|PedersenGenerator|mimcsponge)\b|"AGFzbQ|"TERMINATE"/;

export function checkBudget(dist = DIST) {
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, problems: ["no manifest at dist/.vite/manifest.json (npm run build first)"], kb: null };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && k.endsWith("index.html"));
  if (!entryKey) return { ok: false, problems: ["the manifest has no index.html entry"], kb: null };
  const seen = new Set();
  const visit = (k) => {
    if (seen.has(k) || !manifest[k]) return;
    seen.add(k);
    for (const i of manifest[k].imports ?? []) visit(i);
  };
  visit(entryKey);
  const problems = [];
  let bytes = 0;
  for (const k of seen) {
    const m = manifest[k];
    if (!m.file.endsWith(".js")) continue;
    const text = readFileSync(join(dist, m.file), "utf8");
    bytes += gzipSync(text, { level: 9 }).length;
    if (PROVER.test(text)) problems.push(`${m.file} carries the prover before a withdrawal needs it`);
    if ((m.assets ?? []).some((a) => a.endsWith(".wasm"))) problems.push(`${m.file} carries a WASM asset before it is needed`);
  }
  const kb = bytes / 1024;
  if (kb > FIRST_ROUTE_KB) problems.push(`the first route is ${kb.toFixed(1)} KB gzipped (budget ${FIRST_ROUTE_KB} KB)`);
  return { ok: problems.length === 0, problems, kb, chunks: seen.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkBudget();
  for (const p of r.problems) console.error(`FAIL  ${p}`);
  if (r.ok)
    console.log(
      `PASS  budget: the first route ${r.kb.toFixed(1)} KB gzipped (≤ ${FIRST_ROUTE_KB}); no prover and no WASM before they are needed (${r.chunks} chunks)`,
    );
  process.exit(r.ok ? 0 : 1);
}
