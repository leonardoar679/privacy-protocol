#!/usr/bin/env node
// Live cost of every protocol operation: measured gas (measurements.json) x the CURRENT Ethereum
// gas price and ETH/USD, fetched at run time. No hard-coded gwei anywhere.
//   node cost.mjs                  live: base fee + median priority via eth_feeHistory, ETH/USD from Coinbase
//   node cost.mjs --gwei 0.233     override the gas price (gwei)
//   node cost.mjs --eth-usd 3000   override the ETH price
//   node cost.mjs --json           machine-readable output
// Env: RPC_URL (default: public RPCs, tried in order), ETHERSCAN_API_KEY (adds the Etherscan gas oracle).
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const M = JSON.parse(readFileSync(join(here, "measurements.json"), "utf8"));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? true] : []).filter(Boolean));

const RPCS = process.env.RPC_URL ? [process.env.RPC_URL] : [
  "https://ethereum-rpc.publicnode.com",
  "https://cloudflare-eth.com",
  "https://eth.llamarpc.com",
];

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Current gas price in gwei: next base fee + median priority fee of the last 5 blocks. */
async function liveGasPrice() {
  for (const url of RPCS) {
    try {
      const fh = await rpc(url, "eth_feeHistory", ["0x5", "latest", [50]]);
      const base = Number(BigInt(fh.baseFeePerGas.at(-1))) / 1e9; // base fee of the NEXT block
      const prios = fh.reward.map((r) => Number(BigInt(r[0])) / 1e9).sort((a, b) => a - b);
      const prio = prios[Math.floor(prios.length / 2)];
      return { gwei: base + prio, base, prio, source: `${url} eth_feeHistory` };
    } catch (e) {
      try {
        const gp = await rpc(url, "eth_gasPrice", []);
        return { gwei: Number(BigInt(gp)) / 1e9, source: `${url} eth_gasPrice` };
      } catch { /* next RPC */ }
    }
  }
  throw new Error("no RPC reachable; pass --gwei");
}

async function etherscanOracle() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${key}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.status !== "1") return null;
    return { safe: +j.result.SafeGasPrice, propose: +j.result.ProposeGasPrice, fast: +j.result.FastGasPrice, base: +j.result.suggestBaseFee };
  } catch { return null; }
}

async function liveEthUsd() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) });
    return { usd: Number((await r.json()).data.amount), source: "coinbase spot" };
  } catch {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    return { usd: (await r.json()).ethereum.usd, source: "coingecko" };
  }
}

const gas = args.gwei ? { gwei: Number(args.gwei), source: "--gwei" } : await liveGasPrice();
const eth = args["eth-usd"] ? { usd: Number(args["eth-usd"]), source: "--eth-usd" } : await liveEthUsd();
const oracle = await etherscanOracle();

const rows = Object.entries(M.operations).map(([op, m]) => {
  const ethCost = (m.gas * gas.gwei) / 1e9;
  return { op, gas: m.gas, eth: ethCost, usd: ethCost * eth.usd, target: m.target, note: m.note };
});

if (args.json) {
  console.log(JSON.stringify({ at: new Date().toISOString(), gas, eth, etherscan: oracle, measured: M._measured, rows }, null, 2));
  process.exit(0);
}

const fmt = (x, d) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
console.log(`Privacy Protocol V1 — operation cost at CURRENT prices   (${new Date().toISOString()})`);
console.log(`gas price : ${fmt(gas.gwei, 3)} gwei  (${gas.source}${gas.base !== undefined ? `; base ${fmt(gas.base, 3)} + priority ${fmt(gas.prio, 3)}` : ""})`);
if (oracle) console.log(`etherscan : safe ${oracle.safe} / propose ${oracle.propose} / fast ${oracle.fast} gwei (base ${oracle.base})`);
console.log(`ETH/USD   : $${fmt(eth.usd, 2)}  (${eth.source})`);
console.log(`gas data  : measured ${M._measured}\n`);
const w = [36, 12, 12, 10, 12];
const line = (c) => c.map((x, i) => String(x).padEnd(w[i])).join("");
console.log(line(["operation", "gas", "ETH", "USD", "§79 target"]));
console.log(line(w.map((n) => "-".repeat(n - 1))));
for (const r of rows) {
  const tgt = r.target ? `${fmt(r.target / 1000, 0)}k ${r.gas <= r.target ? "met" : `(${fmt(r.gas / r.target, 1)}x)`}` : "-";
  console.log(line([r.op, fmt(r.gas, 0), fmt(r.eth, 6), "$" + fmt(r.usd, 2), tgt]));
}
console.log("\nTargets are the plan's §79 engineering targets (not security requirements); 'x' = how far above.");
