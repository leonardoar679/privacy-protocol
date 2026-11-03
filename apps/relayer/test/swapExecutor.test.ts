// Swap-order executor against the periphery forge vector (contracts/test/periphery/vectors/endpoint.json)
// on a mock chain: the predicted escrow equals the forge prediction; a job is accepted only with the
// committed refund payload and an execution signed by the one-time order key; the executor sends
// deployAndExecute exactly once when the escrow is funded before the signed deadline, deployAndRefund
// with the committed payload once refundAfter is reached with a balance, marks expiry, spends no
// gas when the call would revert, waits while executing would cost more than the tip (V6: the tip is the execution's
// gas), and records each receipt's actual cost. A V6 follow-up of 2026-10-15: an execution the node refused, or an RPC
// that could not estimate a refund, leaves the job to the next tick (it was execute-failed, or refund-failed for good),
// and a transaction the node dropped sends the job back to the state it was sent from. No real chain, no funds.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, http, keccak256, parseAbiItem, parseTransaction, recoverTransactionAddress, toFunctionSelector, toHex, type Hex } from "viem";
import { DROP_AFTER_MS } from "../src/sender";
import { VOUCHER, vouched } from "./vouch";
import { privateKeyToAccount } from "viem/accounts";
import { LAPSE_AFTER_SECONDS, SwapExecutor, SwapJobError, TERMINAL, factoryAbi, loadEscrowCreationCode, type SwapJobRequest, MAX_REFUND_REVERTS, REFUND_RETRY_SECONDS, EXECUTE_MARGIN_SECONDS, MAX_CALLDATA_BYTES, toEngineParams } from "../src/swapExecutor";
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
let balanceDownFor: string | null = null; // an escrow whose balance cannot be read (the audit's unverified m08)
let revertError: { code: number; message: string; data?: string } = { code: 3, message: "execution reverted: BadSignature()" };
// the escrow's code and its `executed()` (a V6 follow-up of 2026-10-16, audit c08/c30: a copy of the executor's call can land first)
let escrowCode: Hex = "0x";
let escrowExecuted = false;
const SEL_EXECUTED = toFunctionSelector("executed()");
// the transaction that executed an escrow first, as its Executed event names it (audit round 2, r01); null: no such log
let copyTx: Hex | null = null;
const EXECUTED_EVENT = parseAbiItem("event Executed(address indexed provider, uint256 value, bytes32 calldataHash, address executor)");
// a token the escrow holds that is not the order's (audit round 2, r00): its balanceOf answers `foreignBalance`
const FOREIGN = "0x00000000000000000000000000000000000f0e19";
let foreignBalance = 0n;
const SEL_BALANCE_OF = toFunctionSelector("balanceOf(address)");
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
    case "eth_getBalance": return balanceDownFor && String(req.params[0]).toLowerCase() === balanceDownFor ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } } : res(toHex(escrowBalance));
    case "eth_getCode": return res(escrowCode);
    case "eth_getLogs": {
      const f = req.params[0] ?? {};
      if (!copyTx) return res([]);
      const topics = encodeEventTopics({ abi: [EXECUTED_EVENT], eventName: "Executed", args: { provider: "0x00000000000000000000000000000000000000ad" } });
      const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "address" }], [1n, ("0x" + "00".repeat(32)) as Hex, "0x00000000000000000000000000000000000000c0"]);
      return res([{ address: f.address, topics, data, blockNumber: "0x10", blockHash: "0x" + "11".repeat(32), transactionHash: copyTx, transactionIndex: "0x0", logIndex: "0x0", removed: false }]);
    }
    case "eth_call":
      if (String(req.params[0]?.data ?? req.params[0]?.input ?? "").startsWith(SEL_EXECUTED)) return res("0x" + (escrowExecuted ? "1" : "0").padStart(64, "0"));
      if (String(req.params[0]?.to ?? "").toLowerCase() === FOREIGN && String(req.params[0]?.data ?? req.params[0]?.input ?? "").startsWith(SEL_BALANCE_OF)) return res(toHex(foreignBalance, { size: 32 }));
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "mock rpc: eth_call unsupported" } };
    case "eth_estimateGas": return estimateDown ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } } : revertSimulation ? { jsonrpc: "2.0", id: req.id, error: revertError } : res("0x7a120");
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
  executor = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher: VOUCHER, account, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }), now: () => clock, lateRefundWatchSeconds: 0 });
  // a job for the vector's order, re-signed by a key we hold (the vector's signer key is forge's)
  const refundNoteData = ("0x" + "cd".repeat(169)) as Hex;
  const params = { ...vector.params, orderSigner: orderSignerAddress(ORDER_KEY), refundNoteDataHash: keccak256(refundNoteData) };
  const escrow = predictEscrow(vector.factory, creationCode, { ...params, assetType: 0, amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip) });
  const providerCalldata = ("0x" + "ab".repeat(40)) as Hex;
  const digest = executionDigest(BigInt(CHAIN_ID), escrow, params.orderId, vector.execution.provider, BigInt(vector.execution.value), providerCalldata, Number(vector.execution.deadline));
  request = vouched({ factory: vector.factory, params, execution: { provider: vector.execution.provider, value: vector.execution.value, providerCalldata, deadline: Number(vector.execution.deadline), signature: signExecution(ORDER_KEY, digest) }, refundNoteData }, CHAIN_ID, creationCode);
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
  it("admits orders for the factory it serves only, and none without one: no other contract is ever called (2026-10-15)", () => {
    // before, a request's own "factory" was called with deployAndExecute and deployAndRefund at the relayer's gas
    const code = (f: () => unknown) => { try { f(); return "admitted"; } catch (e) { return (e as SwapJobError).code; } };
    const theirs = "0x00000000000000000000000000000000000000ba" as Hex;
    // an order of their own, signed for the escrow their factory predicts: the old executor admitted it, then called it
    const params = { ...request.params, orderId: ("0x" + "bb".repeat(32)) as Hex };
    const escrow = predictEscrow(theirs, creationCode, { ...params, assetType: 0, amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, params.orderId, request.execution.provider, BigInt(request.execution.value), request.execution.providerCalldata, request.execution.deadline);
    expect(code(() => executor.add({ ...request, factory: theirs, params, execution: { ...request.execution, signature: signExecution(ORDER_KEY, digest) } }))).toBe("unknown_swap_factory");
    expect(code(() => executor.addRefund({ factory: theirs, params: request.params, refundNoteData: request.refundNoteData }))).toBe("unknown_swap_factory");
    const offline = { account: privateKeyToAccount(RELAYER_KEY), publicClient: {} as never, walletClient: {} as never, now: () => 1000 }; // the vector's own time
    const mine = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher: VOUCHER, ...offline });
    expect(code(() => mine.add({ ...request, factory: vector.factory.toUpperCase().replace("0X", "0x") }))).toBe("admitted"); // its own, in any case
    const none = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, ...offline });
    expect(code(() => none.add(request))).toBe("swap_unavailable");
    expect(code(() => none.addRefund({ factory: request.factory, params: request.params, refundNoteData: request.refundNoteData }))).toBe("swap_unavailable");
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
    const job = executor.add(vouched(late, CHAIN_ID, creationCode));
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
    const job = executor.add(vouched(bad, CHAIN_ID, creationCode));
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
    const job = executor.add(vouched(dear, CHAIN_ID, creationCode));
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
    return vouched(o, CHAIN_ID, creationCode);
  };

  it("a call with fewer than EXECUTE_MARGIN_SECONDS left is refused, never admitted only to expire unsent (audit round 2, r02)", () => {
    // a 60-s LI.FI call that reached the relayer 25 s after its prepare was admitted, expired at the first pass, and the
    // wallet only tracked it: the funded escrow waited for refundAfter, its fee note and tip lost
    const code = (r: SwapJobRequest) => { try { return executor.add(r).state; } catch (e) { return (e as SwapJobError).code; } };
    try {
      clock = Number(request.execution.deadline) - EXECUTE_MARGIN_SECONDS + 1;
      expect(code(order(0x36))).toBe("deadline_too_close");
      expect(executor.get(toHex(0x36, { size: 32 })), "no job").toBeUndefined();
      clock = Number(request.execution.deadline) + 5; // past it: refused too, never held as expired
      expect(code(order(0x38))).toBe("deadline_too_close");
      clock = Number(request.execution.deadline) - EXECUTE_MARGIN_SECONDS;
      expect(code(order(0x37)), "the margin left: admitted").toBe("waiting-funding");
    } finally {
      clock = 1000;
    }
  });

  it("funded in the last blocks before its signed deadline: never sent, expired (the audit's unverified m10)", async () => {
    clock = 1000; escrowBalance = 0n;
    const job = executor.add(order(0x34));
    await executor.tick();
    expect(job.state).toBe("waiting-funding");
    escrowBalance = BigInt(request.params.amount);
    clock = Number(request.execution.deadline) - EXECUTE_MARGIN_SECONDS + 1; // funded with less than the margin left
    const sent = raws.length;
    await executor.tick();
    expect(raws.length, "an execution mined after the deadline would revert at the relayer's gas").toBe(sent);
    expect(job.state).toBe("expired");
  });

  it("one escrow that cannot be read is its job's tick, never the pass's: the next job is executed all the same (the audit's unverified m08)", async () => {
    clock = 1000; escrowBalance = BigInt(request.params.amount);
    const a = executor.add(order(0x31)), b = executor.add(order(0x32));
    balanceDownFor = a.escrow.toLowerCase();
    try {
      await executor.tick();
    } finally {
      balanceDownFor = null;
    }
    expect(a.error).toMatch(/^could not read the escrow: .*; read again next tick$/);
    expect(b.state, "the job after it").toBe("executing");
  });

  it("a refund that reverts is tried again later, and only the third is final (the audit's unverified m07)", async () => {
    clock = 1000; escrowBalance = 0n;
    const job = executor.add(order(0x33));
    clock = 1202;
    await executor.tick();
    expect(job.state).toBe("expired");
    escrowBalance = BigInt(request.params.amount); // funded late
    clock = 7201;
    revertSimulation = true;
    try {
      await executor.tick();
      expect(job.state, "a refund that would revert: not final").toBe("expired");
      expect(job.error).toMatch(/^would revert: .*; tried again in 10 min$/);
      const sent = raws.length;
      clock = 7201 + REFUND_RETRY_SECONDS - 1;
      await executor.tick();
      expect(raws.length, "not before REFUND_RETRY_SECONDS").toBe(sent);
    } finally {
      revertSimulation = false;
    }
    clock = 7201 + REFUND_RETRY_SECONDS;
    await executor.tick();
    expect(job.state).toBe("refunding");
    receiptStatus = "0x0"; // the refund is mined and reverts (a token paused between the estimate and the block)
    try {
      await executor.tick();
    } finally {
      receiptStatus = null;
    }
    expect(job.state, "a mined revert goes back to the state it was sent from").toBe("expired");
    expect(job.error).toMatch(/reverted; tried again in 10 min$/);
    clock += REFUND_RETRY_SECONDS;
    await executor.tick();
    expect(job.state).toBe("refunding");
    receiptStatus = "0x0";
    try {
      await executor.tick();
    } finally {
      receiptStatus = null;
    }
    expect(job.state, `the ${MAX_REFUND_REVERTS}rd revert is final`).toBe("refund-failed");
  });

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

