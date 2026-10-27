// classic-relayer.mjs — a tornado-relayer stand-in for the local stack (V7 Stage 10; spec v3.0 §7.9). It speaks the
// protocol the Classic app speaks to real relayers (the compatibility matrix §4): GET /status and /v1/status, POST
// /v1/tornadoWithdraw {proof, contract, args[6]}, GET /v1/jobs/:id with the states QUEUED → ACCEPTED → SENT → MINED →
// CONFIRMED (FAILED with the reason) — and submits each withdrawal through the real TornadoRouter placed on the devnet,
// from the devnet's account #0 (unlocked on the Hardhat node: no key here), exactly as the relayer software does on
// mainnet (`withdraw(instance, proof, root, nullifierHash, recipient, relayer, fee, refund)`). The fee is checked as the
// original does — the gas for a withdrawal at the current gas price plus the service percentage of the denomination —
// with a tenth of tolerance for the price moving between the app's quote and this check. Nothing here is a relayer for
// mainnet: no stake, no registration, no fee market; a request from the browser gets CORS headers like a real one.
//
//   node classic-relayer.mjs        PORT=8791; RPC and the pools from run/stack.json; CLASSIC_RELAYER_FEE=0.3 (percent)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(readFileSync(join(HERE, "run", "stack.json"), "utf8"));
if (!stack.classic) throw new Error("run/stack.json has no Classic deployment: run deploy.mjs first");
const PORT = Number(process.env.PORT ?? 8791);
const RPC = process.env.RPC ?? stack.rpc;
const FEE_PERCENT = Number(process.env.CLASSIC_RELAYER_FEE ?? 0.3);
const WITHDRAW_GAS = 550_000n; // the original relayer's gas limit for a withdrawal, what the Classic app prices the network fee with
const REWARD_ACCOUNT = stack.deployer.toLowerCase(); // account #0: the relayer's key on the devnet, as for the swap relayer
const pools = Object.fromEntries(Object.entries(stack.classic.pools).map(([amount, p]) => [p.address.toLowerCase(), { amount, denominationWei: BigInt(p.denominationWei) }]));

