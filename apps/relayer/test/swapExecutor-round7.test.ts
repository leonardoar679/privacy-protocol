// The swap executor under the seventh review round (2026-11-03): order integers past a uint256 refused (they had aliased a vouched
// escrow, and one such job aborted every pass); one job's failure is that job's tick; a funded hand-over goes first and is checked
// against the clock of its send; a Return funds answered during a pass is not overtaken by the execution the pass had read; a foreign
// token's refund does not end the job with the order's own funding inside; a Return funds reopens an executed order refunded once; a
// hand-over's own refund tokens win over those of a refund-only request. A mock chain; no funds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, parseTransaction, toFunctionSelector, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryJournal } from "../src/journal";
import { SwapExecutor, SwapJobError, factoryAbi, loadEscrowCreationCode, type SwapJob, type SwapJobRequest } from "../src/swapExecutor";
import { executionDigest, orderSignerAddress, predictEscrow, signExecution } from "@privacy-wallet/swap-engine/endpoints";
import { VOUCHER, vouched } from "./vouch";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vector = JSON.parse(readFileSync(join(root, "contracts/test/periphery/vectors/endpoint.json"), "utf8"));
const creationCode = loadEscrowCreationCode();
const CHAIN_ID = Number(vector.chainId);
const account = privateKeyToAccount(("0x" + "7d".repeat(32)) as Hex);
const ORDER_KEY = new Uint8Array(32).fill(0xc9);

const raws: Hex[] = [];
let ethBalance = 0n;
let escrowCode = "0x";
let receiptStatus: "0x1" | "0x0" | null = null;
let estimateDelayMs = 0;
let balanceDelayMs = 0;
let ethBalanceFor: Record<string, bigint> | null = null;
const tokenBalances: Record<string, bigint> = {};
const selBalanceOf = toFunctionSelector("balanceOf(address)");
const selVaultOf = toFunctionSelector("vaultOf(address)"), selCore = toFunctionSelector("core()"), selVaultFactory = toFunctionSelector("VAULT_FACTORY()");
const word = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const block = {
  number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32),
  miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0",
  timestamp: "0x3e8", transactions: [], uncles: [], baseFeePerGas: "0x3b9aca00",
};
async function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res(toHex(CHAIN_ID));
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_gasPrice": return res("0x3b9aca00");
    case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_getTransactionCount": return res("0x1");
    case "eth_getBalance":
      if (balanceDelayMs) await new Promise((r) => setTimeout(r, balanceDelayMs));
      return res(toHex(ethBalanceFor ? (ethBalanceFor[String(req.params[0]).toLowerCase()] ?? 0n) : ethBalance));
    case "eth_getCode": return res(escrowCode);
    case "eth_call": {
      const { to, data } = req.params[0];
      if (String(data).startsWith(selCore)) return res(word("0x00000000000000000000000000000000000c0be0"));
      if (String(data).startsWith(selVaultFactory)) return res(word("0x00000000000000000000000000000000000fac70"));
      if (String(data).startsWith(selVaultOf)) return res(word("0x00000000000000000000000000000000000ba017"));
      if (String(data).startsWith(selBalanceOf)) return res("0x" + (tokenBalances[String(to).toLowerCase()] ?? 0n).toString(16).padStart(64, "0"));
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
    }
    case "eth_estimateGas":
      if (estimateDelayMs) await new Promise((r) => setTimeout(r, estimateDelayMs));
      return res("0x7a120");
    case "eth_sendRawTransaction": raws.push(req.params[0]); return res(keccak256(req.params[0]));
    case "eth_getTransactionReceipt":
      return res(receiptStatus === null ? null : { transactionHash: req.params[0], status: receiptStatus, blockNumber: "0x11", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: account.address, to: vector.factory, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [], logsBloom: "0x" + "00".repeat(256), contractAddress: null, type: "0x2" });
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}
let server: Server;
let clients: { publicClient: any; walletClient: any };
let clock = 1000;
const DAY = 86400;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? await Promise.all(j.map(handle)) : await handle(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = { id: CHAIN_ID, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  clients = { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }) };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function makeRequest(orderId: Hex, deadline: number, over: Partial<SwapJobRequest["params"]> = {}): SwapJobRequest {
  const refundNoteData = ("0x" + "ee".repeat(169)) as Hex;
  const params = { ...vector.params, orderId, orderSigner: orderSignerAddress(ORDER_KEY), refundNoteDataHash: keccak256(refundNoteData), ...over };
  const escrow = predictEscrow(vector.factory, creationCode, {
    ...params,
    amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip),
    executeDeadline: Number(params.executeDeadline), refundAfter: Number(params.refundAfter), assetType: Number(params.assetType),
  } as never);
  const providerCalldata = ("0x" + "ab".repeat(40)) as Hex;
  const digest = executionDigest(BigInt(CHAIN_ID), escrow, orderId, vector.execution.provider, BigInt(vector.execution.value), providerCalldata, deadline);
  return vouched(
    { factory: vector.factory, params, execution: { provider: vector.execution.provider, value: vector.execution.value, providerCalldata, deadline, signature: signExecution(ORDER_KEY, digest) }, refundNoteData } as any,
    CHAIN_ID,
    creationCode,
  );
}
const refundOf = (req: SwapJobRequest, extra: object = {}) => vouched({ factory: req.factory, params: req.params, refundNoteData: req.refundNoteData, ...extra } as any, CHAIN_ID, creationCode);
const executorWith = (lateRefundWatchSeconds = 0, journal?: MemoryJournal<SwapJob>) =>
  new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher: VOUCHER, account, ...clients, now: () => clock, lateRefundWatchSeconds, lastCallSeconds: 0, ...(journal ? { journal } : {}) } as any);
