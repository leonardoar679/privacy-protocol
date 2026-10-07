#!/usr/bin/env node
// Export ABIs from forge artifacts: the frozen core set (abi/*.json + SHA256SUMS, spec v1.0 §14) and
// the periphery (abi/periphery/*.json, with creation bytecode so the TypeScript engine can compute
// CREATE2 escrow addresses). Run after `forge build`:  node scripts/export-abi.mjs
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = (name) => JSON.parse(readFileSync(join(root, "out", `${name}.sol`, `${name}.json`), "utf8"));

const CORE = ["PrivacyCore", "AssetVaultFactory", "NativeAssetVault", "ERC20AssetVault", "Groth16Verifier", "Poseidon2Hasher"];
const sums = [];
for (const c of CORE) {
  const json = JSON.stringify(art(c).abi, null, 2) + "\n";
  writeFileSync(join(root, "abi", `${c}.json`), json);
  sums.push(`${createHash("sha256").update(json).digest("hex")} abi/${c}.json`);
}
writeFileSync(join(root, "abi", "SHA256SUMS"), sums.join("\n") + "\n");

mkdirSync(join(root, "abi", "periphery"), { recursive: true });
for (const c of ["SwapOrderEscrow", "SwapOrderFactory"]) {
  const a = art(c);
  writeFileSync(join(root, "abi", "periphery", `${c}.json`), JSON.stringify({ abi: a.abi, bytecode: a.bytecode.object }, null, 2) + "\n");
}
console.log(`exported ${CORE.length} frozen core ABIs (+SHA256SUMS) and 2 periphery artifacts with bytecode`);
