#!/usr/bin/env node
// The artifact pin check (Privacy Wallet Web spec §20–§21; verify-all "frontend artifact pins"): every pinned runtime
// artifact present on this machine hashes to its pin in public/artifacts.json; a present artifact without a pin fails
// (it would be served unpinned); a pinned file absent from the machine is skipped (a clone without the circuit build).
// When a dist/ build exists, its index.html must carry the content security policy meta and ship the pin file.
//   node scripts/check-artifact-pins.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { comparePins, frontend, hashArtifacts, readPins } from "./artifact-pins-lib.mjs";
import { cspOfHtml } from "./csp.mjs";

const pins = readPins();
if (!pins) { console.error("FAIL  public/artifacts.json is missing or unreadable — run node scripts/pin-artifacts.mjs"); process.exit(1); }
const { ok, rows } = comparePins(pins, hashArtifacts());
for (const r of rows) console.log(`${r.status === "match" ? "PASS" : r.status === "skipped" || r.status === "absent" ? "SKIP" : "FAIL"}  ${r.name}: ${r.status} — ${r.detail}`);
let buildOk = true;
const dist = join(frontend, "dist");
if (existsSync(join(dist, "index.html"))) {
  const csp = cspOfHtml(readFileSync(join(dist, "index.html"), "utf8"));
  const hasCsp = !!csp && /default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp);
  const hasPins = existsSync(join(dist, "artifacts.json"));
  console.log(`${hasCsp ? "PASS" : "FAIL"}  dist/index.html carries the content security policy${csp ? ` (${csp.length} chars)` : ""}`);
  console.log(`${hasPins ? "PASS" : "FAIL"}  dist/ ships artifacts.json`);
  buildOk = hasCsp && hasPins;
} else console.log("SKIP  no dist/ build to inspect (npm run build)");
const pinned = rows.filter((r) => r.status === "match").length;
console.log(`artifact pins: ${pinned} verified, ${rows.filter((r) => r.status === "skipped" || r.status === "absent").length} skipped, ${rows.filter((r) => r.status === "mismatch" || r.status === "unpinned").length} failing${buildOk ? "" : "; the build check failed"}`);
process.exitCode = ok && buildOk ? 0 : 1;
