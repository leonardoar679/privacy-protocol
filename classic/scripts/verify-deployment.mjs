#!/usr/bin/env node
// The Classic deployment verified against Ethereum mainnet (spec v3.0 §7.2; V7 Stage 5): every pinned contract's runtime
// code read from the chain and held against its Sourcify record and, unless --no-rebuild, against a rebuild with the
// pinned compiler (downloaded once, sha256-checked); the pools' facts (verifier, levels, denomination, operator renounced,
// ROOT_HISTORY_SIZE 100, the deposit count), the router's governance and registries, the registries' proxies and the
// pools' instance states, the verifier's key constants from its source. --write records the result as the app's pins
// (src/config/deployment.json) and the report (docs/deployment-verification-<date>.md); without it the run compares
// the chain with the committed pins and exits 1 on any drift (the live test does the same).
//   node scripts/verify-deployment.mjs [--rpc <url[,url]>] [--write] [--no-rebuild]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPILERS, compilerCached, fetchCompiler, loadCompiler } from "./compilers.mjs";
import { CONTRACTS, makeRpc, PINS_FILE, POOL_IDS, PUBLIC_RPC_URLS, readPins, rebuildRecord, verifyDeployment } from "./deployment.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const urls = (option("--rpc") ?? process.env.CLASSIC_RPC_URLS ?? PUBLIC_RPC_URLS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const write = flag("--write");
const noRebuild = flag("--no-rebuild");

/** The rebuild of a record with its compiler, fetched when absent; null when the build cannot be had. */
async function rebuilder() {
  const loaded = new Map();
  return async (record) => {
    const v = record.compilation.compilerVersion;
    if (!COMPILERS[v]) return null;
    if (!loaded.has(v)) {
      if (!compilerCached(v)) {
        console.log(`  fetching solc ${v} (${COMPILERS[v].path}) …`);
        await fetchCompiler(v);
      }
      loaded.set(v, loadCompiler(v));
    }
    return { bytecode: rebuildRecord(record, loaded.get(v)), compiler: v };
  };
}

