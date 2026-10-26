// The Classic deployment's verification (spec v3.0 §7.2; V7 Stage 5), pure wherever it can be: the cached Sourcify
// records (contracts/verified/*.json: the sources, the compiler settings, the runtime bytecode Sourcify saw on chain and
// the one it recompiled, its transformations) against the chain's runtime code and against a rebuild with the pinned
// compilers (compilers.mjs), compared modulo Sourcify's transformations — the linked Hasher library's address, the
// metadata hash at the tail, the router's immutables —; the pools' facts through eth_call (verifier, levels,
// denomination, operator, ROOT_HISTORY_SIZE, nextIndex, the last root); the router's governance and registries; the
// registries behind their EIP-1967 proxies (implementation and admin from the storage slots); the verifier's key
// constants read from its source. verify-deployment.mjs is the command; the offline and the live suites call these.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "js-sha3";

const here = fileURLToPath(new URL(".", import.meta.url));
export const VERIFIED_DIR = join(here, "..", "contracts", "verified");
export const PINS_FILE = join(here, "..", "src", "config", "deployment.json");

/** Ethereum mainnet: the only chain the pools exist on. */
export const CHAIN_ID = 1;
/** The public endpoints a verification reads when none is named (CLASSIC_RPC_URLS). */
export const PUBLIC_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

/** What the records describe, by the name the app uses. */
export const CONTRACTS = Object.freeze({
  "eth-0.1": { record: "pool-eth-0.1", address: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc", kind: "pool", amount: "0.1" },
  "eth-1": { record: "pool-eth-1", address: "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936", kind: "pool", amount: "1" },
  "eth-10": { record: "pool-eth-10", address: "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", kind: "pool", amount: "10" },
  "eth-100": { record: "pool-eth-100", address: "0xa160cdab225685da1d56aa342ad8841c3b53f291", kind: "pool", amount: "100" },
  verifier: { record: "verifier", address: "0xce172ce1f20ec0b3728c9965470eaf994a03557a", kind: "verifier" },
  router: { record: "router", address: "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", kind: "router" },
  instanceRegistry: { record: "instance-registry-proxy", address: "0xb20c66c4de72433f3ce747b58b86830c459ca911", kind: "proxy" },
  relayerRegistry: { record: "relayer-registry-proxy", address: "0x58e8dcc13be9780fc42e8723d8ead4cf46943df2", kind: "proxy" },
});
export const POOL_IDS = Object.freeze(["eth-0.1", "eth-1", "eth-10", "eth-100"]);

// ---- hex and hashing ---------------------------------------------------------------------------------------------------
export const strip0x = (h) => (h.startsWith("0x") ? h.slice(2) : h);
export const sha256Hex = (hex) =>
  createHash("sha256")
    .update(Buffer.from(strip0x(hex), "hex"))
    .digest("hex");
export const byteLength = (hex) => strip0x(hex).length / 2;
export const sameHex = (a, b) => strip0x(a).toLowerCase() === strip0x(b).toLowerCase();

// ---- the ABI, by hand (the few view calls this needs: no arguments, or one address) ---------------------------------------
export const selector = (signature) => "0x" + keccak256(signature).slice(0, 8);
export const encodeAddress = (address) => strip0x(address).toLowerCase().padStart(64, "0");
export const callData = (signature, address) => selector(signature) + (address ? encodeAddress(address) : "");
export const words = (hex) => {
  const h = strip0x(hex);
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
};
export const wordAddress = (w) => "0x" + w.slice(24).toLowerCase();
export const wordBigInt = (w) => BigInt("0x" + w);
export const wordNumber = (w) => Number(wordBigInt(w));

// ---- the records -------------------------------------------------------------------------------------------------------
export function readRecord(name, dir = VERIFIED_DIR) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`no verified record ${name} under contracts/verified`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The bytes a transformation covers: a linked library address (20), the metadata hash as Sourcify saw it, an immutable (32). */
export function transformationLength(t, cborAuxdata = {}) {
  if (t.reason === "library") return 20;
  if (t.reason === "immutable") return 32;
  if (t.reason === "cborAuxdata") return byteLength(cborAuxdata[t.id]?.value ?? "0x");
  if (t.reason === "callProtection") return 20;
  return 0;
}

/** A rebuild's unlinked library placeholders (`__$<34 hex>$__` since solc 0.5, `__Name____` before) as twenty zero bytes. */
export const unlinked = (hex) =>
  strip0x(hex)
    .replace(/__\$[0-9a-fA-F]{34}\$__/g, "0".repeat(40))
    .replace(/__[A-Za-z0-9_.:$-]{36}__/g, "0".repeat(40));

/** The runtime bytecode with every transformation's range zeroed: what a rebuild and the chain must share. */
export function blankTransformations(hex, transformations = [], cborAuxdata = {}) {
  const bytes = Buffer.from(unlinked(hex), "hex");
  if (bytes.length * 2 !== unlinked(hex).length) throw new Error("the bytecode is not hex");
  for (const t of transformations) bytes.fill(0, t.offset, t.offset + transformationLength(t, cborAuxdata));
  return "0x" + bytes.toString("hex");
}

/** The values the chain holds where a record's transformations sit: the linked library addresses, the metadata hash. */
export function transformationValues(onchainHex, transformations = [], cborAuxdata = {}) {
  const bytes = Buffer.from(unlinked(onchainHex), "hex");
  const libraries = {};
  const auxdata = {};
  const immutables = {};
  for (const t of transformations) {
    const slice = "0x" + bytes.subarray(t.offset, t.offset + transformationLength(t, cborAuxdata)).toString("hex");
    if (t.reason === "library") (libraries[t.id] ??= new Set()).add(slice);
    else if (t.reason === "cborAuxdata") auxdata[t.id] = slice;
    else if (t.reason === "immutable") (immutables[t.id] ??= new Set()).add(slice);
  }
  const one = (sets) => Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v]]));
  return { libraries: one(libraries), auxdata, immutables: one(immutables) };
}