describe("the refund vault is the pool's own (a V6 follow-up of 2026-10-15)", () => {
  const CORE = "0x00000000000000000000000000000000000000c0" as Hex;
  const VAULTS = "0x00000000000000000000000000000000000000f5" as Hex;
  const ETH_VAULT = "0x00000000000000000000000000000000000000e7" as Hex;
  const USDC = "0x00000000000000000000000000000000000000a5" as Hex;
  const USDC_VAULT = "0x00000000000000000000000000000000000000a6" as Hex;
  const reads: string[] = [];
  const chain = {
    readContract: async ({ address, functionName, args }: { address: Hex; functionName: string; args?: [Hex] }) => {
      reads.push(functionName);
      if (address === CORE && functionName === "VAULT_FACTORY") return VAULTS;
      if (address === VAULTS && functionName === "vaultOf") return ({ [ZERO]: ETH_VAULT, [USDC]: USDC_VAULT } as Record<string, Hex>)[args![0].toLowerCase()] ?? ZERO;
      throw new Error(`unexpected read ${functionName} at ${address}`);
    },
  };
  const ZERO = "0x0000000000000000000000000000000000000000";
  const at = (over: Partial<SwapJobRequest["params"]>) => ({ params: { ...request.params, ...over } });
  const verdict = (x: SwapExecutor, r: { params: SwapJobRequest["params"] }) =>
    x.admissible(r).then(
      () => "admitted",
      (e: SwapJobError) => e.code,
    );

  it("admits an order refunding into its pool's vault for its asset, refuses any other vault and an asset the pool has none for", async () => {
    const x = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, core: CORE, account: privateKeyToAccount(RELAYER_KEY), publicClient: chain as never, walletClient: {} as never });
    expect(await verdict(x, at({ assetType: 0, asset: ZERO as Hex, refundVault: ETH_VAULT }))).toBe("admitted");
    expect(await verdict(x, at({ assetType: 1, asset: USDC, refundVault: USDC_VAULT }))).toBe("admitted");
    // before, the escrow's refund deposited into whatever vault the order named, at the relayer's gas
    expect(await verdict(x, at({ assetType: 0, asset: ZERO as Hex, refundVault: "0x00000000000000000000000000000000000000ba" }))).toBe("bad_refund_vault");
    expect(await verdict(x, at({ assetType: 1, asset: USDC, refundVault: ETH_VAULT }))).toBe("bad_refund_vault");
    expect(await verdict(x, at({ assetType: 1, asset: "0x00000000000000000000000000000000000000b7", refundVault: USDC_VAULT }))).toBe("bad_refund_vault");
    expect(reads.filter((r) => r === "VAULT_FACTORY"), "the pool's vault factory is read once").toHaveLength(1);
  });

  it("the server reads it before it admits an execution or a refund", () => {
    const server = readFileSync(join(root, "apps/relayer/src/server.ts"), "utf8");
    // the review round of 2026-11-03 (F1): the server admits through admitExecution / admitRefund, which read the vault first
    // (admissible), answer a job the executor has whatever the cap, and refuse a new one at capacity unless its escrow holds the order
    for (const admit of ["executor.admitExecution(", "executor.admitRefund("]) expect(server.indexOf(admit), admit).toBeGreaterThan(0);
    expect(server, "the cap is the executor's to apply, after the lookup").not.toMatch(/openSwapJobs\(\) >= MAX_SWAP_JOBS\) return send\(503/);
    const source = readFileSync(join(root, "apps/relayer/src/swapExecutor.ts"), "utf8");
    const admitWith = source.slice(source.indexOf("private async admitWith("));
    expect(admitWith.indexOf("await this.admissible(req)"), "the vault read first").toBeLessThan(admitWith.indexOf("return add()"));
    expect(server).toMatch(/core: cfg\.core/);
  });
});