const rpc = makeRpc(urls);
const pins = write ? null : readPins();
if (!write && !pins) {
  console.error("no pins at src/config/deployment.json: run with --write first");
  process.exit(2);
}
console.log(`verifying the Classic deployment against ${urls.join(", ")}${write ? " (writing the pins)" : " (against the committed pins)"}`);
const result = await verifyDeployment({ rpc, rebuild: noRebuild ? null : await rebuilder(), pins });
for (const r of result.rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}${r.problems?.length ? ` — ${r.problems.join("; ")}` : ""}`);

if (write) {
  const out = { ...result.pins, compilers: Object.fromEntries(Object.keys(result.pins.compilers).map((v) => [v, COMPILERS[v]])) };
  mkdirSync(dirname(PINS_FILE), { recursive: true });
  writeFileSync(PINS_FILE, JSON.stringify(out, null, 2) + "\n");
  const report = join(here, "..", "docs", `deployment-verification-${out.readAt.date}.md`);
  writeFileSync(report, reportOf(out, result, urls));
  console.log(`\npins written to src/config/deployment.json; the report to docs/deployment-verification-${out.readAt.date}.md`);
}
console.log(`\n${result.rows.filter((r) => r.ok).length}/${result.rows.length} checks passed`);
process.exit(result.ok ? 0 : 1);

function reportOf(p, result, endpoints) {
  const pool = (id) => p.pools[id];
  const lines = [];
  lines.push(`# The Classic deployment, verified on ${p.readAt.date}`, "");
  lines.push(
    `Ethereum mainnet (chain id ${p.chainId}), block ${p.readAt.block.toLocaleString("en-US")}, read through ${endpoints.join(" and ")} by \`classic/scripts/verify-deployment.mjs --write\` (spec v3.0 §7.2; V7 Stage 5). Every contract's runtime code was compared with its Sourcify record (\`classic/contracts/verified/\`) and rebuilt with the pinned compiler (\`classic/scripts/compilers.mjs\`), modulo the record's transformations: the linked \`Hasher\` library, the metadata hash, the router's immutables. The pins live in \`classic/src/config/deployment.json\`; \`node scripts/verify-deployment.mjs\` (and the live suite under \`verify-all --live\`) reads the chain again and fails on any drift.`,
    "",
  );
  lines.push("## The checks", "", "| Check | Result | Detail |", "|---|---|---|");
  for (const r of result.rows)
    lines.push(`| ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "\\|")}${r.problems?.length ? ` — ${r.problems.join("; ")}` : ""} |`);
  lines.push(
    "",
    "## The pools",
    "",
    "| Pool | Address | Runtime code (sha256, bytes) | Source | Deployed | Verifier | levels | denomination (wei) | operator | ROOT_HISTORY_SIZE | Deposits | Hasher |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const id of POOL_IDS) {
    const q = pool(id);
    lines.push(
      `| ${q.amount} ETH | \`${q.address}\` | \`${q.runtime.sha256}\`, ${q.runtime.bytes} | ${q.source.name} (solc ${q.source.compiler}; Sourcify ${q.source.sourcify}) | ${q.deployedBlock.toLocaleString("en-US")} | \`${q.verifier}\` | ${q.levels} | ${q.denominationWei} | \`${q.operator}\` | ${q.rootHistorySize} | ${q.nextIndex.toLocaleString("en-US")} | \`${q.libraries["TornadoCash_eth.sol:Hasher"] ?? q.libraries["TornadoCash_Eth_01.sol:Hasher"] ?? "—"}\` |`,
    );
  }
  lines.push("", "## The verifier, the router and the registries", "");
  lines.push(
    `- The shared verifier \`${p.verifier.address}\`: ${p.verifier.source.name}, solc ${p.verifier.source.compiler}, runtime sha256 \`${p.verifier.runtime.sha256}\` (${p.verifier.runtime.bytes} B), deployed at block ${p.verifier.deployedBlock.toLocaleString("en-US")} — after the pools, which point at it: the pools' verifier was updated to this one while the operator still existed, and the operator was then renounced. Its key has ${p.verifier.vk.nPublic} public inputs (root, nullifierHash, recipient, relayer, fee, refund); the constants are in the pins (\`verifier.vk\`).`,
  );
  lines.push(
    `- The router \`${p.router.address}\`: ${p.router.source.name}, solc ${p.router.source.compiler} (Sourcify ${p.router.source.sourcify}), deployed at block ${p.router.deployedBlock.toLocaleString("en-US")}; governance \`${p.router.governance}\`; instanceRegistry \`${p.router.instanceRegistry}\`; relayerRegistry \`${p.router.relayerRegistry}\`.`,
  );
  for (const name of ["instanceRegistry", "relayerRegistry"]) {
    const r = p[name];
    lines.push(
      `- The ${name === "instanceRegistry" ? "instance" : "relayer"} registry \`${r.address}\`: an ${r.source.name} (solc ${r.source.compiler}) whose implementation is \`${r.proxy.implementation}\` (${r.proxy.implementationRuntime.bytes} B, sha256 \`${r.proxy.implementationRuntime.sha256}\`) and whose admin is \`${r.proxy.admin}\` (governance): upgradeable, unlike the pools — the availability model reports it apart (spec §7.7).`,
    );
  }
  lines.push("", "| Pool | Instance state | ERC-20 | Protocol fee (×0.01 %) |", "|---|---|---|---|");
  for (const id of POOL_IDS) {
    const i = p.instanceRegistry.instances[id];
    lines.push(`| ${pool(id).amount} ETH | ${i.stateName} | ${i.isERC20 ? "yes" : "no"} | ${i.protocolFeePercentage} |`);
  }
  lines.push("", "## The compilers", "", "| solc | Build | sha256 |", "|---|---|---|");
  for (const [v, c] of Object.entries(p.compilers)) lines.push(`| ${v} | ${c.path} | \`${c.sha256}\` |`);
  lines.push(
    "",
    "The builds are downloaded from binaries.soliditylang.org into `classic/contracts/verified/compilers/` (git-ignored) and refused unless they hash to these pins.",
    "",
  );
  return lines.join("\n");
}
