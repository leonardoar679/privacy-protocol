// deploy.mjs — the local stack's chain state (docs/local-run.md; the V2 plan's end-to-end verification).
//
// On the Hardhat devnet (chain id 1) this deploys, from the forge artifacts in contracts/out, exactly what Deploy.s.sol
// and DeploySwapPeriphery.s.sol deploy: the dev-setup Groth16 verifier (the real circuit's key, an insecure setup), its
// adapter, the Poseidon2 hasher, PrivacyCore (which creates its own vault factory), the ETH vault and the
// SwapOrderFactory. Then it places, with hardhat_setCode, the mainnet bytecode of the contracts the wallet pins
// (THORChain's router, Chainflip's vault, WETH9) at their mainnet addresses, and mock Chainlink feeds at the mainnet
// proxy addresses, so the wallet's and the service's valuation read a price through the RPC and a signed execution is
// simulated against real provider code. Output: run/stack.json, read by start-services.mjs and e2e.mjs.
//
//   npx hardhat node --port 8546 --hostname 127.0.0.1     (another terminal; `npm run chain`)
//   node deploy.mjs                                        RPC=http://127.0.0.1:8546 by default
import { createPublicClient, createWalletClient, http, pad, toHex, stringToHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// the mainnet contracts the wallet pins (apps/web/src/sdk/providerCall.ts PINNED): their runtime code is placed at the
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
if (chainId !== 1) throw new Error(`the devnet answers chain id ${chainId}; the pins need 1 (hardhat.config.js)`);
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
  verifier: verifier.address,
  innerVerifier: inner.address,
  hasher: hasher.address,
  pins: PINS,
  feeds: FEEDS.map(({ usd, ...spec }) => spec),
  prices: Object.fromEntries(FEEDS.map((f) => [f.symbol, f.usd])),
  deployedAt: new Date().toISOString(),
};
writeFileSync(join(RUN, "stack.json"), JSON.stringify(stack, null, 2));
console.log(`\n${join(RUN, "stack.json")} written`);