describe("only what the swap service vouched for (a V6 follow-up of 2026-10-16, audit gap 47)", () => {
  const code = (f: () => unknown) => {
    try {
      f();
      return "admitted";
    } catch (e) {
      return (e as SwapJobError).code;
    }
  };
  const offline = { account: privateKeyToAccount(RELAYER_KEY), publicClient: {} as never, walletClient: {} as never, now: () => 1000 }; // the vector's own time
  const fresh = () => new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher: VOUCHER, ...offline });
  const another = new Uint8Array(32).fill(0x5b);

  it("executes a call the API vouched for, never one without its vouch, with another key's, or vouched for another call", () => {
    const x = fresh();
    const bare: SwapJobRequest = { ...request, vouch: undefined };
    expect(code(() => x.add(bare)), "no vouch: an order of anyone's own").toBe("unvouched_order");
    expect(code(() => x.add(vouched(bare, CHAIN_ID, creationCode, another))), "another key's").toBe("unvouched_order");
    // the order key re-signs another call (its own provider call) and keeps the vouch the API gave the first
    const escrow = predictEscrow(vector.factory, creationCode, { ...request.params, assetType: 0, amount: BigInt(request.params.amount), refundOwnerCommitment: BigInt(request.params.refundOwnerCommitment), refundNoteSecret: BigInt(request.params.refundNoteSecret), executorTip: BigInt(request.params.executorTip) });
    const theirs = ("0x" + "cd".repeat(40)) as Hex;
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, request.params.orderId, request.execution.provider, BigInt(request.execution.value), theirs, request.execution.deadline);
    expect(code(() => x.add({ ...request, execution: { ...request.execution, providerCalldata: theirs, signature: signExecution(ORDER_KEY, digest) } })), "a vouch for another call").toBe("unvouched_order");
    expect(code(() => x.add({ ...request, vouch: { order: vouched({ factory: request.factory, params: request.params, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode).vouch!.order } })), "an order's vouch is no call's").toBe("unvouched_order");
    expect(x.list(), "nothing admitted").toHaveLength(0);
    expect(code(() => x.add(request))).toBe("admitted");
  });

  it("refunds an order the API vouched for, never one without its vouch or with a call's in its place", () => {
    const x = fresh();
    const refund = { factory: request.factory, params: request.params, refundNoteData: request.refundNoteData };
    expect(code(() => x.addRefund(refund)), "no vouch: a zero tip of anyone's own, at about 3.45M gas a refund").toBe("unvouched_order");
    expect(code(() => x.addRefund(vouched(refund, CHAIN_ID, creationCode, another)))).toBe("unvouched_order");
    expect(code(() => x.addRefund({ ...refund, vouch: { execution: request.vouch!.execution } })), "a call's vouch is no order's").toBe("unvouched_order");
    expect(code(() => x.addRefund(vouched(refund, CHAIN_ID, creationCode)))).toBe("admitted");
  });

  it("an executor without the API's address admits nothing; the server answers 503 without it", () => {
    const blind = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, ...offline });
    expect(code(() => blind.add(request))).toBe("swap_unavailable");
    const server = readFileSync(join(root, "apps/relayer/src/server.ts"), "utf8");
    expect(server).toMatch(/const swapsRun = swapFactory !== null && apiVoucher !== null;/);
    expect(server.match(/if \(!swapsRun\) return send\(503/g), "both swap routes").toHaveLength(2);
    expect(server).toMatch(/voucher: apiVoucher/);
  });
});

