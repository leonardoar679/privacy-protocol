#!/usr/bin/env node
// Runs the whale execution lab (packages/swap-engine/src/sim/whaleLab.ts, plan V2 §119) — live,
// read-only provider quotes at $100K … $25M — and writes execution.json + execution.md next to this
// file. Usage: node run-execution.mjs [--sizes 100000,1000000] [--pairs ETH>BTC] [--pause 1500]
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const svc = join(here, "..", "..", "packages", "swap-engine");
const r = spawnSync("npx", ["tsx", "src/sim/whaleLab.ts", ...process.argv.slice(2), "--json", join(here, "execution.json"), "--md", join(here, "execution.md")], {
  cwd: svc, stdio: "inherit", shell: true,
});
process.exit(r.status ?? 1);
