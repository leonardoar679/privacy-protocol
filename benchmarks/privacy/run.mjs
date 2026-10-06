#!/usr/bin/env node
// Runs the privacy lab (reference/typescript/src/sim/privacyLab.ts) with the study's parameters and
// writes results.json next to this file. Usage: node run.mjs [--users 8000] [--rate 10] [--seed 4242]
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const ref = join(here, "..", "..", "reference", "typescript");
const r = spawnSync("npx", ["tsx", "src/sim/privacyLab.ts", ...process.argv.slice(2), "--json", join(here, "results.json")], {
  cwd: ref, stdio: "inherit", shell: true,
});
process.exit(r.status ?? 1);