describe("a never-executed order is refunded only when its escrow pays the tip (a V6 follow-up of 2026-10-16)", () => {
  it("an escrow holding less than its tip is left alone (the escrow would pay no tip); holding the tip, it is refunded", async () => {
    // _payTip pays nothing below the tip: one wei at a vouched escrow had cost the relayer a 3.45M-gas deployAndRefund for nothing
    const dust: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + "0d".repeat(32)) as Hex } };
    const escrow = predictEscrow(dust.factory, creationCode, { ...dust.params, assetType: 0, amount: BigInt(dust.params.amount), refundOwnerCommitment: BigInt(dust.params.refundOwnerCommitment), refundNoteSecret: BigInt(dust.params.refundNoteSecret), executorTip: BigInt(dust.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, dust.params.orderId, dust.execution.provider, BigInt(dust.execution.value), dust.execution.providerCalldata, dust.execution.deadline);
    dust.execution = { ...dust.execution, signature: signExecution(ORDER_KEY, digest) };
    clock = 1000; escrowBalance = 0n; receiptStatus = null;
    const job = executor.add(vouched(dust, CHAIN_ID, creationCode));
    clock = 8000; // past refundAfter (7201), never executed
    escrowBalance = BigInt(dust.params.executorTip) - 1n;
    await executor.tick();
    expect(job.state, "no refund for less than the tip").not.toBe("refunding");
    expect(job.txHash).toBeUndefined();
    expect(job.error).toMatch(/less than the order's .* tip/);
    escrowBalance = BigInt(dust.params.executorTip);
    await executor.tick();
    expect(job.state).toBe("refunding");
    const sent = parseTransaction(raws.find((r) => keccak256(r) === job.txHash)!);
    expect(decodeFunctionData({ abi: factoryAbi, data: sent.data! }).functionName).toBe("deployAndRefund");
  });
});

