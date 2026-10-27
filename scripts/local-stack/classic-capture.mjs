// classic-capture.mjs — the mainnet state the local stack places for Tornado Classic (V7 Stage 10; spec v3.0 §7.9): what
// the Sourcify records under classic/contracts/verified/ do not hold — the MiMC Hasher library's runtime code (a
// circomlib-generated contract with no Solidity source) and the two registries' storage behind their proxies (the
// EIP-1967 implementation and admin slots, the first slots of each — the initializer flags, the router, the minimum
// stake — and the instance records of the four ETH pools) — read from a public RPC and written to
// mainnet/classic-state.json, which is committed. The Solidity contracts' runtime code comes from the records
// (Sourcify's onchainBytecode) and is held to the Classic app's pins when deploy.mjs places it. Read-only; run again to
// refresh (the block it read at is recorded).
//
//   node classic-capture.mjs                 RPC_URL=https://ethereum-rpc.publicnode.com by default
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PP_ROOT ?? resolve(HERE, "../..");
const RPC_URL = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const OUT = join(HERE, "mainnet", "classic-state.json");

const pins = JSON.parse(readFileSync(join(ROOT, "classic/src/config/deployment.json"), "utf8"));
const record = (name) => JSON.parse(readFileSync(join(ROOT, "classic/contracts/verified", `${name}.json`), "utf8"));