/**
 * The chain's runtime code against a record: byte for byte what Sourcify saw (the contract has not changed), equal to
 * the recompiled bytecode modulo the transformations, the linked library the same at every link site, the metadata hash
 * the record's. `rebuilt` (a bytecode this machine compiled) is held to the same comparison when given.
 * @param {any} record a verified record (contracts/verified)
 * @param {string} onchainHex the runtime code read from the chain
 * @param {string | null} [rebuiltHex] the deployed bytecode a rebuild produced
 */
export function compareRuntime(record, onchainHex, rebuiltHex = null) {
  const rb = record.runtimeBytecode;
  const problems = [];
  const sameAsSourcify = sameHex(onchainHex, rb.onchainBytecode);
  if (!sameAsSourcify) problems.push("the chain's runtime code is not the one Sourcify verified");
  const blankedChain = blankTransformations(onchainHex, rb.transformations, rb.cborAuxdata);
  const blankedRecompiled = blankTransformations(rb.recompiledBytecode, rb.transformations, rb.cborAuxdata);
  const matchesRecompiled = sameHex(blankedChain, blankedRecompiled);
  if (!matchesRecompiled) problems.push("the chain's runtime code differs from Sourcify's recompilation beyond the transformations");
  let matchesRebuilt = null;
  if (rebuiltHex !== null) {
    matchesRebuilt =
      sameHex(blankedChain, blankTransformations(rebuiltHex, rb.transformations, rb.cborAuxdata)) && byteLength(rebuiltHex) === byteLength(onchainHex);
    if (!matchesRebuilt) problems.push("the rebuild with the pinned compiler differs from the chain beyond the transformations");
  }
  const values = transformationValues(onchainHex, rb.transformations, rb.cborAuxdata);
  for (const [id, addrs] of Object.entries(values.libraries))
    if (addrs.length !== 1) problems.push(`the library ${id} links to ${addrs.length} different addresses`);
  // the metadata hash at the tail: an exact match reproduces it; a "match" (the sources equal, the metadata not — a
  // file named differently when the original was compiled) differs there by definition, and the chain's value is recorded
  const exact = record.match === "exact_match";
  const metadataMatches = Object.entries(values.auxdata).every(([id, aux]) => sameHex(aux, rb.cborAuxdata?.[id]?.value ?? "0x"));
  if (exact && !metadataMatches) problems.push("the metadata hash is not the exact match's");
  return {
    ok: problems.length === 0,
    problems,
    sameAsSourcify,
    matchesRecompiled,
    matchesRebuilt,
    metadataMatches,
    bytes: byteLength(onchainHex),
    sha256: sha256Hex(onchainHex),
    libraries: Object.fromEntries(Object.entries(values.libraries).map(([k, v]) => [k, v[0]])),
    immutables: Object.fromEntries(Object.entries(values.immutables).map(([k, v]) => [k, v[0]])),
    metadata: values.auxdata,
  };
}