describe("the escrow's own fate (a V6 follow-up of 2026-10-16, audit c07/c08/c30)", () => {
  /** A request for a fresh order of the vector (its own orderId and escrow), signed and vouched. */
  const fresh = (byte: string): SwapJobRequest => {
    const r: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + byte.repeat(32)) as Hex } };
    const escrow = predictEscrow(r.factory, creationCode, { ...r.params, assetType: 0, amount: BigInt(r.params.amount), refundOwnerCommitment: BigInt(r.params.refundOwnerCommitment), refundNoteSecret: BigInt(r.params.refundNoteSecret), executorTip: BigInt(r.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, r.params.orderId, r.execution.provider, BigInt(r.execution.value), r.execution.providerCalldata, r.execution.deadline);
    r.execution = { ...r.execution, signature: signExecution(ORDER_KEY, digest) };
    return vouched(r, CHAIN_ID, creationCode);
  };
  const reset = () => {
    escrowCode = "0x"; escrowExecuted = false; revertSimulation = false; receiptStatus = null; escrowBalance = 0n; foreignBalance = 0n; copyTx = null; clock = 1000;
  };
  // an executor of its own on the same chain: the mocked escrow answers for every address, and the shared executor's jobs
  // must not see it
  let own: SwapExecutor;
  beforeEach(() => {
    own = new SwapExecutor({ ...executor.cfg });
  });

  it("a copy of the executor's call landed first: our reverted execution leaves the order executed, never execute-failed", async () => {
    try {
      clock = 1000; escrowBalance = 0n; receiptStatus = null;
      const job = own.add(fresh("c1"));
      escrowBalance = BigInt(job.params.amount);
      await own.tick();
      expect(job.state).toBe("executing");
      // the copy executed the escrow; ours reverted (AlreadyExecuted)
      const ours = job.txHash;
      escrowCode = "0x6080"; escrowExecuted = true; escrowBalance = 0n; receiptStatus = "0x0"; copyTx = ("0x" + "c0".repeat(32)) as Hex;
      await own.tick();
      expect(job.state).toBe("executed");
      expect(job.executed).toBe(true);
      expect(job.error).toMatch(/another transaction/);
      // the execution is the copy's, never ours that reverted (audit round 2, r01): the wallet tracks the provider by it
      expect(job.executionTx).toBe(copyTx);
      expect(job.executionTx).not.toBe(ours);
    } finally {
      reset();
    }
  });

  it("an execution whose estimate reverts because the escrow was executed already: executed too", async () => {
    try {
      clock = 1000; escrowBalance = 0n;
      const job = own.add(fresh("c2"));
      escrowBalance = BigInt(job.params.amount);
      escrowCode = "0x6080"; escrowExecuted = true; revertSimulation = true;
      await own.tick();
      expect(job.state).toBe("executed");
      expect(job.executed).toBe(true);
      expect(job.executionTx, "no Executed log found: unknown, never a hash of ours (audit round 2, r01)").toBeUndefined();
    } finally {
      reset();
    }
  });

  it("an order never funded ends a day past its window: lapsed, no longer read nor open; a refund-only request reopens it", async () => {
    try {
      clock = 1000; escrowBalance = 0n;
      const job = own.add(fresh("c3"));
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS - 1;
      await own.tick();
      expect(job.state, "a day not yet past its window").not.toBe("lapsed");
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS;
      await own.tick();
      expect(job.state).toBe("lapsed");
      expect(TERMINAL).toContain("lapsed");
      // a funding that lands after all: the wallet's refund-only request re-opens the job
      const again = own.addRefund(vouched({ factory: request.factory, params: job.params, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode));
      expect(again.state).toBe("refund-only");
    } finally {
      reset();
    }
  });

  it("dust below its tip at an escrow never funded ends a day past its window too: lapsed, never refunded (audit round 2, r00)", async () => {
    // one wei at each of many vouched escrows, refund-only jobs asked for at no cost: refundOwn waits for the tip, and the jobs
    // had stayed open for good, until they filled MAX_SWAP_JOBS and every hand-over and Return funds was refused
    try {
      clock = 1000; escrowBalance = 0n;
      const r = fresh("c6");
      const job = own.addRefund(vouched({ factory: r.factory, params: r.params, refundNoteData: r.refundNoteData }, CHAIN_ID, creationCode));
      escrowBalance = 1n;
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS - 1;
      await own.tick();
      expect(job.state, "a day not yet past its window").toBe("refund-only");
      expect(job.error).toMatch(/less than the order's .* tip/);
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS;
      await own.tick();
      expect(job.state).toBe("lapsed");
      expect(job.txHash, "nothing sent at the relayer's gas").toBeUndefined();
      expect(job.error).toMatch(/would be paid by its tip; anyone can still call deployAndRefund/);
    } finally {
      reset();
    }
  });

  it("a listed foreign token at an escrow never deployed does not keep a never-executed job open either (audit round 2, r00)", async () => {
    // the cheaper variant: a listed token contract whose balanceOf answers non-zero had blocked the lapse with no transfer at all
    try {
      clock = 1000; escrowBalance = 0n; foreignBalance = 5n;
      const r = fresh("c7");
      const job = own.addRefund(vouched({ factory: r.factory, params: r.params, refundNoteData: r.refundNoteData, refundTokens: [FOREIGN] }, CHAIN_ID, creationCode));
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS;
      await own.tick();
      expect(job.state).toBe("lapsed");
      expect(job.txHash).toBeUndefined();
      expect(job.error).toMatch(/only other tokens/);
    } finally {
      reset();
    }
  });

  it("an escrow that holds something a day past its window is refunded, never lapsed", async () => {
    try {
      clock = 1000; escrowBalance = 0n;
      const job = own.add(fresh("c4"));
      escrowBalance = BigInt(job.params.amount);
      clock = Number(job.params.refundAfter) + LAPSE_AFTER_SECONDS + 10;
      await own.tick();
      expect(job.state).toBe("refunding");
    } finally {
      reset();
    }
  });
});

describe("a refund a few seconds before the chain's clock reaches refundAfter (a V6 follow-up of 2026-10-16)", () => {
  it("a refund payload that holds TooEarlyToRefund's four bytes is not read as early when it reverts for its own reason: the revert counts (audit round 2, n03)", async () => {
    // the node's message echoes the call's calldata, the payload in it: the selector anywhere in the words had read "too early"
    const selector = toFunctionSelector("TooEarlyToRefund()").slice(2);
    const noteData = ("0x" + "cd".repeat(40) + selector + "cd".repeat(125)) as Hex;
    const params = { ...request.params, orderId: ("0x" + "0f".repeat(32)) as Hex, refundNoteDataHash: keccak256(noteData) };
    const escrow = predictEscrow(request.factory, creationCode, { ...params, assetType: 0, amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, params.orderId, request.execution.provider, BigInt(request.execution.value), request.execution.providerCalldata, request.execution.deadline);
    const late: SwapJobRequest = { ...request, params, refundNoteData: noteData, execution: { ...request.execution, signature: signExecution(ORDER_KEY, digest) } };
    clock = 1000; escrowBalance = 0n; receiptStatus = null;
    const job = executor.add(vouched(late, CHAIN_ID, creationCode));
    escrowBalance = BigInt(late.params.amount);
    clock = Number(late.params.refundAfter) + 60;
    const saved = revertError;
    revertError = { code: 3, message: "execution reverted" };
    revertSimulation = true;
    try {
      await executor.tick();
      expect(job.error, "a revert of its own reason, counted").toMatch(/would revert/);
      expect(job.error).not.toMatch(/has not reached refundAfter yet/);
      expect(job.refundReverts).toBe(1);
    } finally {
      revertSimulation = false;
      revertError = saved;
    }
  });

  it("is tried again next tick, never taken as its fate: the job is not refund-failed, and the refund goes once the chain is there", async () => {
    // the executor goes by its own clock and the latest block can be seconds behind: the estimate reverts TooEarlyToRefund, as a
    // node answers a custom error (generic words, the selector in the data). That revert had made the job refund-failed for good
    const early: SwapJobRequest = { ...request, params: { ...request.params, orderId: ("0x" + "0e".repeat(32)) as Hex } };
    const escrow = predictEscrow(early.factory, creationCode, { ...early.params, assetType: 0, amount: BigInt(early.params.amount), refundOwnerCommitment: BigInt(early.params.refundOwnerCommitment), refundNoteSecret: BigInt(early.params.refundNoteSecret), executorTip: BigInt(early.params.executorTip) });
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, early.params.orderId, early.execution.provider, BigInt(early.execution.value), early.execution.providerCalldata, early.execution.deadline);
    early.execution = { ...early.execution, signature: signExecution(ORDER_KEY, digest) };
    clock = 1000; escrowBalance = 0n; receiptStatus = null;
    const job = executor.add(vouched(early, CHAIN_ID, creationCode));
    escrowBalance = BigInt(early.params.amount);
    clock = Number(early.params.refundAfter) + 2; // this machine is 2 s past refundAfter, the latest block not yet
    const saved = revertError;
    revertError = { code: 3, message: "execution reverted", data: toFunctionSelector("TooEarlyToRefund()") };
    revertSimulation = true;
    try {
      await executor.tick();
      expect(job.state, "never refund-failed for a few seconds' difference in clocks").not.toBe("refund-failed");
      expect(job.txHash).toBeUndefined();
      expect(job.error).toMatch(/has not reached refundAfter yet; retried next tick/);
      revertSimulation = false;
      await executor.tick();
      expect(job.state).toBe("refunding");
    } finally {
      revertSimulation = false;
      revertError = saved;
    }
  });
});

describe("a rotation of the swap service's key (a V6 follow-up of 2026-10-16)", () => {
  it("a vouch by the former key counts while both are listed, and no longer once only the new one is", () => {
    const former = new Uint8Array(32).fill(0x5d);
    const formerAddress = orderSignerAddress(former);
    const offline = { account: privateKeyToAccount(RELAYER_KEY), publicClient: {} as never, walletClient: {} as never, now: () => 1000 }; // the vector's own time
    const executorFor = (voucher: Hex | Hex[]) => new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher, ...offline });
    const refund = vouched({ factory: request.factory, params: request.params, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode, former);
    const code = (x: SwapExecutor) => {
      try {
        x.addRefund(refund);
        return "admitted";
      } catch (e) {
        return (e as SwapJobError).code;
      }
    };
    expect(code(executorFor([VOUCHER as Hex, formerAddress]))).toBe("admitted");
    expect(code(executorFor(VOUCHER as Hex))).toBe("unvouched_order");
    expect(code(executorFor([])), "an empty list: no swaps").toBe("swap_unavailable");
  });
});