const rpc = async (method, params) => {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (n) => `0x${pad32(BigInt(n).toString(16))}`;
// the pins hash the code bytes (classic/scripts/deployment.mjs sha256Hex)
const sha256 = (hex) => createHash("sha256").update(Buffer.from(hex.replace(/^0x/, ""), "hex")).digest("hex");
const addressOf = (word32) => `0x${word32.slice(-40)}`;

// the EIP-1967 slots (OpenZeppelin's TransparentUpgradeableProxy, which AdminUpgradeableProxy extends)
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// InstanceRegistry (0.6.12, Initializable + EnsResolve): slot 0 = _initialized | _initializing | router (packed),
// slot 1 = instances mapping, slot 2 = instanceIds. RelayerRegistry: slot 0 = _initialized | _initializing | tornadoRouter,
// slot 1 = minStakeAmount, slots 2 and 3 the relayers and workers mappings (empty on the devnet: nobody is registered).
const INSTANCES_SLOT = 1n;

const block = await rpc("eth_blockNumber", []);
const at = (method, params) => rpc(method, [...params, block]);
console.log(`${RPC_URL} at block ${Number.parseInt(block, 16)}`);

// 1. the Hasher: the address every pool record links (the same library for all four)
const hasherAddress = Object.values(pins.pools)[0].libraries["TornadoCash_eth.sol:Hasher"] ?? Object.values(Object.values(pins.pools)[0].libraries)[0];
for (const [id, pool] of Object.entries(pins.pools)) {
  const linked = Object.values(pool.libraries)[0];
  if (linked.toLowerCase() !== hasherAddress.toLowerCase()) throw new Error(`${id} links another Hasher: ${linked}`);
}
const hasherCode = await at("eth_getCode", [hasherAddress]);
if (hasherCode.length <= 2) throw new Error("no code at the Hasher's address");
console.log(`Hasher ${hasherAddress}: ${(hasherCode.length - 2) / 2} bytes`);

// 2. the records' code is the chain's (the pins hash the lowercase hex; so does the Classic app at start)
const checks = [
  ...Object.entries(pins.pools).map(([id, p]) => ({ name: `pool ${id}`, file: `pool-${id}`, address: p.address, sha256: p.runtime.sha256 })),
  { name: "verifier", file: "verifier", address: pins.verifier.address, sha256: pins.verifier.runtime.sha256 },
  { name: "router", file: "router", address: pins.router.address },
  { name: "instance registry (proxy)", file: "instance-registry-proxy", address: pins.router.instanceRegistry },
  { name: "relayer registry (proxy)", file: "relayer-registry-proxy", address: pins.router.relayerRegistry },
];
for (const c of checks) {
  const rec = record(c.file);
  if (rec.address.toLowerCase() !== c.address.toLowerCase()) throw new Error(`${c.name}: the record is for ${rec.address}, the pins say ${c.address}`);
  const live = (await at("eth_getCode", [c.address])).toLowerCase();
  if (live !== rec.runtimeBytecode.onchainBytecode.toLowerCase()) throw new Error(`${c.name}: the record's onchainBytecode is not the chain's code now`);
  if (c.sha256 && sha256(live) !== c.sha256) throw new Error(`${c.name}: the chain's code does not hash to the pin`);
  console.log(`${c.name.padEnd(26)} ${c.address}  ${(live.length - 2) / 2} bytes = the record${c.sha256 ? " = the pin" : ""}`);
}

// 3. the registries' storage behind the proxies
async function proxyState(name, address, implementationFile, dataSlots) {
  const implementation = addressOf(await at("eth_getStorageAt", [address, IMPLEMENTATION_SLOT]));
  const admin = addressOf(await at("eth_getStorageAt", [address, ADMIN_SLOT]));
  const rec = record(implementationFile);
  if (rec.address.toLowerCase() !== implementation) throw new Error(`${name}: the implementation is ${implementation}, the record ${rec.address}`);
  const implCode = (await at("eth_getCode", [implementation])).toLowerCase();
  if (implCode !== rec.runtimeBytecode.onchainBytecode.toLowerCase()) throw new Error(`${name}: the implementation record's code is not the chain's`);
  const slots = {};
  for (const slot of [IMPLEMENTATION_SLOT, ADMIN_SLOT, ...dataSlots.map(word)]) slots[slot] = await at("eth_getStorageAt", [address, slot]);
  console.log(`${name.padEnd(26)} implementation ${implementation} (${(implCode.length - 2) / 2} bytes = the record), admin ${admin}, ${Object.keys(slots).length} slots`);
  return { address: address.toLowerCase(), implementation, admin, slots };
}
const instanceRegistry = await proxyState("instance registry", pins.router.instanceRegistry, "instance-registry-implementation", [0, 1, 2]);
const relayerRegistry = await proxyState("relayer registry", pins.router.relayerRegistry, "relayer-registry-implementation", [0, 1]);

// the four pools' instance records: instances[pool] at keccak256(pool ‖ slot 1); decoded against the registry's own answer
const sel = (signature) => keccak256(new TextEncoder().encode(signature)).slice(0, 10);
instanceRegistry.instances = {};
for (const [id, pool] of Object.entries(pins.pools)) {
  const slot = keccak256(`0x${pad32(pool.address)}${pad32(INSTANCES_SLOT.toString(16))}`);
  const value = await at("eth_getStorageAt", [pins.router.instanceRegistry, slot]);
  const answer = await at("eth_call", [{ to: pins.router.instanceRegistry, data: sel("instances(address)") + pad32(pool.address) }]);
  const words = answer.slice(2).match(/.{64}/g).map((w) => BigInt(`0x${w}`));
  const v = BigInt(value);
  const state = Number((v >> 168n) & 0xffn); // byte 21: after isERC20 (1 byte) and token (20 bytes)
  const protocolFeePercentage = Number((v >> 200n) & 0xffffffffn); // bytes 25–28: after uniswapPoolSwappingFee (3 bytes)
  if (BigInt(state) !== words[2] || BigInt(protocolFeePercentage) !== words[4] || words[0] !== 0n) throw new Error(`${id}: the storage slot does not decode to the registry's answer`);
  if (state !== 1) throw new Error(`${id}: the instance is not ENABLED on mainnet now (state ${state})`);
  instanceRegistry.instances[id] = { pool: pool.address.toLowerCase(), slot, value, state, protocolFeePercentage };
  console.log(`${("instances[" + id + "]").padEnd(26)} state ${state} (ENABLED), protocol fee ${protocolFeePercentage} / 10,000`);
}
const routerInRegistry = addressOf(instanceRegistry.slots[word(0)].slice(0, 2 + 64 - 4)); // the address sits above the two bools
if (routerInRegistry.toLowerCase() !== pins.router.address.toLowerCase()) throw new Error(`the instance registry's router is ${routerInRegistry}, the pins say ${pins.router.address}`);
const routerInRelayerRegistry = addressOf(relayerRegistry.slots[word(0)].slice(0, 2 + 64 - 4));
if (routerInRelayerRegistry.toLowerCase() !== pins.router.address.toLowerCase()) throw new Error(`the relayer registry's router is ${routerInRelayerRegistry}`);

const out = {
  comment:
    "The mainnet state scripts/local-stack/deploy.mjs places for Tornado Classic beside the Sourcify records (V7 Stage 10): the MiMC Hasher library's runtime code, and the two registries' storage behind their proxies — the EIP-1967 implementation and admin slots, the initializer flags with the router, the minimum stake, and the instance records of the four ETH pools (ENABLED, the protocol fee). Written by classic-capture.mjs from a public RPC; read-only. The pools, the verifier, the router and the proxies take their code from classic/contracts/verified/*.json.",
  readAt: { block: Number.parseInt(block, 16), date: new Date().toISOString(), endpoint: RPC_URL },
  hasher: { address: hasherAddress.toLowerCase(), bytes: (hasherCode.length - 2) / 2, sha256: sha256(hasherCode.toLowerCase()), code: hasherCode.toLowerCase() },
  slots: { implementation: IMPLEMENTATION_SLOT, admin: ADMIN_SLOT, instancesMapping: Number(INSTANCES_SLOT) },
  instanceRegistry,
  relayerRegistry,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\n${OUT} written (${(hasherCode.length - 2) / 2} bytes of Hasher code, ${Object.keys(instanceRegistry.slots).length + Object.keys(relayerRegistry.slots).length + 4} storage slots)`);