const fnOf = (i: number) => decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[i]).data! }).functionName;
const reset = () => {
  raws.length = 0; ethBalance = 0n; escrowCode = "0x"; receiptStatus = null; estimateDelayMs = 0; balanceDelayMs = 0; ethBalanceFor = null;
  for (const k of Object.keys(tokenBalances)) delete tokenBalances[k];
  clock = 1000;
};

describe("order integers past a uint256 (the seventh review round, 2026-11-03)", () => {
  it("are refused at admission, for an execution and a refund alike — 78 digits reach past 2^256 and had aliased the vouched escrow", () => {
    reset();
    const ex = executorWith();
    const honest = makeRequest(("0x" + "94".repeat(32)) as Hex, 1500);
    const big = (x: string) => (BigInt(x) + (1n << 256n)).toString();
    for (const over of [{ amount: big(honest.params.amount) }, { executorTip: big(honest.params.executorTip) }, { refundOwnerCommitment: big(honest.params.refundOwnerCommitment) }, { refundNoteSecret: big(honest.params.refundNoteSecret) }]) {
      // the honest order's vouches with the poisoned params: before this round they verified for both
      const poisoned = { ...honest, params: { ...honest.params, ...over } };
      const poisonedRefund = { ...refundOf(honest), params: poisoned.params };
      expect(() => ex.add(poisoned as any), JSON.stringify(Object.keys(over))).toThrow(SwapJobError);
      expect(() => ex.addRefund(poisonedRefund as any), JSON.stringify(Object.keys(over))).toThrow(SwapJobError);
    }
    // the refund note's fields are field elements: a secret of p or more is refused, however short
    const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(() => ex.add({ ...honest, params: { ...honest.params, refundNoteSecret: p.toString() } } as any)).toThrow(/field elements/);
    // the escrow prediction itself refuses such a value instead of truncating it
    expect(() => predictEscrow(vector.factory, creationCode, { ...vector.params, amount: 1n << 256n, refundOwnerCommitment: 1n, refundNoteSecret: 1n, executorTip: 0n, executeDeadline: 1, refundAfter: 2, assetType: 0 } as never)).toThrow(RangeError);
    // the honest order is admitted, and a request for it with other params is refused rather than answered with the stored job
    const job = ex.add(honest);
    expect(job.state).toBe("waiting-funding");
    expect(() => ex.add({ ...honest, params: { ...honest.params, executorTip: (BigInt(honest.params.executorTip) + 1n).toString() } } as any)).toThrow();
    reset();
  });

  it("one job whose encoding throws is that job's tick: every other job is still acted on (a journaled job from an older build)", async () => {
    reset();
    const victim = makeRequest(("0x" + "96".repeat(32)) as Hex, 1500);
    const poisonedReq = makeRequest(("0x" + "95".repeat(32)) as Hex, 1500);
    const journal = new MemoryJournal<SwapJob>();
    // a job an older build admitted with an owner commitment past a uint256: its execution's encoding throws at every pass
    const poisoned: SwapJob = {
      id: poisonedReq.params.orderId.toLowerCase(), escrow: "0x00000000000000000000000000000000000e5c00" as Hex, factory: vector.factory,
      params: { ...poisonedReq.params, refundOwnerCommitment: (BigInt(poisonedReq.params.refundOwnerCommitment) + (1n << 256n)).toString() } as any,
      execution: poisonedReq.execution as any, refundNoteData: poisonedReq.refundNoteData, state: "waiting-funding", createdAt: 1, updatedAt: 1,
    };
    journal.save([poisoned]);
    const ex = executorWith(0, journal);
    const v = ex.add(victim);
    ethBalance = BigInt(victim.params.amount); // both escrows funded (one balance for every address)
    await expect(ex.tick()).resolves.toBeUndefined();
    expect(v.state, "the later job is executed").toBe("executing");
    expect(raws.length).toBe(1);
    expect(fnOf(0)).toBe("deployAndExecute");
    reset();
  });
});

