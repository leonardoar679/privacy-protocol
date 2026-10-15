// Swap-order executor against the periphery forge vector (contracts/test/periphery/vectors/endpoint.json)
// on a mock chain: the predicted escrow equals the forge prediction; a job is accepted only with the
// committed refund payload and an execution signed by the one-time order key; the executor sends
// deployAndExecute exactly once when the escrow is funded before the signed deadline, deployAndRefund
// with the committed payload once refundAfter is reached with a balance, marks expiry, spends no
// gas when the call would revert, waits while executing would cost more than the tip (V6: the tip is the execution's
// gas), and records each receipt's actual cost. A V6 follow-up of 2026-10-15: an execution the node refused, or an RPC
// that could not estimate a refund, leaves the job to the next tick (it was execute-failed, or refund-failed for good),
// and a transaction the node dropped sends the job back to the state it was sent from. No real chain, no funds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from "viem";
import { DROP_AFTER_MS } from "../src/sender";
import { privateKeyToAccount } from "viem/accounts";
import { SwapExecutor, SwapJobError, factoryAbi, loadEscrowCreationCode, type SwapJobRequest } from "../src/swapExecutor";
import { executionDigest, orderSignerAddress, predictEscrow, signExecution } from "@privacy-wallet/swap-engine/endpoints";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vector = JSON.parse(readFileSync(join(root, "contracts/test/periphery/vectors/endpoint.json"), "utf8"));
const creationCode = loadEscrowCreationCode();
const CHAIN_ID = Number(vector.chainId);
const RELAYER_KEY = ("0x" + "7e".repeat(32)) as Hex;
const ORDER_KEY = new Uint8Array(32).fill(0xa1);

// ---- mock JSON-RPC ----
const raws: Hex[] = [];
let escrowBalance = 0n;
let revertSimulation = false;
let receiptStatus: "0x1" | "0x0" | null = null;
let gasPrice = "0x3b9aca00"; // 1 gwei
let refuseSend = false;
let estimateDown = false;
const taken = new Set<Hex>(); // what the node took
const dropped = new Set<Hex>(); // what it no longer knows
const block = { number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), transactions: [], uncles: [] };
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res(toHex(CHAIN_ID));
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_gasPrice": return res(gasPrice);
    case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_getTransactionCount": return res("0x1");
    case "eth_getBalance": return res(toHex(escrowBalance));
    case "eth_estimateGas": return estimateDown ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } } : revertSimulation ? { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted: BadSignature()" } } : res("0x7a120");
    case "eth_sendRawTransaction":
      if (refuseSend) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "nonce too low" } };
      raws.push(req.params[0]); taken.add(keccak256(req.params[0])); return res(keccak256(req.params[0]));
    case "eth_getTransactionByHash": return res(taken.has(req.params[0]) && !dropped.has(req.params[0]) ? { hash: req.params[0], nonce: "0x1", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), input: "0x", value: "0x0", gas: "0x5208", blockHash: null, blockNumber: null, transactionIndex: null, type: "0x2", chainId: "0x1", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00", v: "0x0", yParity: "0x0", r: "0x1", s: "0x1" } : null);
    case "eth_getTransactionReceipt": return res(receiptStatus === null ? null : { transactionHash: req.params[0], status: receiptStatus, blockNumber: "0x11", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), cumulativeGasUsed: "0x1", gasUsed: "0x7a120", effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2" });
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let clock = 1000; // the vector's deadlines: execution 1201, executeDeadline 1801, refundAfter 7201
let executor: SwapExecutor;
let request: SwapJobRequest;

beforeAll(async () => {
  server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = { id: CHAIN_ID, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  const account = privateKeyToAccount(RELAYER_KEY);
  executor = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, account, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }), now: () => clock, lateRefundWatchSeconds: 0 });
  // a job for the vector's order, re-signed by a key we hold (the vector's signer key is forge's)
  const refundNoteData = ("0x" + "cd".repeat(169)) as Hex;
  const params = { ...vector.params, orderSigner: orderSignerAddress(ORDER_KEY), refundNoteDataHash: keccak256(refundNoteData) };
  const escrow = predictEscrow(vector.factory, creationCode, { ...params, assetType: 0, amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip) });
  const providerCalldata = ("0x" + "ab".repeat(40)) as Hex;
  const digest = executionDigest(BigInt(CHAIN_ID), escrow, params.orderId, vector.execution.provider, BigInt(vector.execution.value), providerCalldata, Number(vector.execution.deadline));
  request = { factory: vector.factory, params, execution: { provider: vector.execution.provider, value: vector.execution.value, providerCalldata, deadline: Number(vector.execution.deadline), signature: signExecution(ORDER_KEY, digest) }, refundNoteData };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("escrow prediction", () => {
  it("matches the forge vector for the vector's exact params", () => {
    const p = vector.params;
    expect(predictEscrow(vector.factory, creationCode, { ...p, assetType: 0, amount: BigInt(p.amount), refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), executorTip: BigInt(p.executorTip) }).toLowerCase()).toBe(String(vector.predicted).toLowerCase());
  });
});

