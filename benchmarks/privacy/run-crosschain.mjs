#!/usr/bin/env node
// Runs the cross-chain observer lab (services/private-swap/src/sim/crossChainLab.ts, plan §72) and
// writes crosschain.json next to this file. Usage: node run-crosschain.mjs [--swaps 6000] [--seed 4242] [--share 0.2]
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const svc = join(here, "..", "..", "services", "private-swap");
const r = spawnSync("npx", ["tsx", "src/sim/crossChainLab.ts", ...process.argv.slice(2), "--json", join(here, "crosschain.json")], {
  cwd: svc, stdio: "inherit", shell: true,
});
process.exit(r.status ?? 1);