describe("a pass and the requests that land during it (the seventh review round, 2026-11-03)", () => {
  it("a Return funds answered during a pass is not overtaken by the execution the pass had read: nothing is sent, the job stays refund-only", async () => {
    reset();
    const ex = executorWith();
    const req = makeRequest(("0x" + "91".repeat(32)) as Hex, 1500);
    const job = ex.add(req);
    ethBalance = BigInt(req.params.amount);
    estimateDelayMs = 300; // a slow node: the pass is inside the execution's gas estimate
    const running = ex.tick();
    await new Promise((r) => setTimeout(r, 100));
    const answered = ex.addRefund(refundOf(req));
    expect(answered.state).toBe("refund-only");
    await running;
    expect(raws.length, "no deployAndExecute after the Return funds").toBe(0);
    expect(job.state).toBe("refund-only");
    reset();
  });

  it("a funded hand-over goes before the open jobs' reads, and is sent inside its deadline", async () => {
    reset();
    const realNow = () => Math.floor(Date.now() / 1000);
    const ex = new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, factory: vector.factory, voucher: VOUCHER, account, ...clients, now: realNow, lateRefundWatchSeconds: 0, lastCallSeconds: 0 } as any);
    const base = realNow();
    const future = { executeDeadline: base + 3600, refundAfter: base + 7200 };
    for (let i = 0; i < 20; i++) ex.addRefund(refundOf(makeRequest(("0x" + i.toString(16).padStart(4, "0").repeat(16)) as Hex, base + 600, future as any)));
    const t0 = realNow();
    const real = makeRequest(("0x" + "98".repeat(32)) as Hex, t0 + 37, future as any); // a short-lived call
    const job = ex.add(real);
    ethBalanceFor = { [job.escrow.toLowerCase()]: BigInt(real.params.amount) };
    balanceDelayMs = 100; // a hosted endpoint under load
    const started = Date.now();
    let sentAfterMs = -1;
    const watch = setInterval(() => { if (sentAfterMs < 0 && raws.length) sentAfterMs = Date.now() - started; }, 5);
    await ex.tick();
    clearInterval(watch);
    expect(job.state).toBe("executing");
    expect(fnOf(0)).toBe("deployAndExecute");
    expect(sentAfterMs, "sent first, not after twenty slow reads").toBeLessThan(1500);
    reset();
  }, 60_000);
});

describe("refunds that end too early or never reopen (the seventh review round, 2026-11-03)", () => {
  it("a foreign token's refund returns the job to where it was: the order's own funding is refunded next", async () => {
    reset();
    const FOREIGN = "0x00000000000000000000000000000000000f0e19";
    const ex = executorWith();
    const req = makeRequest(("0x" + "92".repeat(32)) as Hex, 1500);
    const job = ex.addRefund(refundOf(req, { refundTokens: [FOREIGN], refundFloors: { [FOREIGN]: "1" } }));
    ethBalance = BigInt(req.params.amount); // the funding
    escrowCode = "0x6080"; // somebody deployed it (factory.deploy(p) is public)
    tokenBalances[FOREIGN] = 5n;
    clock = Number(req.params.refundAfter);
    await ex.tick();
    expect(job.state).toBe("refunding");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state, "back to where it was, not refunded").toBe("refund-only");
    receiptStatus = null; tokenBalances[FOREIGN] = 0n; raws.length = 0;
    await ex.tick();
    expect(raws.length, "the order's own funding is refunded").toBe(1);
    expect(fnOf(0)).toBe("deployAndRefund");
    expect(job.state).toBe("refunding");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("refunded");
    reset();
  });

  it("a Return funds reopens an executed order refunded once inside its watch, when a late refund arrives after it", async () => {
    reset();
    const ex = executorWith(DAY);
    const req = makeRequest(("0x" + "93".repeat(32)) as Hex, 1500);
    ethBalance = BigInt(req.params.amount);
    const job = ex.add(req);
    await ex.tick();
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("executed");
    receiptStatus = null; raws.length = 0; ethBalance = 0n;
    const after = Number(req.params.refundAfter);
    clock = after + 3600; ethBalance = 5n * 10n ** 16n; // a partial refund inside the watch
    await ex.tick();
    expect(job.state).toBe("refunding");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("refunded");
    receiptStatus = null; ethBalance = 0n; raws.length = 0;
    clock = after + DAY + 10; // the watch ends
    await ex.tick();
    clock = after + 3 * DAY; ethBalance = 4n * 10n ** 17n; // the rest, held by a chain halt
    const again = ex.addRefund(refundOf(req));
    expect(again.state, "reopened").toBe("refund-only");
    await ex.tick();
    expect(raws.length).toBe(1);
    expect(fnOf(0)).toBe("deployAndRefund");
    reset();
  });

  it("a hand-over's own refund tokens win over those a refund-only request listed first", () => {
    reset();
    const ex = executorWith();
    const req = makeRequest(("0x" + "97".repeat(32)) as Hex, 1500);
    const junk = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3", "0x00000000000000000000000000000000000000a4"];
    ex.addRefund(refundOf(req, { refundTokens: junk, refundFloors: Object.fromEntries(junk.map((t) => [t, "1"])) }));
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const job = ex.add({ ...req, refundTokens: [USDT], refundFloors: { [USDT]: "1000" } } as any);
    expect(job.state).toBe("waiting-funding");
    expect(job.refundTokens?.[0]?.toLowerCase()).toBe(USDT);
    expect(job.refundTokens?.length).toBe(4);
    reset();
  });
});