describe("job admission", () => {
  it("rejects a refund payload that does not hash to the commitment, a foreign signature, bad deadlines", () => {
    const code = (r: SwapJobRequest) => { try { executor.add(r); return "ok"; } catch (e) { return (e as SwapJobError).code; } };
    expect(code({ ...request, refundNoteData: ("0x" + "ce".repeat(169)) as Hex })).toBe("refund_payload_mismatch");
    expect(code({ ...request, execution: { ...request.execution, signature: signExecution(new Uint8Array(32).fill(0xb2), ("0x" + "00".repeat(32)) as Hex) } })).toBe("bad_signature");
    expect(code({ ...request, execution: { ...request.execution, value: (BigInt(request.params.amount)).toString() } })).toBe("bad_signature"); // a changed value changes the digest
    expect(code({ ...request, execution: { ...request.execution, deadline: Number(request.params.executeDeadline) + 1 } })).toBe("bad_deadlines");
    expect(code({ ...request, params: { ...request.params, assetType: 1 } })).toBe("bad_execution"); // an ERC-20 order must forward no ETH value
  });
  it("accepts the signed order, predicts its escrow, and is idempotent per orderId", () => {
    const job = executor.add(request);
    expect(job.state).toBe("waiting-funding");
    expect(job.escrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(executor.add(request)).toBe(job);
    expect(executor.list().length).toBe(1);
  });
});

describe("execution", () => {
  it("does nothing while the escrow is unfunded", async () => {
    await executor.tick();
    expect(raws.length).toBe(0);
    expect(executor.get(request.params.orderId)!.state).toBe("waiting-funding");
  });
  it("funded before the deadline → deployAndExecute from the relayer's key with exactly the signed execution", async () => {
    escrowBalance = BigInt(request.params.amount);
    await executor.tick();
    const job = executor.get(request.params.orderId)!;
    expect(job.state).toBe("executing");
    expect(job.executionTx, "the execution transaction is recorded on its own (whale spec §19)").toBe(job.txHash);
    expect(raws.length).toBe(1);
    const tx = parseTransaction(raws[0]);
    expect(tx.to?.toLowerCase()).toBe(vector.factory.toLowerCase());
    expect((await recoverTransactionAddress({ serializedTransaction: raws[0] as `0x02${string}` })).toLowerCase()).toBe(privateKeyToAccount(RELAYER_KEY).address.toLowerCase());
    const d = decodeFunctionData({ abi: factoryAbi, data: tx.data! });
    expect(d.functionName).toBe("deployAndExecute");
    const [p, x] = d.args as any;
    expect(p.orderId).toBe(request.params.orderId);
    expect(p.orderSigner.toLowerCase()).toBe(request.params.orderSigner.toLowerCase());
    expect(p.amount).toBe(BigInt(request.params.amount));
    expect(x.providerCalldata).toBe(request.execution.providerCalldata);
    expect(x.signature).toBe(request.execution.signature);
    expect(x.deadline).toBe(BigInt(request.execution.deadline));
    await executor.tick(); // no receipt yet: nothing new
    expect(raws.length).toBe(1);
    receiptStatus = "0x1";
    await executor.tick();
    expect(executor.get(request.params.orderId)!.state).toBe("executed");
    expect(executor.get(request.params.orderId)!.gasUsed).toBe("500000");
    expect(executor.get(request.params.orderId)!.actualNetworkWei, "V6: gasUsed × effectiveGasPrice from the receipt").toBe("500000000000000");
    receiptStatus = null;
  });
  it("a provider refund that lands in the escrow is re-shielded after refundAfter with the committed payload; then completed", async () => {
    escrowBalance = 123_000_000_000_000_000n; // a provider refund (above the 1% floor of an unpaid re-shield, PP-S12)
    clock = 7200; // before refundAfter: nothing
    await executor.tick();
    expect(raws.length).toBe(1);
    clock = 7201;
    await executor.tick();
    expect(executor.get(request.params.orderId)!.state).toBe("refunding");
    expect(raws.length).toBe(2);
    const d = decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[1]).data! });
    expect(d.functionName).toBe("deployAndRefund");
    expect((d.args as any)[1]).toBe(request.refundNoteData);
    receiptStatus = "0x1";
    await executor.tick();
    expect(executor.get(request.params.orderId)!.state).toBe("refunded");
    receiptStatus = null;
  });
  it("an order that is never funded before its signed deadline expires, and refunds after the window if funded late", async () => {
    const late: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + "01".repeat(32)) as Hex } };
    // re-sign for the new escrow (orderId changes the address and the digest)
    const escrow = predictEscrow(late.factory, creationCode, { ...late.params, assetType: 0, amount: BigInt(late.params.amount), refundOwnerCommitment: BigInt(late.params.refundOwnerCommitment), refundNoteSecret: BigInt(late.params.refundNoteSecret), executorTip: BigInt(late.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, late.params.orderId, late.execution.provider, BigInt(late.execution.value), late.execution.providerCalldata, late.execution.deadline);
    late.execution = { ...late.execution, signature: signExecution(ORDER_KEY, digest) };
    clock = 1000; escrowBalance = 0n;
    const job = executor.add(late);
    expect(job.state).toBe("waiting-funding");
    clock = 1202; // signed deadline 1201 passed, unfunded
    await executor.tick();
    expect(job.state).toBe("expired");
    escrowBalance = BigInt(late.params.amount); // funded too late
    await executor.tick();
    expect(job.state).toBe("expired");
    expect(raws.length).toBe(2);
    clock = 8000;
    await executor.tick();
    expect(job.state).toBe("refunding");
    expect(raws.length).toBe(3);
  });
  it("a call that would revert spends no gas and records the reason", async () => {
    const bad: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + "02".repeat(32)) as Hex } };
    const escrow = predictEscrow(bad.factory, creationCode, { ...bad.params, assetType: 0, amount: BigInt(bad.params.amount), refundOwnerCommitment: BigInt(bad.params.refundOwnerCommitment), refundNoteSecret: BigInt(bad.params.refundNoteSecret), executorTip: BigInt(bad.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, bad.params.orderId, bad.execution.provider, BigInt(bad.execution.value), bad.execution.providerCalldata, bad.execution.deadline);
    bad.execution = { ...bad.execution, signature: signExecution(ORDER_KEY, digest) };
    clock = 1000; escrowBalance = BigInt(bad.params.amount); revertSimulation = true;
    const job = executor.add(bad);
    try {
      await executor.tick();
      expect(job.state).toBe("execute-failed");
      expect(job.error).toMatch(/would revert/);
      expect(raws.length).toBe(3);
    } finally {
      revertSimulation = false;
    }
  });
  it("V6 (spec v2.0 §3): while executing would cost more than the tip the executor waits and sends nothing; it executes once the cost is back under", async () => {
    const dear: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + "03".repeat(32)) as Hex } };
    const escrow = predictEscrow(dear.factory, creationCode, { ...dear.params, assetType: 0, amount: BigInt(dear.params.amount), refundOwnerCommitment: BigInt(dear.params.refundOwnerCommitment), refundNoteSecret: BigInt(dear.params.refundNoteSecret), executorTip: BigInt(dear.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, dear.params.orderId, dear.execution.provider, BigInt(dear.execution.value), dear.execution.providerCalldata, dear.execution.deadline);
    dear.execution = { ...dear.execution, signature: signExecution(ORDER_KEY, digest) };
    clock = 1000; escrowBalance = BigInt(dear.params.amount);
    const job = executor.add(dear);
    const before = raws.length;
    gasPrice = "0x12a05f200"; // 5 gwei: 500,000 gas × 5 gwei = 0.0025 ETH, above the 0.002 ETH tip
    try {
      await executor.tick();
      expect(job.state).toBe("waiting-funding");
      expect(job.error).toMatch(/waiting: executing now costs 2500000000000000 wei, above the order's 2000000000000000 wei tip/);
      expect(raws.length, "nothing sent below cost").toBe(before);
      gasPrice = "0xee6b2800"; // 4 gwei: 0.002 ETH, exactly the tip
      await executor.tick();
      expect(job.state).toBe("executing");
      expect(raws.length).toBe(before + 1);
    } finally {
      gasPrice = "0x3b9aca00";
    }
  });
});