/** The standard JSON input that rebuilds a record: its sources and its metadata's settings, the deployed bytecode asked for. */
export function standardJsonOf(record) {
  const settings = { ...(record.metadataSettings ?? record.compilation.compilerSettings ?? {}) };
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["evm.deployedBytecode.object"] } };
  return { language: "Solidity", sources: Object.fromEntries(Object.entries(record.sources).map(([f, content]) => [f, { content }])), settings };
}

/** Compiles a record with its compiler (compilers.mjs' wrapper); the deployed bytecode of the compilation target. */
export function rebuildRecord(record, compiler) {
  const input = standardJsonOf(record);
  const output = JSON.parse(compiler.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(`the rebuild failed: ${errors.map((e) => e.formattedMessage ?? e.message).join("\n")}`);
  const [file, name] = record.compilation.fullyQualifiedName.split(":");
  const object = output.contracts?.[file]?.[name]?.evm?.deployedBytecode?.object;
  if (!object) throw new Error(`the rebuild produced no deployed bytecode for ${record.compilation.fullyQualifiedName}`);
  return "0x" + object;
}

// ---- the verifier's key, from its source -----------------------------------------------------------------------------------
const num = (s) => BigInt(s.trim());
/** vk.alfa1, vk.beta2, vk.gamma2, vk.delta2 and the IC points of circom's Groth16 Verifier.sol, as decimal strings. */
export function parseVerifyingKey(source) {
  const g1 = (name) => {
    const m = new RegExp(`vk\\.${name}\\s*=\\s*Pairing\\.G1Point\\(\\s*uint256\\(([^)]+)\\)\\s*,\\s*uint256\\(([^)]+)\\)\\s*\\)`).exec(source);
    if (!m) throw new Error(`Verifier.sol: no vk.${name}`);
    return [num(m[1]).toString(), num(m[2]).toString()];
  };
  const g2 = (name) => {
    const m = new RegExp(
      `vk\\.${name}\\s*=\\s*Pairing\\.G2Point\\(\\s*\\[\\s*uint256\\(([^)]+)\\)\\s*,\\s*uint256\\(([^)]+)\\)\\s*\\]\\s*,\\s*\\[\\s*uint256\\(([^)]+)\\)\\s*,\\s*uint256\\(([^)]+)\\)\\s*\\]\\s*\\)`,
    ).exec(source);
    if (!m) throw new Error(`Verifier.sol: no vk.${name}`);
    return [
      [num(m[1]).toString(), num(m[2]).toString()],
      [num(m[3]).toString(), num(m[4]).toString()],
    ];
  };
  const alfa1 = g1("alfa1");
  const beta2 = g2("beta2");
  const gamma2 = g2("gamma2");
  const delta2 = g2("delta2");
  const ic = [];
  const re = /vk\.IC\[(\d+)\]\s*=\s*Pairing\.G1Point\(\s*uint256\(([^)]+)\)\s*,\s*uint256\(([^)]+)\)\s*\)/g;
  for (let m; (m = re.exec(source));) ic[Number(m[1])] = [num(m[2]).toString(), num(m[3]).toString()];
  if (!ic.length || ic.some((p) => !p)) throw new Error("Verifier.sol: the IC points are incomplete");
  return { alfa1, beta2, gamma2, delta2, IC: ic, nPublic: ic.length - 1 };
}

