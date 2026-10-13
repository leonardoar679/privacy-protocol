#!/usr/bin/env node
// Runs the whale UTXO lab (packages/protocol/src/sim/whaleUtxoLab.ts, plan V2 §74 / §120) and writes
// utxo.json next to this file. Usage: node run-utxo.mjs [--whales 24] [--amount 1330] [--seed 4242]
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const ref = join(here, "..", "..", "packages", "protocol");
const r = spawnSync("npx", ["tsx", "src/sim/whaleUtxoLab.ts", ...process.argv.slice(2), "--json", join(here, "utxo.json")], { cwd: ref, stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
