#!/usr/bin/env node
// Writes the artifact pins (Privacy Wallet Web spec §20; Stage 11): public/artifacts.json — the SHA-256 and size of
// every runtime artifact found on this machine (artifact-pins-lib.mjs lists them) — and docs/build-hashes.md, the same
// table for the record; with --dist, the hashes of the current dist/ build are appended to the document. Run it after
// a circuit build, a core build or a ceremony; commit both files; check-artifact-pins.mjs refuses a drift.
//   node scripts/pin-artifacts.mjs [--dist]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ARTIFACTS, DOC_FILE, PIN_FILE, frontend, hashArtifacts, sha256Hex } from "./artifact-pins-lib.mjs";

const withDist = process.argv.includes("--dist");
const actual = hashArtifacts();
const pins = { v: 1, pinnedAt: new Date().toISOString(), setup: "circuits/setup/dev — the insecure single-party development setup; a production ceremony replaces the proving key and this pin", files: Object.fromEntries(Object.entries(actual).map(([name, a]) => [name, { sha256: a.sha256, bytes: a.bytes }])) };
writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2) + "\n");

const lines = [
  "# Build hashes — the runtime artifacts and their pins (Privacy Wallet Web spec §20)",
  "",
  "`apps/web/public/artifacts.json` is served beside the app; the prover worker (`src/prover/pins.ts`) hashes the proving key it fetched and",
  "refuses a mismatch in a production build (a warning in dev). `node scripts/check-artifact-pins.mjs` (verify-all's \"apps/web artifact pins\"",
  "step) recomputes every pinned file on the machine. Regenerate with `node scripts/pin-artifacts.mjs` after a circuit build, a core build or a",
  "ceremony, and commit both files.",
  "",
  `Pinned at ${pins.pinnedAt}. Setup: ${pins.setup}.`,
  "",
  "| artifact | served at | SHA-256 | bytes | source |",
  "|---|---|---|---|---|",
  ...ARTIFACTS.map((a) => { const h = actual[a.name]; return h ? `| \`${a.name}\` — ${a.what} | \`${a.served}\` | \`${h.sha256}\` | ${h.bytes.toLocaleString("en-US")} | \`${h.source}\` |` : `| \`${a.name}\` — ${a.what} | \`${a.served}\` | _not on this machine_ | | |`; }),
];
if (withDist) {
  const dist = join(frontend, "dist");
  if (existsSync(dist)) {
    const files = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(dist);
    lines.push("", `## dist/ (${new Date().toISOString()})`, "", "| file | SHA-256 | bytes |", "|---|---|---|");
    for (const p of files.sort()) { if (statSync(p).size > 64 * 1024 * 1024) continue; lines.push(`| \`${relative(dist, p).replace(/\\/g, "/")}\` | \`${sha256Hex(readFileSync(p))}\` | ${statSync(p).size.toLocaleString("en-US")} |`); }
  } else lines.push("", "_no dist/ build to hash (npm run build first)_");
}
writeFileSync(DOC_FILE, lines.join("\n") + "\n");
console.log(`pinned ${Object.keys(actual).length} of ${ARTIFACTS.length} artifacts → public/artifacts.json, docs/build-hashes.md${withDist ? " (+ dist/)" : ""}`);
for (const a of ARTIFACTS) console.log(`  ${actual[a.name] ? "pinned " : "missing"} ${a.name}${actual[a.name] ? `  ${actual[a.name].sha256.slice(0, 16)}… (${actual[a.name].bytes} bytes)` : ""}`);
