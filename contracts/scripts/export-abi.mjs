#!/usr/bin/env node
// Export ABIs from forge artifacts: the frozen core set (abi/*.json + SHA256SUMS, spec v1.0 §14) and
// the periphery (abi/periphery/*.json, with creation bytecode so the TypeScript engine can compute
// CREATE2 escrow addresses and the local stack can deploy). Run after `forge build`:  node scripts/export-abi.mjs
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
const PERIPHERY = ["SwapOrderEscrow", "SwapOrderFactory", "ProtectRouter", "ShieldReceiverFactory", "ShieldReceiver"];
for (const c of PERIPHERY) {
  const a = art(c);
  writeFileSync(join(root, "abi", "periphery", `${c}.json`), JSON.stringify({ abi: a.abi, bytecode: a.bytecode.object }, null, 2) + "\n");
}
// the development verifier's runtime code (the fifth review round, 2026-11-03): the wallet refuses a production deployment whose inner
// verifier is this key, which accepts any proof; exported as its deployed bytecode, hashed where it is read
mkdirSync(join(root, "abi", "dev"), { recursive: true });
const dev = art("TransactionVerifierDev");
// and the key's own words (the eleventh review round, 2026-11-04, G11-4): its delta and IC points, the 32-byte immediates every compilation of
// the template embeds — the code hash recognised this one compilation alone
const devSource = readFileSync(join(root, "src", "verifier", "dev", "TransactionVerifierDev.sol"), "utf8");
const keyWords = ["deltax1", "deltay1", "IC0x", "IC0y"].map((name) => {
  const m = new RegExp(`uint256 constant ${name} = (\\d+);`).exec(devSource);
  if (!m) throw new Error(`TransactionVerifierDev.sol: no ${name}`);
  return "0x" + BigInt(m[1]).toString(16).padStart(64, "0");
});
writeFileSync(join(root, "abi", "dev", "TransactionVerifierDev.json"), JSON.stringify({ deployedBytecode: dev.deployedBytecode.object, keyWords }, null, 2) + "\n");
// the Poseidon2 hasher's runtime code (the eleventh review round, G11-1): the wallet requires the core's HASHER to be this code — it has no
// immutables, so its hash is a constant of the pinned build
mkdirSync(join(root, "abi", "runtime"), { recursive: true });
writeFileSync(join(root, "abi", "runtime", "Poseidon2Hasher.json"), JSON.stringify({ deployedBytecode: art("Poseidon2Hasher").deployedBytecode.object }, null, 2) + "\n");
console.log(`exported ${CORE.length} frozen core ABIs (+SHA256SUMS), ${PERIPHERY.length} periphery artifacts with bytecode and the development verifier's runtime code`);
