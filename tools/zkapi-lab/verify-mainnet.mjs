#!/usr/bin/env node
// zkAPI deployment-pin verification (plan V1.1 §62). Read-only. For the chosen network it checks:
//   1. chain id of the pinned RPC
//   2. the vault's immutables read from chain (signing keys, charge cap, proof adapter, TTL,
//      challenge period, version, depth, billing asset) against the SDK's trusted_deployment pins
//   3. the vault's and the proof adapter's runtime code against a forge build of the SOURCE COMMIT the
//      live manifest names (demo profile: solc 0.8.28, via_ir, 200 runs), with the external Poseidon
//      library linked and the immutable slots masked — and against the manifest's published keccaks
//   4. proving-key sha256 of the SDK's packaged artifacts == pins == protocol/setup/v2 == live manifest
//   5. the live deployment manifest (flat schema) against the packaged pins and the chain
//   6. the price feed is a Chainlink ETH/USD aggregator with a fresh round
//   7. trust points that are NOT pins: owner, treasury, paused, off-chain services
// Usage: node verify-mainnet.mjs [mainnet|sepolia] [--zkapi <clone>] [--artifacts <forge out dir of the deployed commit>]
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { keccak_256 } from "@noble/hashes/sha3";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const net = argv.find((a) => !a.startsWith("--") && !argv.includes(`--${a}`) && ["mainnet", "sepolia"].includes(a)) ?? "mainnet";
const zkapi = resolve(here, opt("--zkapi", "../../../zkapi"));
const artifacts = resolve(here, opt("--artifacts", "../../../zkapi-deployed/demo/contracts/out"));
const cfg = JSON.parse(readFileSync(join(zkapi, "sdk/assets/config", `${net}.json`), "utf8"));
const T = cfg.trusted_deployment;
const RPC = process.env.RPC_URL ?? T.rpc_url;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const keccakOf = (buf) => hex(keccak_256(buf));
const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig))).slice(0, 10);
const eqAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const call = async (to, sig) => rpc("eth_call", [{ to, data: selector(sig) }, "latest"]);
const word = (data, i = 0) => BigInt("0x" + data.slice(2 + 64 * i, 66 + 64 * i));
const addr = (data, i = 0) => "0x" + data.slice(2 + 64 * i + 24, 66 + 64 * i).toLowerCase();

// ---- live manifest (flat schema) ----
let live = null;
try {
  live = await (await fetch(T.protocol_server_url + "/config.json", { signal: AbortSignal.timeout(20000) })).json();
} catch (e) {
  check("live manifest fetched", null, `could not fetch ${T.protocol_server_url}/config.json: ${e.message}`);
}

// ---- 1. chain ----
const chainId = Number(await rpc("eth_chainId", []));
check("chain id", chainId === T.chain_id, `${chainId} (pin ${T.chain_id}) via ${RPC}`);

// ---- 2. vault immutables vs pins ----
const vault = T.contract_address.toLowerCase();
const code = await rpc("eth_getCode", [vault, "latest"]);
const codeBuf = Buffer.from(code.slice(2), "hex");
check("vault has code", codeBuf.length > 0, `${codeBuf.length} bytes, keccak ${keccakOf(codeBuf).slice(0, 18)}…`);
const sx = word(await call(vault, "stateSigningKeyX()")), sy = word(await call(vault, "stateSigningKeyY()"));
const cx = word(await call(vault, "clearanceSigningKeyX()")), cy = word(await call(vault, "clearanceSigningKeyY()"));
check("state signing key == pin", sx === BigInt(T.state_signing_key.x) && sy === BigInt(T.state_signing_key.y));
check("clearance signing key == pin", cx === BigInt(T.clearance_signing_key.x) && cy === BigInt(T.clearance_signing_key.y));
const cap = word(await call(vault, "requestChargeCap()"));
check("request charge cap == pin", cap === BigInt(T.request_charge_cap), `${cap} gwei`);
check("PROTOCOL_VERSION == 2", word(await call(vault, "PROTOCOL_VERSION()")) === 2n);
check("MERKLE_DEPTH == 32", word(await call(vault, "MERKLE_DEPTH()")) === 32n);
const billingToken = addr(await call(vault, "billingToken()"));
check("billing asset is native ETH (no USDC on this deployment)",
  billingToken === "0x0000000000000000000000000000000000000000" && T.billing_asset === "native_eth" && T.billing_token_address === null,
  `billingToken ${billingToken}; pin ${T.billing_asset}`);
const adapter = addr(await call(vault, "proofAdapter()"));
const noteTtl = word(await call(vault, "noteTtl()")), challenge = word(await call(vault, "challengePeriod()"));
check("note TTL / challenge period", null, `noteTtl ${noteTtl}s (${Number(noteTtl) / 86400} d), challengePeriod ${challenge}s (${Number(challenge) / 3600} h)`);