// ---- the chain -------------------------------------------------------------------------------------------------------
/** A JSON-RPC reader over one URL (20 s per call), or the first of several that answers. */
export function makeRpc(urls, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let id = 0;
  return async function rpc(method, params = []) {
    let last = null;
    for (const url of list) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(`${url}: ${method} ${JSON.stringify(j.error)}`);
        return j.result;
      } catch (e) {
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw last ?? new Error("no RPC endpoint");
  };
}

export const EIP1967 = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
});

const call = async (rpc, to, signature, arg) => rpc("eth_call", [{ to, data: callData(signature, arg) }, "latest"]);

/** A pool's facts (the deployment-era ETHTornado's views). */
export async function readPool(rpc, address) {
  const [verifier, levels, denomination, operator, rootHistorySize, nextIndex, lastRoot] = await Promise.all(
    ["verifier()", "levels()", "denomination()", "operator()", "ROOT_HISTORY_SIZE()", "nextIndex()", "getLastRoot()"].map((s) => call(rpc, address, s)),
  );
  return {
    verifier: wordAddress(words(verifier)[0]),
    levels: wordNumber(words(levels)[0]),
    denominationWei: wordBigInt(words(denomination)[0]).toString(),
    operator: wordAddress(words(operator)[0]),
    rootHistorySize: wordNumber(words(rootHistorySize)[0]),
    nextIndex: wordNumber(words(nextIndex)[0]),
    lastRoot: "0x" + words(lastRoot)[0],
  };
}

/** The router's roles. */
export async function readRouter(rpc, address) {
  const [governance, instanceRegistry, relayerRegistry] = await Promise.all(
    ["governance()", "instanceRegistry()", "relayerRegistry()"].map((s) => call(rpc, address, s)),
  );
  return {
    governance: wordAddress(words(governance)[0]),
    instanceRegistry: wordAddress(words(instanceRegistry)[0]),
    relayerRegistry: wordAddress(words(relayerRegistry)[0]),
  };
}

/** An EIP-1967 proxy's implementation and admin, from the storage slots (the proxy answers implementation() to its admin alone). */
export async function readProxy(rpc, address) {
  const [impl, admin] = await Promise.all([
    rpc("eth_getStorageAt", [address, EIP1967.implementation, "latest"]),
    rpc("eth_getStorageAt", [address, EIP1967.admin, "latest"]),
  ]);
  return { implementation: wordAddress(strip0x(impl).padStart(64, "0")), admin: wordAddress(strip0x(admin).padStart(64, "0")) };
}

export const INSTANCE_STATE = Object.freeze(["DISABLED", "ENABLED", "MINEABLE"]);
/** instances(pool) of the InstanceRegistry: { isERC20, token, state, uniswapPoolSwappingFee, protocolFeePercentage }. */
export async function readInstance(rpc, registry, pool) {
  const w = words(await call(rpc, registry, "instances(address)", pool));
  if (w.length < 5) throw new Error(`instances(${pool}) answered ${w.length} words`);
  const state = wordNumber(w[2]);
  return {
    isERC20: wordNumber(w[0]) === 1,
    token: wordAddress(w[1]),
    state,
    stateName: INSTANCE_STATE[state] ?? `state ${state}`,
    uniswapPoolSwappingFee: wordNumber(w[3]),
    /** in hundredths of a percent (30 = 0.30 %) */
    protocolFeePercentage: wordNumber(w[4]),
  };
}

/** The runtime code at an address: its sha256 and size, and the bytes. */
export async function readCode(rpc, address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  return { hex: code, bytes: byteLength(code), sha256: sha256Hex(code) };
}

