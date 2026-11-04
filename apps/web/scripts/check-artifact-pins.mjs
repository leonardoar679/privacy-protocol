#!/usr/bin/env node
// The artifact pin check (Privacy Wallet Web spec §20–§21; verify-all "apps/web artifact pins"): every pinned runtime
// artifact present on this machine hashes to its pin in public/artifacts.json; a present artifact without a pin fails
// (it would be served unpinned); a pinned file absent from the machine is skipped (a clone without the circuit build).
// When a dist/ build exists, its index.html must carry the content security policy meta and ship the pin file.
//   node scripts/check-artifact-pins.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedSinceBase, comparePins, frontend, hashArtifacts, readPins } from "./artifact-pins-lib.mjs";
import { cspOfHtml } from "./csp.mjs";

const pins = readPins();
if (!pins) { console.error("FAIL  public/artifacts.json is missing or unreadable — run node scripts/pin-artifacts.mjs"); process.exit(1); }
const { ok, rows } = comparePins(pins, hashArtifacts());
for (const r of rows) console.log(`${r.status === "match" ? "PASS" : r.status === "skipped" || r.status === "absent" ? "SKIP" : "FAIL"}  ${r.name}: ${r.status} — ${r.detail}`);
let buildOk = true;
const dist = join(frontend, "dist");
if (existsSync(join(dist, "index.html"))) {
  const csp = cspOfHtml(readFileSync(join(dist, "index.html"), "utf8"));
  const hasCsp = !!csp && /default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*'unsafe-eval'/.test(csp);
  const hasPins = existsSync(join(dist, "artifacts.json"));
  console.log(`${hasCsp ? "PASS" : "FAIL"}  dist/index.html carries the content security policy${csp ? ` (${csp.length} chars)` : ""}`);
  console.log(`${hasPins ? "PASS" : "FAIL"}  dist/ ships artifacts.json`);
  buildOk = hasCsp && hasPins;
} else console.log("SKIP  no dist/ build to inspect (npm run build)");
const pinned = rows.filter((r) => r.status === "match").length;
console.log(`artifact pins: ${pinned} verified, ${rows.filter((r) => r.status === "skipped" || r.status === "absent").length} skipped, ${rows.filter((r) => r.status === "mismatch" || r.status === "unpinned").length} failing${buildOk ? "" : "; the build check failed"}`);
// verify-all sets REQUIRE_PINNED_ARTIFACTS when the circuit build and the core WASM package exist on this machine: then a
// "skipped" pin means a wrong path (V6 Stage 1 found one), never a clone without the artifacts
const requireAll = process.env.REQUIRE_PINNED_ARTIFACTS === "1" && rows.some((r) => r.status === "skipped");
if (requireAll) console.log("FAIL  REQUIRE_PINNED_ARTIFACTS=1 but a pinned artifact was not found (a wrong path?)");
// a pin file that changed since the base, on a machine without the artifacts to verify it (the sixth review round, 2026-11-03): every
// row "skipped" had passed, so a pull request could rewrite the proving key's hash unseen — PINS_BASE names the commit to compare
const changedUnseen = !!process.env.PINS_BASE && rows.some((r) => r.status === "skipped") && changedSinceBase(process.env.PINS_BASE, "apps/web/public/artifacts.json");
if (changedUnseen) console.log(`FAIL  public/artifacts.json changed since ${process.env.PINS_BASE} and the artifacts are not on this machine to verify the new pins: run the check where the circuit build and the core WASM are`);
process.exitCode = ok && buildOk && !requireAll && !changedUnseen ? 0 : 1;
