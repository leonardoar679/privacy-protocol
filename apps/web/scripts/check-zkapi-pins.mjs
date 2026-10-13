#!/usr/bin/env node
// Deployment-pin check before first use (docs/zkapi-integration-spec.md §3, plan §62). Read-only.
// For the network the assets were built for it checks:
//   1. the emitted browser-config.json is byte-identical to the SDK's pinned profile and its
//      deployment manifest URL is on the profile's own allow-list (no other host can be followed);
//   2. the emitted proving keys and WASM hash to the pinned values (the SDK's hashed asset manifest
//      and the trusted_deployment pins);
//   3. tools/zkapi-lab/verify-mainnet.mjs passes with zero failures: chain id, vault immutables
//      (signing keys, cap, adapter, TTL, challenge period, version, depth, native asset), the
//      vault's and adapter's runtime code against a forge build of the deployed commit, proving-key
//      hashes vs setup vs live manifest, the live manifest vs the pins vs chain, Chainlink feed
//      identity and freshness.
// It writes public/zkapi/pin-check.json; the wallet enables zkAPI features only when `fail` is 0.
// Usage: ZKAPI_NETWORK=sepolia|mainnet node scripts/check-zkapi-pins.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const network = process.env.ZKAPI_NETWORK ?? "sepolia";
const zkapi = process.env.ZKAPI_SDK_DIR ?? resolve(here, "../../../../zkapi"); // the pinned clone (docs/zkapi/mainnet-verification.md)
const pub = join(here, "..", "public", "zkapi");
const items = [];
const check = (name, ok, detail = "") => { items.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (!existsSync(join(pub, "browser-config.json"))) { console.error("no public/zkapi/browser-config.json — run scripts/build-zkapi-assets.mjs first"); process.exit(2); }
const cfg = JSON.parse(readFileSync(join(pub, "browser-config.json"), "utf8"));
const T = cfg.trusted_deployment;
const pinnedPath = join(zkapi, "sdk/assets/config", `${network}.json`);
check("emitted browser-config == SDK pinned profile", JSON.stringify(cfg) === JSON.stringify(JSON.parse(readFileSync(pinnedPath, "utf8"))), `${network}.json`);
check("built for the requested network", Number(T.chain_id) === (network === "mainnet" ? 1 : 11155111), `chain ${T.chain_id}`);
check("deployment manifest URL is allow-listed", Array.isArray(cfg.allowed_deployment_manifest_urls) && cfg.allowed_deployment_manifest_urls.includes(cfg.deployment_manifest_url), cfg.deployment_manifest_url);
check("manifest, protocol server and OpenRouter base are https", [cfg.deployment_manifest_url, T.protocol_server_url, T.openrouter_inference_base].every((u) => String(u).startsWith("https://")));
check("runtime key issuer must be OA's org key (no provider-side identity)", cfg.require_oa_key_source === true);
check("circuit pinned", T.circuit_id === "zkapi-v2-note-bound-v1", T.circuit_id);

const assetManifest = JSON.parse(readFileSync(join(zkapi, "sdk/assets/manifest.json"), "utf8")).files;
const emitted = { "proofs/request.pk": ["assets/proofs/request.pk", T.request_proving_key_sha256], "proofs/withdrawal.pk": ["assets/proofs/withdrawal.pk", T.withdrawal_proving_key_sha256], "wasm/zkapi_browser_bg.wasm": ["wasm/zkapi_browser_bg.wasm", null] };
for (const [out, [src, pin]] of Object.entries(emitted)) {
  const p = join(pub, out);
  if (!existsSync(p)) { check(`emitted ${out} present`, false); continue; }
  const h = sha256(p);
  check(`emitted ${out} == SDK asset manifest`, h === assetManifest[src], h.slice(0, 16) + "…");
  if (pin) check(`emitted ${out} == trusted_deployment pin`, h === pin);
}

// the chain / live-manifest / bytecode verification of the lab
const lab = resolve(here, "../../../tools/zkapi-lab/verify-mainnet.mjs");
const r = spawnSync(process.execPath, [lab, network], { encoding: "utf8", cwd: dirname(lab) });
const summary = (r.stdout.match(/^(mainnet|sepolia): (\d+) pass, (\d+) fail, (\d+) informational/m) ?? [null, network, "0", "99", "0"]);
const labPass = Number(summary[2]), labFail = Number(summary[3]);
process.stdout.write(r.stdout.split("\n").filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => "   lab " + l + "\n").join(""));
if (r.stderr) process.stderr.write(r.stderr.slice(0, 2000));
check("verify-mainnet.mjs: chain, vault immutables, bytecode, keys, live manifest, feed", r.status === 0 && labFail === 0, `${labPass} pass, ${labFail} fail`);

const fail = items.filter((i) => !i.ok).length;
const out = { network, checkedAt: new Date().toISOString(), pass: items.length - fail, fail, deploymentId: T.deployment_id, vault: T.contract_address, circuit: T.circuit_id, protocolServer: T.protocol_server_url, items, lab: { pass: labPass, fail: labFail } };
writeFileSync(join(pub, "pin-check.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${network}: ${out.pass} pass, ${fail} fail → public/zkapi/pin-check.json (zkAPI features ${fail ? "DISABLED" : "enabled"})`);
process.exit(fail ? 1 : 0);
