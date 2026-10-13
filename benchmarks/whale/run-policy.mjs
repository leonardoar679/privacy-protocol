#!/usr/bin/env node
// Runs the policy benchmark (packages/protocol/src/sim/policyBenchmark.ts; High-Value Execution Engine plan §119–§123)
// on the measured quotes of execution.json and the whale UTXO lab's rows (utxo-10m.json), with gas priced at the LIVE
// gas price and ETH/USD fetched by benchmarks/gas/cost.mjs when this runs (never a constant). Writes policy.json next to
// this file and docs/HighValuePolicyBenchmark.md. Usage: node run-policy.mjs [--seed 4242] [--no-live]
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ref = join(root, "packages", "protocol");
const argv = process.argv.slice(2);
const noLive = argv.includes("--no-live");

let gwei = null, ethUsd = null;
if (!noLive) {
  const cost = spawnSync("node", [join(root, "benchmarks", "gas", "cost.mjs"), "--json"], { encoding: "utf8", shell: true });
  try { const j = JSON.parse(cost.stdout); gwei = j.gas?.gwei ?? null; ethUsd = j.eth?.usd ?? null; } catch { /* no live price: gas in units only */ }
  if (gwei === null || ethUsd === null) console.log("live gas price unavailable: gas is reported in units only");
  else console.log(`live gas price ${gwei.toFixed(3)} gwei, ETH $${ethUsd.toFixed(0)}`);
}
const args = ["tsx", "src/sim/policyBenchmark.ts", "--execution", join(here, "execution.json"), "--utxo", join(here, "utxo-10m.json"), "--json", join(here, "policy.json"), "--md", join(root, "docs", "HighValuePolicyBenchmark.md"), ...argv.filter((a) => a !== "--no-live")];
if (gwei !== null && ethUsd !== null) args.push("--gwei", String(gwei), "--eth-usd", String(ethUsd));
const r = spawnSync("npx", args, { cwd: ref, stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