// ---- the pins -------------------------------------------------------------------------------------------------------------
export function readPins(file = PINS_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/**
 * The verification: every contract's code against its record (and, with `rebuild`, against a rebuild with the pinned
 * compiler), the pools' and the router's facts, the registries' proxies and instances, the verifier's key; `pins`, when
 * given, is what each fact must still equal (the live test's drift check). Returns the rows and the pins this run would write.
 */
/**
 * @typedef {{ bytecode: string, compiler: string } | null} Rebuilt
 * @param {{ rpc: (method: string, params?: unknown[]) => Promise<any>, records?: (name: string) => any, rebuild?: null | ((record: any) => Promise<Rebuilt>), pins?: any, now?: () => Date }} [options]
 */
export async function verifyDeployment({ rpc, records = (name) => readRecord(name), rebuild = null, pins = null, now = () => new Date() } = {}) {
  const chainId = parseInt(await rpc("eth_chainId"), 16);
  const block = parseInt(await rpc("eth_blockNumber"), 16);
  const rows = [];
  const row = (name, ok, detail, extra = {}) => rows.push({ name, ok, detail, ...extra });
  row("chain", chainId === CHAIN_ID, `chain id ${chainId} at block ${block}`);
  const out = {
    chainId,
    readAt: { block, date: now().toISOString().slice(0, 10) },
    pools: {},
    verifier: null,
    router: null,
    instanceRegistry: null,
    relayerRegistry: null,
    compilers: {},
  };

  const codes = {};
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const record = records(c.record);
    const code = await readCode(rpc, c.address);
    codes[name] = code;
    let rebuiltHex = null;
    let rebuiltWith = null;
    if (rebuild) {
      const built = await rebuild(record);
      if (built) {
        rebuiltHex = built.bytecode;
        rebuiltWith = built.compiler;
      }
    }
    const cmp = compareRuntime(record, code.hex, rebuiltHex);
    row(
      `${name}: runtime code`,
      cmp.ok,
      `${cmp.bytes} B, sha256 ${cmp.sha256.slice(0, 16)}…; Sourcify ${record.match} (${record.compilation.compilerVersion}); recompiled ${cmp.matchesRecompiled ? "matches" : "differs"} modulo the transformations${rebuiltHex ? `; rebuilt here with ${rebuiltWith}: ${cmp.matchesRebuilt ? "matches" : "DIFFERS"}` : "; not rebuilt here"}${Object.keys(cmp.libraries).length ? `; libraries ${JSON.stringify(cmp.libraries)}` : ""}`,
      { problems: cmp.problems },
    );
    const pinned = {
      address: c.address,
      runtime: { sha256: cmp.sha256, bytes: cmp.bytes },
      source: { name: record.compilation.name, compiler: record.compilation.compilerVersion, sourcify: record.match, matchId: record.matchId },
      deployedBlock: Number(record.deployment?.blockNumber ?? 0),
      libraries: cmp.libraries,
    };
    if (c.kind === "pool") out.pools[name] = { ...pinned, amount: c.amount };
    else out[name] = pinned;
    out.compilers[record.compilation.compilerVersion] = true;
  }

  for (const id of POOL_IDS) {
    const facts = await readPool(rpc, CONTRACTS[id].address);
    const p = out.pools[id];
    Object.assign(p, facts);
    const expectedWei = (BigInt(Math.round(Number(CONTRACTS[id].amount) * 10)) * 10n ** 17n).toString();
    row(`${id}: verifier`, facts.verifier === CONTRACTS.verifier.address, `verifier() = ${facts.verifier}`);
    row(`${id}: levels`, facts.levels === 20, `levels() = ${facts.levels}`);
    row(`${id}: denomination`, facts.denominationWei === expectedWei, `denomination() = ${facts.denominationWei} wei (${CONTRACTS[id].amount} ETH)`);
    row(`${id}: operator`, facts.operator === "0x0000000000000000000000000000000000000000", `operator() = ${facts.operator} (renounced: immutable)`);
    row(`${id}: ROOT_HISTORY_SIZE`, facts.rootHistorySize === 100, `ROOT_HISTORY_SIZE() = ${facts.rootHistorySize}`);
    row(`${id}: deposits`, facts.nextIndex > 0, `nextIndex() = ${facts.nextIndex}, last root ${facts.lastRoot.slice(0, 18)}…`);
  }

  const router = await readRouter(rpc, CONTRACTS.router.address);
  Object.assign(out.router, router);
  row(
    "router: registries",
    router.instanceRegistry === CONTRACTS.instanceRegistry.address && router.relayerRegistry === CONTRACTS.relayerRegistry.address,
    `governance ${router.governance}; instanceRegistry ${router.instanceRegistry}; relayerRegistry ${router.relayerRegistry}`,
  );

  for (const name of ["instanceRegistry", "relayerRegistry"]) {
    const proxy = await readProxy(rpc, CONTRACTS[name].address);
    const implCode = await readCode(rpc, proxy.implementation);
    out[name].proxy = { implementation: proxy.implementation, admin: proxy.admin, implementationRuntime: { sha256: implCode.sha256, bytes: implCode.bytes } };
    row(
      `${name}: proxy`,
      implCode.bytes > 0 && proxy.admin === router.governance,
      `implementation ${proxy.implementation} (${implCode.bytes} B, sha256 ${implCode.sha256.slice(0, 16)}…), admin ${proxy.admin}${proxy.admin === router.governance ? " = governance" : " ≠ governance"}`,
    );
  }

  out.instanceRegistry.instances = {};
  for (const id of POOL_IDS) {
    const inst = await readInstance(rpc, CONTRACTS.instanceRegistry.address, CONTRACTS[id].address);
    out.instanceRegistry.instances[id] = inst;
    row(
      `${id}: instance`,
      inst.state === 1 && !inst.isERC20,
      `${inst.stateName}, ${inst.isERC20 ? "ERC-20" : "ETH"}, protocol fee ${inst.protocolFeePercentage} (×0.01 %)`,
    );
  }

  const vk = parseVerifyingKey(records(CONTRACTS.verifier.record).sources["Verifier.sol"]);
  out.verifier.vk = vk;
  row("verifier: key", vk.nPublic === 6, `${vk.nPublic} public inputs, ${vk.IC.length} IC points from Verifier.sol`);

  if (pins) {
    const drift = diffPins(pins, out);
    row("pins", drift.length === 0, drift.length ? `drift: ${drift.join("; ")}` : "every pinned fact still holds");
  }
  return { ok: rows.every((r) => r.ok), rows, pins: out };
}