// runs last: its jobs stay in the shared executor, which the suites above count
describe("admission under the cap (the review round of 2026-11-03, F1) and what a job keeps (F2, F4)", () => {
  /** another order of the vector's shape, re-signed by the key we hold and vouched */
  const another = (orderId: Hex) => {
    const params = { ...request.params, orderId };
    const escrow = predictEscrow(vector.factory, creationCode, toEngineParams(params));
    const digest = executionDigest(BigInt(CHAIN_ID), escrow, params.orderId, request.execution.provider, BigInt(request.execution.value), request.execution.providerCalldata, request.execution.deadline);
    return vouched({ factory: vector.factory, params, execution: { ...request.execution, signature: signExecution(ORDER_KEY, digest) }, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode);
  };
  it("at capacity a job the executor already has is answered, a new unfunded one is refused 'capacity', and a new one whose escrow already holds the order is admitted: a funded hand-over or a Return funds the cap never refuses", async () => {
    clock = 1000;
    escrowBalance = 0n;
    const have = executor.add(request);
    expect(await executor.admitExecution(request, { full: true }), "known: answered whatever the cap").toBe(have);
    const fresh = another(("0x" + "c1".repeat(32)) as Hex);
    await expect(executor.admitExecution(fresh, { full: true })).rejects.toMatchObject({ code: "capacity" });
    expect(executor.list().some((j) => j.id === fresh.params.orderId.toLowerCase()), "nothing admitted").toBe(false);
    escrowBalance = BigInt(fresh.params.amount);
    expect((await executor.admitExecution(fresh, { full: true })).id, "funded: admitted at capacity").toBe(fresh.params.orderId.toLowerCase());
    const refundOf = another(("0x" + "c2".repeat(32)) as Hex);
    const refund = vouched({ factory: vector.factory, params: refundOf.params, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode);
    escrowBalance = 0n;
    await expect(executor.admitRefund(refund, { full: true })).rejects.toMatchObject({ code: "capacity" });
    escrowBalance = BigInt(refund.params.amount);
    expect((await executor.admitRefund(refund, { full: true })).state, "a funded escrow's Return funds").toBe("refund-only");
    const below = another(("0x" + "c5".repeat(32)) as Hex);
    escrowBalance = 0n;
    expect((await executor.admitExecution(below, { full: false })).id, "below the cap: admitted outright").toBe(below.params.orderId.toLowerCase());
  });
  it("a job keeps the fields it needs, nothing else a request carried; calldata over the cap and malformed shapes are refused before the vouch is read (F2, F4)", () => {
    const junk = another(("0x" + "c3".repeat(32)) as Hex);
    const job = executor.add({ ...junk, params: { ...junk.params, junk: "A".repeat(10_000) } as never, execution: { ...junk.execution, extra: "B".repeat(10_000) } as never });
    expect(Object.keys(job.params).sort()).toEqual(
      ["amount", "asset", "assetType", "executeDeadline", "executorTip", "orderId", "orderSigner", "refundAfter", "refundNoteDataHash", "refundNoteSecret", "refundVault", "refundOwnerCommitment"].sort(),
    );
    expect(Object.keys(job.execution!).sort()).toEqual(["deadline", "provider", "providerCalldata", "signature", "value"]);
    const code = (f: () => unknown) => { try { f(); return "admitted"; } catch (e) { return (e as SwapJobError).code; } };
    const big = another(("0x" + "c4".repeat(32)) as Hex);
    expect(code(() => executor.add({ ...big, execution: { ...big.execution, providerCalldata: ("0x" + "ab".repeat(MAX_CALLDATA_BYTES + 1)) as Hex } }))).toBe("bad_execution");
    const refund = vouched({ factory: vector.factory, params: request.params, refundNoteData: request.refundNoteData }, CHAIN_ID, creationCode);
    expect(code(() => executor.addRefund({ ...refund, params: { ...refund.params, orderSigner: "123" as Hex } })), "a signer that is no address").toBe("bad_request");
    expect(code(() => executor.addRefund({ ...refund, params: { ...refund.params, orderId: ("0x" + "aa".repeat(31)) as Hex } })), "a 31-byte id").toBe("bad_request");
    expect(code(() => executor.addRefund({ ...refund, params: { ...refund.params, amount: "1e18" } })), "an amount that is no base-unit integer").toBe("bad_request");
  });
});