const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const routerAbi = parseAbi(["function withdraw(address _tornado, bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable"]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const PROOF = /^0x[0-9a-fA-F]{512}$/;
const jobs = new Map();
let queue = 0;

function status() {
  return {
    rewardAccount: REWARD_ACCOUNT,
    instances: {
      eth: { instanceAddress: Object.fromEntries(Object.entries(stack.classic.pools).map(([amount, p]) => [amount, p.address])), symbol: "ETH", decimals: 18 },
    },
    netId: 1,
    ethPrices: {},
    tornadoServiceFee: FEE_PERCENT,
    miningServiceFee: 0,
    version: "4.1.4",
    health: { status: "true", error: "" },
    currentQueue: queue,
  };
}

/** the original relayer's check: the fee must cover the gas at the current price plus the service percentage */
async function feeIsEnough(pool, fee) {
  const gasPrice = BigInt(await rpc("eth_gasPrice"));
  const expense = gasPrice * WITHDRAW_GAS;
  const percent = (pool.denominationWei * BigInt(Math.round(FEE_PERCENT * 1e6))) / 100_000_000n;
  const desired = expense + percent;
  return { ok: fee * 10n >= desired * 9n, desired, gasPrice };
}

/** the withdrawal through the router, the job moved as the transaction goes */
async function run(job) {
  try {
    job.status = "ACCEPTED";
    const [root, nullifierHash, recipient, relayer, fee, refund] = job.args;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "withdraw", args: [job.contract, job.proof, root, nullifierHash, recipient, relayer, BigInt(fee), BigInt(refund)] });
    job.txHash = await rpc("eth_sendTransaction", [{ from: REWARD_ACCOUNT, to: stack.classic.router, data, value: `0x${BigInt(refund).toString(16)}` }]);
    job.status = "SENT";
    for (let i = 0; i < 120; i++) {
      const receipt = await rpc("eth_getTransactionReceipt", [job.txHash]);
      if (receipt) {
        if (receipt.status !== "0x1") {
          job.status = "FAILED";
          job.failedReason = "the transaction reverted";
          return;
        }
        job.minedAt = Number.parseInt(receipt.blockNumber, 16);
        job.status = "MINED";
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    job.status = "FAILED";
    job.failedReason = "the transaction was not mined";
  } catch (e) {
    job.status = "FAILED";
    job.failedReason = e instanceof Error ? e.message : String(e);
  } finally {
    queue = Math.max(0, queue - 1);
  }
}

/** a mined job is CONFIRMED on the poll after the one that saw it mined (the original waits for confirmations; the devnet mines a block per transaction only) */
async function view(job) {
  if (job.status === "MINED") {
    const head = Number.parseInt(await rpc("eth_blockNumber"), 16);
    job.confirmations = Math.max(0, head - job.minedAt);
    if (job.seenMined) job.status = "CONFIRMED";
    job.seenMined = true;
  }
  return {
    id: job.id,
    type: "TORNADO_WITHDRAW",
    status: job.status,
    contract: job.contract,
    proof: job.proof,
    args: job.args,
    txHash: job.txHash ?? null,
    confirmations: job.confirmations ?? 0,
    failedReason: job.failedReason ?? null,
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(body));
};
const body = (req) =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
      if (text.length > 64_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "OPTIONS") return json(res, 204, null);
    if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/v1/status")) return json(res, 200, status());
    if (req.method === "GET" && url.pathname.startsWith("/v1/jobs/")) {
      const job = jobs.get(url.pathname.slice("/v1/jobs/".length));
      return job ? json(res, 200, await view(job)) : json(res, 400, { error: "The job doesn't exist" });
    }
    if (req.method === "POST" && url.pathname === "/v1/tornadoWithdraw") {
      let r;
      try {
        r = JSON.parse(await body(req));
      } catch {
        return json(res, 400, { error: "the body is not JSON" });
      }
      const keys = Object.keys(r ?? {}).sort().join(",");
      if (keys !== "args,contract,proof") return json(res, 400, { error: "the request must carry proof, contract and args, nothing else" });
      if (!PROOF.test(r.proof)) return json(res, 400, { error: "proof must be 0x and 512 hex digits" });
      if (!ADDRESS.test(r.contract)) return json(res, 400, { error: "contract must be an address" });
      const pool = pools[r.contract.toLowerCase()];
      if (!pool) return json(res, 400, { error: "This relayer does not serve the contract" });
      if (!Array.isArray(r.args) || r.args.length !== 6 || !BYTES32.test(r.args[0]) || !BYTES32.test(r.args[1]) || !ADDRESS.test(r.args[2]) || !ADDRESS.test(r.args[3]) || !BYTES32.test(r.args[4]) || !BYTES32.test(r.args[5]))
        return json(res, 400, { error: "args must be [root, nullifierHash, recipient, relayer, fee, refund] as bytes32, bytes32, address, address, bytes32, bytes32" });
      if (r.args[3].toLowerCase() !== REWARD_ACCOUNT) return json(res, 400, { error: "This proof is for different relayer" });
      if (BigInt(r.args[5]) !== 0n) return json(res, 400, { error: "Refund value is invalid: the ETH pools refund nothing" });
      const fee = await feeIsEnough(pool, BigInt(r.args[4]));
      if (!fee.ok) return json(res, 400, { error: "Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit." });
      const job = { id: randomUUID(), status: "QUEUED", contract: r.contract, proof: r.proof, args: r.args, createdAt: Date.now() };
      jobs.set(job.id, job);
      queue++;
      setTimeout(() => void run(job), 250);
      console.log(`${new Date().toISOString().slice(11, 19)} withdrawal for ${pool.amount} ETH queued as ${job.id} (fee ${r.args[4]}, desired ${fee.desired} at ${fee.gasPrice} wei)`);
      return json(res, 200, { id: job.id });
    }
    return json(res, 404, { error: "Not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`classic relayer stand-in on http://127.0.0.1:${PORT} (reward account ${REWARD_ACCOUNT}, fee ${FEE_PERCENT} %, router ${stack.classic.router})`));