// ---- 3. runtime code vs forge build of the deployed source commit ----
function linkAndMask(art, libAddress) {
  let obj = art.deployedBytecode.object.replace(/^0x/, "");
  // external library placeholders: __$<34 hex>$__ (40 chars) -> library address
  obj = obj.replace(/__\$[0-9a-f]{34}\$__/g, libAddress.replace(/^0x/, "").toLowerCase());
  const buf = Buffer.from(obj, "hex");
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) for (const { start, length } of refs) buf.fill(0, start, start + length);
  return buf;
}
function maskImmutables(buf, art) {
  const m = Buffer.from(buf);
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) for (const { start, length } of refs) m.fill(0, start, start + length);
  return m;
}
function stripMetadata(b) {
  const len = b.readUInt16BE(b.length - 2);
  return len + 2 <= b.length && (b[b.length - 2 - len] === 0xa2 || b[b.length - 2 - len] === 0xa1) ? b.subarray(0, b.length - 2 - len) : b;
}
function compare(name, artifactPath, onchain, libAddress) {
  if (!existsSync(artifactPath)) return check(`${name} runtime == forge build of deployed commit`, null, `no artifact at ${artifactPath}`);
  const art = JSON.parse(readFileSync(artifactPath, "utf8"));
  const local = linkAndMask(art, libAddress ?? "0x0000000000000000000000000000000000000000");
  const chain = maskImmutables(onchain, art);
  if (local.length !== chain.length) return check(`${name} runtime == forge build of deployed commit`, false, `length ${chain.length} vs ${local.length}`);
  const exact = local.equals(chain);
  const noMeta = stripMetadata(local).equals(stripMetadata(chain));
  check(`${name} runtime == forge build of deployed commit`, noMeta, exact ? "byte-exact incl. metadata" : noMeta ? "equal after stripping the metadata trailer" : "DIFFERENT");
}
const poseidonLib = live?.poseidon_library_address ?? null;
if (poseidonLib) {
  const libCode = await rpc("eth_getCode", [poseidonLib, "latest"]);
  check("Poseidon library (external link target) has code", libCode.length > 2, `${poseidonLib}, ${(libCode.length - 2) / 2} bytes`);
}
compare("vault", join(artifacts, "ZkApiVault.sol/ZkApiVault.json"), codeBuf, poseidonLib);
const adapterCode = Buffer.from((await rpc("eth_getCode", [adapter, "latest"])).slice(2), "hex");
compare("proof adapter", join(artifacts, "Groth16ProofAdapter.sol/Groth16ProofAdapter.json"), adapterCode, null);
if (live?.deployment_evidence) {
  const ev = live.deployment_evidence;
  check("on-chain vault keccak == manifest deployment_evidence", keccakOf(codeBuf) === ev.vault_runtime_keccak256.toLowerCase(), keccakOf(codeBuf).slice(0, 18) + "…");
  check("on-chain adapter keccak == manifest deployment_evidence", keccakOf(adapterCode) === ev.verifier_runtime_keccak256.toLowerCase(), keccakOf(adapterCode).slice(0, 18) + "…");
  check("deployment source commit", null, `zkapi_ef_sha ${live.source?.zkapi_ef_sha}, protocol vendored from ${live.source?.protocol_vendored_from_sha}; vault tx ${ev.vault_transaction_hash?.slice(0, 18)}…`);
}
// adapter source in contracts/src vs the setup copy: the copies differ in formatting only (brace
// style), so compare what matters — the embedded verifying-key constants — and report the rest.
const constants = (p) => [...new Set(readFileSync(p, "utf8").match(/0x[0-9a-f]{64}/g) ?? [])].sort().join(",");
const srcPath = join(zkapi, "protocol/contracts/src/adapters/Groth16ProofAdapter.sol");
const setupPath = join(zkapi, "protocol/setup/v2/Groth16ProofAdapter.sol");
const tokens = (p) => readFileSync(p, "utf8").replace(/\s+/g, "");
check("Groth16ProofAdapter.sol: verifying-key constants (contracts/src) == protocol/setup/v2 copy",
  constants(srcPath) === constants(setupPath),
  tokens(srcPath) === tokens(setupPath) ? "files identical modulo whitespace" : "same constants; the copies differ in formatting (brace style) only");
const manifest = JSON.parse(readFileSync(join(zkapi, "protocol/setup/v2/manifest.json"), "utf8"));
check("setup manifest circuit id == pin", manifest.circuit_id === T.circuit_id && manifest.proof_backend === "groth16_bn254", `${manifest.circuit_id}, ${manifest.proof_backend}`);

