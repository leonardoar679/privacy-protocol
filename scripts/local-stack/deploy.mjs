// deploy.mjs — the local stack's chain state (docs/local-run.md; the V2 plan's end-to-end verification).
//
// On the Hardhat devnet (chain id 1) this deploys, from the forge artifacts in contracts/out, exactly what Deploy.s.sol
// and DeploySwapPeriphery.s.sol deploy: the dev-setup Groth16 verifier (the real circuit's key, an insecure setup), its
// adapter, the Poseidon2 hasher, PrivacyCore (which creates its own vault factory), the ETH vault and the
// SwapOrderFactory, and (V6) DeployProtectRouter.s.sol's ProtectRouter with a 6-decimal USDC at the mainnet address and
// its vault, and (V6 Stage 12) DeployShieldReceiver.s.sol's ShieldReceiverFactory (the core's vault factory, WETH9). Then
// it places, with hardhat_setCode, the mainnet bytecode of the contracts the wallet pins
// (THORChain's router, Chainflip's vault, WETH9) at their mainnet addresses, and mock Chainlink feeds at the mainnet
// proxy addresses, so the wallet's and the service's valuation read a price through the RPC and a signed execution is
// simulated against real provider code. Output: run/stack.json, read by start-services.mjs and e2e.mjs.
//
//   npx hardhat node --port 8546 --hostname 127.0.0.1     (another terminal; `npm run chain`)
//   node deploy.mjs                                        RPC=http://127.0.0.1:8546 by default
import { createPublicClient, createWalletClient, http, pad, toHex, stringToHex, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PP_ROOT ?? resolve(HERE, "../..");
const RUN = join(HERE, "run");
const RPC = process.env.RPC ?? "http://127.0.0.1:8546";
mkdirSync(RUN, { recursive: true });

// Hardhat's default accounts: #0 deploys and is the relayer's gas key; #1 is the funding wallet injected into the browser.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const account = privateKeyToAccount(KEYS[0]);
const chain = { id: 1, name: "local (chain id 1)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

// the mainnet contracts the wallet pins (packages/sdk/src/providerCall.ts PINNED): their runtime code is placed at the
// same addresses. mainnet/<name>.hex holds a copy (eth_getCode on 2026-10-08); a missing file is fetched from a public RPC.
const PINS = {
  weth9: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  thorchainRouter: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146",
  chainflipVault: "0xF5e10380213880111522dd0efD3dbb45b9f62Bcc",
};
const PUBLIC_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
const FEED_REGISTRY = "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf";
const BTC_FEED = "0x1111111111111111111111111111111111111B7c"; // a devnet address: mainnet resolves BTC / USD through the registry
// the mainnet proxies the wallet's table pins (packages/protocol/src/wallet/valuation.ts) and the mock prices
const FEEDS = [
  { symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", usd: Number(process.env.ETH_USD ?? 4250) },
  { symbol: "BTC", description: "BTC / USD", heartbeatSeconds: 3600, proxy: BTC_FEED, usd: Number(process.env.BTC_USD ?? 118000) },
  { symbol: "USDC", description: "USDC / USD", heartbeatSeconds: 86400, proxy: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", usd: 1 },
  { symbol: "USDT", description: "USDT / USD", heartbeatSeconds: 86400, proxy: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", usd: 1 },
  { symbol: "SOL", description: "SOL / USD", heartbeatSeconds: 86400, proxy: "0x4ffC43a60e009B551865A93d232E33Fce9f01507", usd: 180 },
];

const artifact = (name) => JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
const rpcCall = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const rpc = (method, params) => rpcCall(RPC, method, params);
async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name}: deployment failed`);
  console.log(`${name.padEnd(24)} ${r.contractAddress}  (${r.gasUsed} gas)`);
  return { address: r.contractAddress, abi: a.abi };
}
async function mainnetCode(name, address) {
  const file = join(HERE, "mainnet", `${name}.hex`);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  for (const url of PUBLIC_RPCS) {
    try {
      const code = await rpcCall(url, "eth_getCode", [address, "latest"]);
      if (code && code.length > 10) { writeFileSync(file, code); console.log(`${name}: ${(code.length - 2) / 2} bytes fetched from ${url}`); return code; }
    } catch (e) { console.log(`${name}: ${url} failed (${e.message})`); }
  }
  throw new Error(`${name}: no mainnet code at ${address} from any public RPC; save it to ${file}`);
}
const feedAbi = [
  { type: "function", name: "description", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "latestRoundData", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], stateMutability: "view" },
  { type: "function", name: "getFeed", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }], stateMutability: "view" },
];

const chainId = await pub.getChainId();
if (chainId !== 1) throw new Error(`the devnet answers chain id ${chainId}; the pins need 1 (hardhat.config.cjs)`);
if (!existsSync(join(ROOT, "contracts/out/PrivacyCore.sol/PrivacyCore.json"))) throw new Error("no forge artifacts: run `forge build` in contracts/ first");
console.log(`chain id ${chainId}, deployer ${account.address}, balance ${await pub.getBalance({ address: account.address }) / 10n ** 18n} ETH`);

// 1. the pool (Deploy.s.sol with the dev verifier)
const inner = await deploy("TransactionVerifierDev");
const verifier = await deploy("Groth16Verifier", [inner.address]);
const hasher = await deploy("Poseidon2Hasher");
const core = await deploy("PrivacyCore", [verifier.address, hasher.address, 32n]);
const vaultFactory = await pub.readContract({ address: core.address, abi: core.abi, functionName: "VAULT_FACTORY" });
const factoryAbi = artifact("AssetVaultFactory").abi;
const sim = await pub.simulateContract({ address: vaultFactory, abi: factoryAbi, functionName: "getOrCreateNativeVault", account });
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request) });
const ethVault = await pub.readContract({ address: vaultFactory, abi: factoryAbi, functionName: "vaultOf", args: ["0x0000000000000000000000000000000000000000"] });
console.log(`${"AssetVaultFactory".padEnd(24)} ${vaultFactory}`);
console.log(`${"NativeAssetVault (ETH)".padEnd(24)} ${ethVault}`);
if (ethVault === "0x0000000000000000000000000000000000000000" || ethVault !== sim.result) throw new Error("the ETH vault was not created");

// 2. the mainnet pins, WETH9 first: the swap factory takes it and escrows unwrap refunds paid in it
for (const [name, address] of Object.entries(PINS)) {
  await rpc("hardhat_setCode", [address, await mainnetCode(name, address)]);
  console.log(`${("pin " + name).padEnd(24)} ${address} (mainnet bytecode, ${(await pub.getCode({ address })).length / 2 - 1} bytes)`);
}

// 3. the swap periphery (DeploySwapPeriphery.s.sol)
const swapFactory = await deploy("SwapOrderFactory", [PINS.weth9]);
const escrowJson = JSON.parse(readFileSync(join(ROOT, "contracts/abi/periphery/SwapOrderEscrow.json"), "utf8"));
const escrowCode = typeof escrowJson.bytecode === "string" ? escrowJson.bytecode : escrowJson.bytecode.object;
console.log(`${"escrow creation hash".padEnd(24)} ${keccak256(escrowCode)} (contracts/abi/periphery/SwapOrderEscrow.json)`);

// 3b. V6 (spec v2.0 §3, §11.1): the protect router — 1 % of every protect to the fee recipient (account #2 here) — and a
// 6-decimal USDC at the mainnet address (the wallet's registry and the USDC / USD feed apply) with its canonical vault;
// the funding wallet holds 1,000,000 USDC
const feeRecipient = privateKeyToAccount(KEYS[2]).address;
const router = await deploy("ProtectRouter", [core.address, feeRecipient]);
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
await rpc("hardhat_setCode", [USDC, "0x" + readFileSync(join(HERE, "contracts/out/MockUSDC.bin-runtime"), "utf8").trim()]);
const usdcSim = await pub.simulateContract({ address: vaultFactory, abi: factoryAbi, functionName: "getOrCreateERC20Vault", args: [USDC], account });
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(usdcSim.request) });
const usdcVault = await pub.readContract({ address: vaultFactory, abi: factoryAbi, functionName: "vaultOf", args: [USDC] });
const usdcAbi = JSON.parse(readFileSync(join(HERE, "contracts/out/MockUSDC.abi"), "utf8"));
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: "mint", args: [privateKeyToAccount(KEYS[1]).address, 1_000_000n * 10n ** 6n] }) });
const routerCore = await pub.readContract({ address: router.address, abi: router.abi, functionName: "CORE" });
if (routerCore.toLowerCase() !== core.address.toLowerCase() || usdcVault === "0x0000000000000000000000000000000000000000") throw new Error("the protect router or the USDC vault is not in place");
console.log(`${"USDC (6 decimals)".padEnd(24)} ${USDC}  vault ${usdcVault}; fee recipient ${feeRecipient}`);

// 3c. V6 Stage 12 (spec v2.0 §11.2): the shield receiver factory — a same-chain swap's one-time receivers deposit into this
// pool's vaults; an ETH receipt unwraps WETH9
const shieldFactory = await deploy("ShieldReceiverFactory", [vaultFactory, PINS.weth9]);
const shieldPool = await pub.readContract({ address: shieldFactory.address, abi: shieldFactory.abi, functionName: "VAULT_FACTORY" });
if (shieldPool.toLowerCase() !== vaultFactory.toLowerCase()) throw new Error("the shield receiver factory deposits into another pool");

// 4. the price feeds: the mock's runtime at every proxy, the answer in slot 0, the description in slot 1
const feedRuntime = "0x" + readFileSync(join(HERE, "contracts/out/MockFeed.bin-runtime"), "utf8").trim();
const registryRuntime = "0x" + readFileSync(join(HERE, "contracts/out/MockRegistry.bin-runtime"), "utf8").trim();
for (const f of FEEDS) {
  await rpc("hardhat_setCode", [f.proxy, feedRuntime]);
  await rpc("hardhat_setStorageAt", [f.proxy, "0x0", pad(toHex(BigInt(Math.round(f.usd * 1e8))), { size: 32 })]);
  await rpc("hardhat_setStorageAt", [f.proxy, "0x1", pad(stringToHex(f.description), { size: 32, dir: "right" })]);
  const d = await pub.readContract({ address: f.proxy, abi: feedAbi, functionName: "description" });
  const [, answer, , updatedAt] = await pub.readContract({ address: f.proxy, abi: feedAbi, functionName: "latestRoundData" });
  if (d !== f.description || answer !== BigInt(Math.round(f.usd * 1e8))) throw new Error(`feed ${f.symbol} reads back wrong: ${d} ${answer}`);
  console.log(`${("feed " + f.symbol).padEnd(24)} ${f.proxy}  "${d}" ${Number(answer) / 1e8} USD, updated ${updatedAt}`);
}
await rpc("hardhat_setCode", [FEED_REGISTRY, registryRuntime]);
await rpc("hardhat_setStorageAt", [FEED_REGISTRY, "0x0", pad(BTC_FEED, { size: 32 })]);
const resolved = await pub.readContract({ address: FEED_REGISTRY, abi: feedAbi, functionName: "getFeed", args: ["0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", "0x0000000000000000000000000000000000000348"] });
if (resolved.toLowerCase() !== BTC_FEED.toLowerCase()) throw new Error("the registry does not resolve BTC / USD");
console.log(`${"feed registry".padEnd(24)} ${FEED_REGISTRY} -> BTC / USD at ${resolved}`);

// 6. V7 Stage 10 (spec v3.0 §7.9): Tornado Classic's mainnet contracts at their mainnet addresses — the four ETH pools, their
// verifier and the MiMC Hasher library the pools link, the TornadoRouter and the two registries behind their proxies — with
// the runtime code of the Sourcify records the Classic app's pins were verified against (classic/contracts/verified/) and the
// state classic-capture.mjs read from mainnet (mainnet/classic-state.json: the Hasher's code, the proxies' slots, the ETH
// instances ENABLED). Each pool gets the storage its constructor writes — levels, the twenty zero subtrees in filledSubtrees
// and zeros, roots[0] = the empty tree's root, the reentrancy counter at one, the denomination, the verifier, no operator —
// computed with the Classic app's own tree hash, and every getter is read back, hashLeftRight through the Hasher included:
// the chain's MiMC is held to the app's here, before any deposit. The Classic app then verifies its pins against this chain.
const classicState = JSON.parse(readFileSync(join(HERE, "mainnet", "classic-state.json"), "utf8"));
const classicPins = JSON.parse(readFileSync(join(ROOT, "classic/src/config/deployment.json"), "utf8"));
const verifiedRecord = (name) => JSON.parse(readFileSync(join(ROOT, "classic/contracts/verified", `${name}.json`), "utf8")).runtimeBytecode.onchainBytecode;
const { zeros, LEVELS } = await import(pathToFileURL(join(ROOT, "classic/src/crypto/tree.ts")).href);
const w32 = (x) => pad(toHex(BigInt(x)), { size: 32 });
const slotOf = (s) => toHex(BigInt(s)); // a quantity: no leading zeros
const z = zeros();
if (z.length !== LEVELS + 1 || LEVELS !== 20) throw new Error("the Classic tree is not 20 levels");
const placeCode = async (name, address, code) => {
  await rpc("hardhat_setCode", [address, code]);
  console.log(`${("classic " + name).padEnd(24)} ${address} (mainnet bytecode, ${(code.length - 2) / 2} bytes)`);
};
await placeCode("Hasher (MiMC)", classicState.hasher.address, classicState.hasher.code);
await placeCode("verifier", classicPins.verifier.address, verifiedRecord("verifier"));
await placeCode("router", classicPins.router.address, verifiedRecord("router"));
for (const [name, reg, files] of [
  ["instance registry", classicState.instanceRegistry, ["instance-registry-proxy", "instance-registry-implementation"]],
  ["relayer registry", classicState.relayerRegistry, ["relayer-registry-proxy", "relayer-registry-implementation"]],
]) {
  await placeCode(`${name} proxy`, reg.address, verifiedRecord(files[0]));
  await placeCode(`${name} impl.`, reg.implementation, verifiedRecord(files[1]));
  for (const [slot, value] of Object.entries(reg.slots)) await rpc("hardhat_setStorageAt", [reg.address, slotOf(slot), value]);
  for (const inst of Object.values(reg.instances ?? {})) await rpc("hardhat_setStorageAt", [reg.address, slotOf(inst.slot), inst.value]);
}
const poolAbi = parseAbi([
  "function levels() view returns (uint32)",
  "function filledSubtrees(uint256) view returns (bytes32)",
  "function zeros(uint256) view returns (bytes32)",
  "function roots(uint256) view returns (bytes32)",
  "function getLastRoot() view returns (bytes32)",
  "function isKnownRoot(bytes32) view returns (bool)",
  "function nextIndex() view returns (uint32)",
  "function currentRootIndex() view returns (uint32)",
  "function denomination() view returns (uint256)",
  "function verifier() view returns (address)",
  "function operator() view returns (address)",
  "function ROOT_HISTORY_SIZE() view returns (uint32)",
  "function hashLeftRight(bytes32,bytes32) view returns (bytes32)",
]);
const registryAbi = parseAbi(["function instances(address) view returns (bool,address,uint8,uint24,uint32)", "function router() view returns (address)", "function tornadoRouter() view returns (address)", "function workers(address) view returns (address)"]);
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const classicPools = {};
for (const [id, p] of Object.entries(classicPins.pools)) {
  await placeCode(`pool ${id}`, p.address, verifiedRecord(`pool-${id}`));
  // TornadoCash_eth.sol: MerkleTreeWithHistory in slots 0–103 (levels; filledSubtrees and zeros as dynamic arrays; currentRootIndex
  // and nextIndex packed; roots[100]), ReentrancyGuard's counter at 104, Tornado's denomination 105, the two mappings, verifier 108, operator 109
  const set = (slot, value) => rpc("hardhat_setStorageAt", [p.address, slotOf(slot), value]);
  await set(0n, w32(p.levels));
  await set(1n, w32(LEVELS));
  await set(2n, w32(LEVELS));
  const elements1 = BigInt(keccak256(w32(1n)));
  const elements2 = BigInt(keccak256(w32(2n)));
  for (let i = 0; i < LEVELS; i++) {
    await set(elements1 + BigInt(i), w32(z[i]));
    await set(elements2 + BigInt(i), w32(z[i]));
  }
  await set(3n, w32(0n));
  await set(4n, w32(z[LEVELS]));
  await set(104n, w32(1n));
  await set(105n, w32(BigInt(p.denominationWei)));
  await set(108n, pad(p.verifier, { size: 32 }));
  await set(109n, w32(0n));
  // read back through the contract's own getters
  const problems = [];
  if ((await read(p.address, poolAbi, "levels")) !== 20) problems.push("levels");
  for (let i = 0; i < LEVELS; i++) {
    if (BigInt(await read(p.address, poolAbi, "zeros", [BigInt(i)])) !== z[i]) problems.push(`zeros(${i})`);
    if (BigInt(await read(p.address, poolAbi, "filledSubtrees", [BigInt(i)])) !== z[i]) problems.push(`filledSubtrees(${i})`);
  }
  const last = BigInt(await read(p.address, poolAbi, "getLastRoot"));
  if (last !== z[LEVELS] || BigInt(await read(p.address, poolAbi, "roots", [0n])) !== z[LEVELS]) problems.push("roots[0] / getLastRoot");
  if (!(await read(p.address, poolAbi, "isKnownRoot", [w32(z[LEVELS])]))) problems.push("isKnownRoot(empty root)");
  if ((await read(p.address, poolAbi, "nextIndex")) !== 0 || (await read(p.address, poolAbi, "currentRootIndex")) !== 0) problems.push("indices");
  if ((await read(p.address, poolAbi, "denomination")) !== BigInt(p.denominationWei)) problems.push("denomination");
  if ((await read(p.address, poolAbi, "verifier")).toLowerCase() !== p.verifier.toLowerCase()) problems.push("verifier");
  if ((await read(p.address, poolAbi, "operator")) !== "0x0000000000000000000000000000000000000000") problems.push("operator");
  if ((await read(p.address, poolAbi, "ROOT_HISTORY_SIZE")) !== 100) problems.push("ROOT_HISTORY_SIZE");
  if (BigInt(await read(p.address, poolAbi, "hashLeftRight", [w32(z[0]), w32(z[0])])) !== z[1]) problems.push("hashLeftRight through the Hasher");
  const [, , state] = await read(classicState.instanceRegistry.address, registryAbi, "instances", [p.address]);
  if (state !== 1) problems.push(`the instance registry says state ${state}`);
  if (problems.length) throw new Error(`classic pool ${id} does not read back: ${problems.join(", ")}`);
  classicPools[p.amount] = { id, address: p.address, denominationWei: p.denominationWei };
  console.log(`${("classic pool " + id).padEnd(24)} levels 20, the empty root known, hashLeftRight = the app's, ENABLED in the registry`);
}
if ((await read(classicState.instanceRegistry.address, registryAbi, "router")).toLowerCase() !== classicPins.router.address.toLowerCase()) throw new Error("the instance registry does not name the router");
if ((await read(classicState.relayerRegistry.address, registryAbi, "tornadoRouter")).toLowerCase() !== classicPins.router.address.toLowerCase()) throw new Error("the relayer registry does not name the router");
if ((await read(classicState.relayerRegistry.address, registryAbi, "workers", [account.address])) !== "0x0000000000000000000000000000000000000000") throw new Error("the deployer is a registered relayer worker");
const classicDeployedBlock = Number(await pub.getBlockNumber());
console.log(`${"classic".padEnd(24)} router ${classicPins.router.address}, registries named, the devnet's "deployed block" ${classicDeployedBlock}`);

// 5. what the services and the wallet need
const stack = {
  rpc: RPC,
  chainId: 1,
  deployer: account.address,
  keys: { relayer: KEYS[0], funding: KEYS[1] },
  funding: privateKeyToAccount(KEYS[1]).address,
  core: core.address,
  vaultFactory,
  ethVault,
  swapFactory: swapFactory.address,
  protectRouter: router.address,
  shieldFactory: shieldFactory.address,
  feeRecipient,
  usdc: { token: USDC, vault: usdcVault, decimals: 6 },
  verifier: verifier.address,
  innerVerifier: inner.address,
  hasher: hasher.address,
  pins: PINS,
  feeds: FEEDS.map(({ usd, ...spec }) => spec),
  prices: Object.fromEntries(FEEDS.map((f) => [f.symbol, f.usd])),
  // V7 Stage 10: Tornado Classic at its mainnet addresses; the Classic dev server syncs the pools from this block
  classic: {
    hasher: classicState.hasher.address,
    verifier: classicPins.verifier.address,
    router: classicPins.router.address,
    instanceRegistry: classicState.instanceRegistry.address,
    relayerRegistry: classicState.relayerRegistry.address,
    pools: classicPools,
    deployedBlock: classicDeployedBlock,
    stateReadAt: classicState.readAt,
  },
  deployedAt: new Date().toISOString(),
};
writeFileSync(join(RUN, "stack.json"), JSON.stringify(stack, null, 2));
console.log(`\n${join(RUN, "stack.json")} written`);