/** The pinned facts that a fresh reading no longer matches (the sizes, hashes, addresses and the pools' constants). */
export function diffPins(pins, fresh) {
  const d = [];
  const same = (path, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) d.push(`${path}: pinned ${JSON.stringify(a)}, read ${JSON.stringify(b)}`);
  };
  for (const id of POOL_IDS) {
    const p = pins.pools?.[id];
    const f = fresh.pools[id];
    if (!p) {
      d.push(`${id}: not pinned`);
      continue;
    }
    for (const k of ["address", "runtime", "deployedBlock", "verifier", "levels", "denominationWei", "operator", "rootHistorySize", "libraries"])
      same(`${id}.${k}`, p[k], f[k]);
  }
  for (const name of ["verifier", "router", "instanceRegistry", "relayerRegistry"]) {
    for (const k of ["address", "runtime", "deployedBlock"]) same(`${name}.${k}`, pins[name]?.[k], fresh[name]?.[k]);
  }
  same("verifier.vk", pins.verifier?.vk, fresh.verifier?.vk);
  for (const k of ["governance", "instanceRegistry", "relayerRegistry"]) same(`router.${k}`, pins.router?.[k], fresh.router?.[k]);
  for (const name of ["instanceRegistry", "relayerRegistry"])
    same(`${name}.proxy.implementation`, pins[name]?.proxy?.implementation, fresh[name]?.proxy?.implementation);
  return d;
}