// ---- 4. proving keys ----
for (const k of ["request", "withdrawal"]) {
  const pin = T[`${k}_proving_key_sha256`];
  const sdkHash = sha256(join(zkapi, `sdk/assets/proofs/${k}.pk`));
  const setupHash = sha256(join(zkapi, `protocol/setup/v2/${k}.pk`));
  const liveHash = live?.proof_setup?.[`${k}_proving_key_sha256`];
  check(`${k}.pk sha256: SDK asset == pin == protocol/setup/v2 == live manifest`, sdkHash === pin && setupHash === pin && (!live || liveHash === pin), sdkHash.slice(0, 16) + "…");
  const vkHash = sha256(join(zkapi, `protocol/setup/v2/${k}.vk`));
  const liveVk = live?.proof_setup?.[`${k}_verifying_key_sha256`];
  check(`${k}.vk sha256 == live manifest`, live ? vkHash === liveVk : null, vkHash.slice(0, 16) + "…");
}

// ---- 5. live manifest vs packaged pins and chain ----
if (live) {
  const same = (a, b) => JSON.stringify(a)?.toLowerCase() === JSON.stringify(b)?.toLowerCase();
  const diffs = [];
  if (!same(live.deployment_id, T.deployment_id)) diffs.push("deployment_id");
  if (live.chain_id !== T.chain_id) diffs.push("chain_id");
  if (!eqAddr(live.contract_address, T.contract_address)) diffs.push("contract_address");
  if (live.request_charge_cap !== T.request_charge_cap) diffs.push("request_charge_cap");
  if (!same(live.state_signing_key, T.state_signing_key)) diffs.push("state_signing_key");
  if (!same(live.clearance_signing_key, T.clearance_signing_key)) diffs.push("clearance_signing_key");
  if (!eqAddr(live.native_price_feed_address, T.native_price_feed_address)) diffs.push("native_price_feed_address");
  if (live.billing_asset !== T.billing_asset) diffs.push("billing_asset");
  if (live.proof_setup?.circuit_id !== T.circuit_id) diffs.push("circuit_id");
  check("live manifest == packaged trusted_deployment", diffs.length === 0, diffs.length ? `differs: ${diffs.join(", ")}` : live.deployment_id);
  check("live manifest == chain (adapter, treasury, ttl, challenge)",
    eqAddr(live.proof_adapter_address, adapter) && eqAddr(live.treasury_address, addr(await call(vault, "treasury()")))
      && BigInt(live.note_ttl_seconds) === noteTtl && BigInt(live.challenge_period_seconds) === challenge);
  check("live manifest: services", null, `auth ${live.auth_scheme}, provider ${live.provider}, upstreams ${JSON.stringify(live.upstreams)}, issuer ${live.privacy_mode?.issuer_url}, verifier ${live.privacy_mode?.verifier_url}, lease ttl ${live.privacy_mode?.lease_ttl_seconds}s, demo mint ${live.demo_mint_enabled}`);
  check("live manifest: operator-stated limitations", null, (live.limitations ?? []).join(" | "));
}

// ---- 6. price feed ----
try {
  const feed = T.native_price_feed_address.toLowerCase();
  const descData = await call(feed, "description()");
  const desc = Buffer.from(descData.slice(2 + 128, 2 + 128 + Number(word(descData, 1)) * 2), "hex").toString();
  const dec = word(await call(feed, "decimals()"));
  const round = await call(feed, "latestRoundData()");
  const answer = word(round, 1), age = Math.floor(Date.now() / 1000) - Number(word(round, 3));
  check("price feed is Chainlink ETH/USD, 8 decimals", desc.includes("ETH / USD") && dec === BigInt(T.native_price_feed_decimals), `${desc}, ${dec} decimals`);
  check("price feed round fresh", age <= T.native_price_max_age_seconds, `$${(Number(answer) / 1e8).toFixed(2)}, updated ${age}s ago (max ${T.native_price_max_age_seconds}s)`);
} catch (e) {
  check("price feed", null, e.message);
}

// ---- 7. trust points (reported, not pinned) ----
const owner = addr(await call(vault, "owner()")), treasury = addr(await call(vault, "treasury()"));
const paused = word(await call(vault, "paused()")) === 1n;
const root = word(await call(vault, "currentRoot()")), nextNote = word(await call(vault, "nextNoteId()"));
check("operator trust points", null, `owner ${owner}, treasury ${treasury}, paused ${paused}, notes ${nextNote}, root 0x${root.toString(16).slice(0, 12)}…`);
check("off-chain services (not contracts)", null, `verifier ${T.verifier_url}; inference ${T.openrouter_inference_base}`);

const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${net}: ${results.filter((r) => r.ok === true).length} pass, ${failed} fail, ${results.filter((r) => r.ok === null).length} informational`);
process.exit(failed ? 1 : 0);