describe("a send's fate (a V6 follow-up of 2026-10-15)", () => {
  /** The vector's order under another id, re-signed for its own escrow; `deadline` at most the order's executeDeadline (1801). */
  const order = (n: number, deadline = Number(request.execution.deadline)): SwapJobRequest => {
    const o: SwapJobRequest = { ...request, params: { ...request.params, orderId: toHex(n, { size: 32 }) } };
    const escrow = predictEscrow(o.factory, creationCode, { ...o.params, assetType: 0, amount: BigInt(o.params.amount), refundOwnerCommitment: BigInt(o.params.refundOwnerCommitment), refundNoteSecret: BigInt(o.params.refundNoteSecret), executorTip: BigInt(o.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, o.params.orderId, o.execution.provider, BigInt(o.execution.value), o.execution.providerCalldata, deadline);
    o.execution = { ...o.execution, deadline, signature: signExecution(ORDER_KEY, digest) };
    return o;
  };

  it("an execution the node refused stays waiting with a note, and the next tick executes it; it was execute-failed", async () => {
    clock = 1000; escrowBalance = BigInt(request.params.amount);
    const job = executor.add(order(0x10));
    const before = raws.length;
    refuseSend = true;
    try {
      await executor.tick();
    } finally {
      refuseSend = false;
    }
    expect(job.state).toBe("waiting-funding");
    expect(job.error).toMatch(/^not sent: .*nonce too low.*; retried next tick$/);
    expect(raws.length).toBe(before);
    await executor.tick();
    expect(job.state).toBe("executing");
    expect(raws.length).toBe(before + 1);
  });
  it("an execution the node dropped goes back to waiting DROP_AFTER_MS after it was sent, and the next tick sends it again", async () => {
    clock = 1000; escrowBalance = BigInt(request.params.amount);
    const job = executor.add(order(0x11, 1801));
    await executor.tick();
    expect(job.state).toBe("executing");
    const first = job.txHash!;
    expect(job.executionTx).toBe(first);
    expect(job.sent).toEqual({ from: "waiting-funding", at: 1000 });
    dropped.add(first);
    clock = 1000 + DROP_AFTER_MS / 1000 - 1;
    await executor.tick();
    expect(job.state, "not yet: the node may still take it").toBe("executing");
    clock = 1000 + DROP_AFTER_MS / 1000;
    await executor.tick();
    expect(job.state).toBe("waiting-funding");
    expect(job.error).toBe(`${first} was dropped before it was mined; sent again`);
    expect(job.executionTx).toBeUndefined();
    expect(job.sent).toBeUndefined();
    dropped.delete(first);
    const before = raws.length;
    await executor.tick();
    expect(job.state).toBe("executing");
    expect(raws.length).toBe(before + 1);
  });
  it("a refund the RPC could not estimate is noted and tried again next tick; it was refund-failed, for good", async () => {
    clock = 1000; escrowBalance = 0n;
    const job = executor.add(order(0x12));
    clock = 1202;
    await executor.tick();
    expect(job.state).toBe("expired");
    escrowBalance = BigInt(request.params.amount); // funded late
    clock = 7201;
    estimateDown = true;
    try {
      await executor.tick();
    } finally {
      estimateDown = false;
    }
    expect(job.state).toBe("expired");
    expect(job.error).toMatch(/^could not estimate: .*; retried next tick$/);
    await executor.tick();
    expect(job.state).toBe("refunding");
    expect(decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws.at(-1)!).data! }).functionName).toBe("deployAndRefund");
  });
});
