// Executor: a re-signed execution replaces an expired one (fresh quote after the delay budget),
// ERC-20 escrows are watched through balanceOf, an ETH order paid back in WETH is still refunded, and
// both journals survive a restart (a new executor / relayer instance resumes the open jobs and keeps
// the in-flight nullifiers). Mock chain only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, parseTransaction, toFunctionSelector, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { utf8ToBytes } from "@noble/hashes/utils";
import { SwapExecutor, escrowAbi, factoryAbi, loadEscrowCreationCode, type SwapJob, type SwapJobRequest } from "../src/swapExecutor";
import { Relayer, type Job, type RelayerConfig, type SubmitRequest } from "../src/relayer";
import { FileJournal, MemoryJournal } from "../src/journal";
import { executionDigest, orderSignerAddress, predictEscrow, signExecution } from "../../private-swap/src/endpoints";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vector = JSON.parse(readFileSync(join(root, "contracts/test/periphery/vectors/endpoint.json"), "utf8"));
const creationCode = loadEscrowCreationCode();
const CHAIN_ID = Number(vector.chainId);
const RELAYER_KEY = ("0x" + "7f".repeat(32)) as Hex;
const ORDER_KEY = new Uint8Array(32).fill(0xc3);
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const selBalanceOf = toFunctionSelector("balanceOf(address)");
const selWrappedNative = toFunctionSelector("WRAPPED_NATIVE()");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const raws: Hex[] = [];
let ethBalance = 0n, tokenBalance = 0n, wethBalance = 0n;
let factoryWrappedNative: string | null = null; // null: the factory has no WRAPPED_NATIVE() (the call errors)
const tokenBalances: Record<string, bigint> = {}; // per-token escrow balances (foreign tokens a provider paid back in)
let escrowCode = "0x"; // eth_getCode of the escrow
let refusedToken: string | null = null; // estimateGas reverts for refundToken(this token): its vault refuses it
const selRefundToken = toFunctionSelector("refundToken(address,bytes)");
let receiptStatus: "0x1" | "0x0" | null = null;
const block = { number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1", baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), transactions: [], uncles: [] };
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res(toHex(CHAIN_ID));
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_getTransactionCount": return res("0x1");
    case "eth_getBalance": return res(toHex(ethBalance));
    case "eth_getCode": return res(escrowCode);
    case "eth_call": {
      const { to, data } = req.params[0];
      if (String(data).startsWith(selWrappedNative) && factoryWrappedNative) return res("0x" + factoryWrappedNative.slice(2).toLowerCase().padStart(64, "0"));
      if (String(data).startsWith(selBalanceOf)) return res("0x" + (tokenBalances[String(to).toLowerCase()] ?? (String(to).toLowerCase() === WETH.toLowerCase() ? wethBalance : tokenBalance)).toString(16).padStart(64, "0"));
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
    }
    case "eth_estimateGas": {
      const d = String(req.params[0].data ?? "").toLowerCase();
      if (refusedToken && d.startsWith(selRefundToken) && d.slice(10, 74).endsWith(refusedToken.slice(2).toLowerCase())) return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted: UnsupportedTokenBehavior()" } };
      return res("0x7a120");
    }
    case "eth_sendRawTransaction": raws.push(req.params[0]); return res(keccak256(req.params[0]));
    case "eth_getTransactionReceipt": return res(receiptStatus === null ? null : { transactionHash: req.params[0], status: receiptStatus, blockNumber: "0x11", blockHash: "0x" + "11".repeat(32), transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2" });
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let clients: { publicClient: any; walletClient: any };
let clock = 1000;
const account = privateKeyToAccount(RELAYER_KEY);

function makeRequest(orderId: Hex, deadline: number, assetType: 0 | 1 = 0, value?: string): SwapJobRequest {
  const refundNoteData = ("0x" + "ee".repeat(169)) as Hex;
  const params = { ...vector.params, orderId, assetType, asset: assetType === 1 ? TOKEN : vector.params.asset, orderSigner: orderSignerAddress(ORDER_KEY), refundNoteDataHash: keccak256(refundNoteData) };
  const escrow = predictEscrow(vector.factory, creationCode, { ...params, amount: BigInt(params.amount), refundOwnerCommitment: BigInt(params.refundOwnerCommitment), refundNoteSecret: BigInt(params.refundNoteSecret), executorTip: BigInt(params.executorTip) });
  const providerCalldata = ("0x" + "ab".repeat(40)) as Hex;
  const v = value ?? (assetType === 1 ? "0" : vector.execution.value);
  const digest = executionDigest(BigInt(CHAIN_ID), escrow, orderId, vector.execution.provider, BigInt(v), providerCalldata, deadline);
  return { factory: vector.factory, params, execution: { provider: vector.execution.provider, value: v, providerCalldata, deadline, signature: signExecution(ORDER_KEY, digest) }, refundNoteData };
}
const executorWith = (journal?: any, lateRefundWatchSeconds = 0) => new SwapExecutor({ chainId: CHAIN_ID, escrowCreationCode: creationCode, account, ...clients, now: () => clock, journal, lateRefundWatchSeconds });

beforeAll(async () => {
  server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = { id: CHAIN_ID, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  clients = { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }) };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("late provider refunds and foreign tokens (PP-S11, refundToken)", () => {
  const DAY = 24 * 3600;
  /** add, fund with ETH, execute, mine: the provider now holds the order */
  async function executed(ex: SwapExecutor, req: SwapJobRequest) {
    clock = 1000; ethBalance = BigInt(req.params.amount); receiptStatus = null; raws.length = 0;
    const job = ex.add(req);
    await ex.tick();
    expect(job.state).toBe("executing");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("executed");
    receiptStatus = null; ethBalance = 0n; raws.length = 0;
    return job;
  }
  const sentTo = (i: number) => parseTransaction(raws[i]).to!.toLowerCase();

  it("an executed order is watched past refundAfter: a late WETH refund (Across, after its fill deadline) re-shields; only an escrow still empty after the window is completed", async () => {
    factoryWrappedNative = WETH;
    const ex = executorWith(undefined, DAY);
    const req = makeRequest(("0x" + "1a".repeat(32)) as Hex, 1500);
    const job = await executed(ex, req);
    const after = Number(req.params.refundAfter);
    clock = after;
    await ex.tick();
    expect(job.state, "the provider still holds the funds: not completed at refundAfter").toBe("executed");
    clock = after + 3 * 3600; wethBalance = 5n * 10n ** 17n; // the unfilled deposit comes back with the next bundle
    await ex.tick();
    expect(job.state).toBe("refunding");
    expect(decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[0]).data! }).functionName).toBe("deployAndRefund");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("refunded");
    receiptStatus = null; wethBalance = 0n;
    ethBalance = 7n; // more arrives inside the window: re-shielded too
    await ex.tick();
    expect(job.state).toBe("refunding");
    receiptStatus = "0x1";
    await ex.tick();
    receiptStatus = null; raws.length = 0;
    clock = after + DAY; // the window has closed: nothing more is watched
    await ex.tick();
    expect(raws.length).toBe(0);
    ethBalance = 0n;
    // the same order, delivered: still "executed" through the window, "completed" after it
    const ex2 = executorWith(undefined, DAY);
    const job2 = await executed(ex2, makeRequest(("0x" + "1b".repeat(32)) as Hex, 1500));
    clock = after + DAY - 1;
    await ex2.tick();
    expect(job2.state).toBe("executed");
    clock = after + DAY;
    await ex2.tick();
    expect(job2.state).toBe("completed");
    factoryWrappedNative = null;
  });

  it("a listed foreign token re-shields through the escrow's refundToken before the order's asset; a token its vault refuses is dropped, never blocking", async () => {
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7", ODD = "0x00000000000000000000000000000000000000dd";
    const ex = executorWith(undefined, DAY);
    const req = { ...makeRequest(("0x" + "1c".repeat(32)) as Hex, 1500), refundTokens: [USDT, ODD] as any };
    const job = await executed(ex, req);
    expect(job.refundTokens).toEqual([USDT, ODD]);
    escrowCode = "0x6080"; tokenBalances[USDT] = 2_500_000_000n; tokenBalances[ODD] = 1n; refusedToken = ODD; ethBalance = 3n;
    clock = Number(req.params.refundAfter);
    await ex.tick();
    expect(job.state).toBe("refunding");
    expect(sentTo(0), "refundToken is called on the escrow itself").toBe(job.escrow.toLowerCase());
    const d = decodeFunctionData({ abi: escrowAbi, data: parseTransaction(raws[0]).data! });
    expect(d.functionName).toBe("refundToken");
    expect(d.args).toEqual([expect.stringMatching(new RegExp(USDT.slice(2), "i")), req.refundNoteData]);
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("refunded");
    receiptStatus = null; tokenBalances[USDT] = 0n;
    await ex.tick(); // ODD: its vault refuses it, so it is dropped with the reason
    expect(job.refundTokens).toEqual([USDT]);
    expect(job.error).toMatch(/cannot be re-shielded/);
    expect(raws.length).toBe(1);
    await ex.tick(); // then the order's own leftover
    expect(job.state).toBe("refunding");
    expect(decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[1]).data! }).functionName).toBe("deployAndRefund");
    escrowCode = "0x"; delete tokenBalances[USDT]; delete tokenBalances[ODD]; refusedToken = null; ethBalance = 0n; receiptStatus = null;
  });

  it("refundTokens: at most four addresses, never the order's own asset; address(0), the escrow's ETH, only for an ERC-20 order", () => {
    const ex = executorWith();
    const ZERO = "0x" + "00".repeat(20);
    const base = makeRequest(("0x" + "1d".repeat(32)) as Hex, 1500, 1);
    expect(() => ex.add({ ...base, refundTokens: [TOKEN] as any })).toThrow(/own asset/);
    expect(() => ex.add({ ...makeRequest(("0x" + "1f".repeat(32)) as Hex, 1500), refundTokens: [ZERO] as any }), "an ETH order's ETH goes through refund()").toThrow(/own asset/);
    expect(() => ex.add({ ...base, refundTokens: Array.from({ length: 5 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")) as any })).toThrow(/at most/);
    expect(() => ex.addRefund({ factory: base.factory, params: base.params, refundNoteData: base.refundNoteData, refundTokens: ["0xnope"] as any })).toThrow(/at most/);
    expect(ex.add({ ...base, refundTokens: [ZERO] as any }).refundTokens, "an ERC-20 order's escrow re-shields ETH, as ETH").toEqual([ZERO]);
  });

  it("an ERC-20 order paid back in ETH: address(0) watches the escrow's ETH, and refundToken(address(0)) re-shields it as ETH", async () => {
    const ZERO = "0x" + "00".repeat(20);
    const ex = executorWith(undefined, DAY);
    const req = { ...makeRequest(("0x" + "1e".repeat(32)) as Hex, 1500, 1), refundTokens: [ZERO] as any };
    clock = 1000; tokenBalance = BigInt(req.params.amount); ethBalance = 0n; receiptStatus = null; raws.length = 0;
    const job = ex.add(req);
    await ex.tick();
    expect(job.state).toBe("executing");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("executed");
    receiptStatus = null; tokenBalance = 0n; raws.length = 0;
    clock = Number(req.params.refundAfter);
    await ex.tick();
    expect(raws.length, "nothing came back yet").toBe(0);
    escrowCode = "0x6080"; ethBalance = 25n * 10n ** 16n; // a bridge refunded the ETH the route swapped into
    await ex.tick();
    expect(job.state).toBe("refunding");
    expect(sentTo(0), "refundToken is called on the escrow itself").toBe(job.escrow.toLowerCase());
    const d = decodeFunctionData({ abi: escrowAbi, data: parseTransaction(raws[0]).data! });
    expect(d.functionName).toBe("refundToken");
    expect(d.args).toEqual([ZERO, req.refundNoteData]);
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("refunded");
    escrowCode = "0x"; ethBalance = 0n; receiptStatus = null; raws.length = 0;
  });
});

describe("refund-only jobs (the wallet will not execute: it refused the call, or the user cancelled)", () => {
  it("need no execution, are never executed even when funded, and refund once the window opens", async () => {
    const ex = executorWith();
    const req = makeRequest(("0x" + "1a".repeat(32)) as Hex, 1500);
    clock = 1000; ethBalance = BigInt(req.params.amount); receiptStatus = null; raws.length = 0;
    const job = ex.addRefund({ factory: req.factory, params: req.params, refundNoteData: req.refundNoteData });
    expect(job.state).toBe("refund-only");
    expect(job.execution).toBeUndefined();
    await ex.tick();
    expect(raws.length, "funded, but never executed").toBe(0);
    expect(job.state).toBe("refund-only");
    clock = Number(req.params.refundAfter);
    await ex.tick();
    expect(job.state).toBe("refunding");
    expect(decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[0]).data! }).functionName).toBe("deployAndRefund");
    ethBalance = 0n; receiptStatus = null; clock = 1000;
  });
  it("drop a stored execution that has not run; a later execution replaces them; a payload that is not the committed one is refused", async () => {
    const ex = executorWith();
    const orderId = ("0x" + "1b".repeat(32)) as Hex;
    clock = 1000; ethBalance = 0n;
    const req = makeRequest(orderId, 1500);
    const job = ex.add(req);
    expect(job.state).toBe("waiting-funding");
    expect(ex.addRefund({ factory: req.factory, params: req.params, refundNoteData: req.refundNoteData })).toBe(job);
    expect(job.state).toBe("refund-only");
    expect(job.execution, "the signed execution is dropped").toBeUndefined();
    ex.add(makeRequest(orderId, 1600)); // the user changed their mind, with a fresh quote
    expect(job.state).toBe("waiting-funding");
    expect(job.execution?.deadline).toBe(1600);
    expect(() => ex.addRefund({ factory: req.factory, params: req.params, refundNoteData: ("0x" + "ff".repeat(169)) as Hex })).toThrow(/does not hash/);
  });
});

describe("re-signed executions", () => {
  it("an expired execution is replaced by a fresh one for the same order and then executed with the new signature", async () => {
    const ex = executorWith();
    const orderId = ("0x" + "0a".repeat(32)) as Hex;
    const first = makeRequest(orderId, 1201);
    clock = 1300; // the first quote expired before funding
    const job = ex.add(first);
    expect(job.state).toBe("expired");
    const fresh = makeRequest(orderId, 1700); // re-quoted, re-signed by the same one-time key (deadline ≤ executeDeadline 1801)
    expect(ex.add(fresh)).toBe(job);
    expect(job.state).toBe("waiting-funding");
    expect(job.execution?.signature).toBe(fresh.execution.signature);
    ethBalance = BigInt(first.params.amount);
    await ex.tick();
    expect(job.state).toBe("executing");
    const d = decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[raws.length - 1]).data! });
    expect((d.args as any)[1].signature).toBe(fresh.execution.signature);
    expect((d.args as any)[1].deadline).toBe(1700n);
    // once executing, a further execution is ignored
    const late = makeRequest(orderId, 1750);
    ex.add(late);
    expect(job.execution?.signature).toBe(fresh.execution.signature);
    ethBalance = 0n;
  });
});

describe("ERC-20 escrows", () => {
  it("are watched through balanceOf and require a zero-value execution", async () => {
    const ex = executorWith();
    const orderId = ("0x" + "0b".repeat(32)) as Hex;
    expect(() => ex.add(makeRequest(orderId, 1700, 1, "1"))).toThrow(/no ETH value/);
    clock = 1000;
    const job = ex.add(makeRequest(orderId, 1700, 1));
    expect(job.state).toBe("waiting-funding");
    tokenBalance = BigInt(job.params.amount) - 1n;
    await ex.tick();
    expect(job.state).toBe("waiting-funding");
    tokenBalance = BigInt(job.params.amount);
    await ex.tick();
    expect(job.state).toBe("executing");
    tokenBalance = 0n;
  });
});

describe("journals", () => {
  it("an ETH order paid back in WETH (an unfilled Across deposit) is refunded: the escrow unwraps it, so it counts", async () => {
    const ex = executorWith();
    const orderId = ("0x" + "0e".repeat(32)) as Hex;
    const req = makeRequest(orderId, 1500);
    clock = 1000;
    const job = ex.add(req);
    factoryWrappedNative = WETH;
    ethBalance = BigInt(req.params.amount);
    raws.length = 0;
    await ex.tick(); // funded with ETH: executed
    expect(job.state).toBe("executing");
    receiptStatus = "0x1";
    await ex.tick();
    expect(job.state).toBe("executed");
    ethBalance = 0n; wethBalance = 123_456n; // the provider refunded in WETH
    clock = Number(req.params.refundAfter);
    raws.length = 0;
    await ex.tick();
    expect(job.state, "WETH alone triggers the refund").toBe("refunding");
    expect(job.balance).toBe("123456");
    const sent = decodeFunctionData({ abi: factoryAbi, data: parseTransaction(raws[0]).data! });
    expect(sent.functionName).toBe("deployAndRefund");
    // and WETH never counts as funding: execution needs native ETH
    clock = 1000; ethBalance = 0n; wethBalance = BigInt(req.params.amount); receiptStatus = null;
    const ex2 = executorWith();
    const job2 = ex2.add(makeRequest(("0x" + "0f".repeat(32)) as Hex, 1500));
    await ex2.tick();
    expect(job2.state, "WETH does not fund an ETH order").toBe("waiting-funding");
    factoryWrappedNative = null; wethBalance = 0n;
  });
  it("a restarted executor resumes its open jobs from the file journal and finishes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relayer-journal-"));
    try {
      const path = join(dir, "swap-jobs.json");
      const a = executorWith(new FileJournal<SwapJob>(path));
      const orderId = ("0x" + "0c".repeat(32)) as Hex;
      clock = 1000; ethBalance = BigInt(vector.params.amount);
      a.add(makeRequest(orderId, 1700));
      await a.tick();
      expect(a.get(orderId)!.state).toBe("executing");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))[0].state).toBe("executing");
      // restart
      const b = executorWith(new FileJournal<SwapJob>(path));
      expect(b.list().map((j) => j.id)).toEqual([orderId]);
      expect(b.get(orderId)!.txHash).toBe(a.get(orderId)!.txHash);
      receiptStatus = "0x1";
      await b.tick();
      expect(b.get(orderId)!.state).toBe("executed");
      expect(JSON.parse(readFileSync(path, "utf8"))[0].state).toBe("executed");
      receiptStatus = null; ethBalance = 0n;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a restarted relayer keeps the in-flight nullifiers of journaled submissions", async () => {
    const fixture = join(root, "contracts/test/e2e/E2EFixture.sol");
    if (!existsSync(fixture)) return;
    const sol = readFileSync(fixture, "utf8");
    const words = (s: string) => s.split(",").map((x) => BigInt(x.replace(/uint256\(|\)/g, "").trim()));
    const pm = sol.match(/if \(t == 0\) \{\s*a = \[([^\]]+)\];\s*b = \[\[([^\]]+)\], \[([^\]]+)\]\];\s*c = \[([^\]]+)\];/)!;
    const a = words(pm[1]), b0 = words(pm[2]), b1 = words(pm[3]), c = words(pm[4]);
    const proof = ("0x" + [a[0], a[1], b0[0], b0[1], b1[0], b1[1], c[0], c[1]].map((w) => w.toString(16).padStart(64, "0")).join("")) as Hex;
    const um = sol.match(/if \(t == 0\) \{\s*p = \[uint256\(([^)]+)\),([^\]]+)\];/)!;
    const publicInputs = [um[1], ...um[2].split(",")].map((s) => BigInt(s.trim()).toString());
    const meta = JSON.parse(readFileSync(join(root, "circuits/test/fixtures/e2e/meta.json"), "utf8"));
    const tx1 = JSON.parse(readFileSync(join(root, "circuits/test/fixtures/e2e/tx1.json"), "utf8"));
    const deployment = JSON.parse(readFileSync(join(root, "contracts/test/e2e/deployment.json"), "utf8"));
    const req: SubmitRequest = { proof, publicInputs, noteData: meta.noteData[0], fee: { outputIndex: 1, amount: tx1.outAmount[1], noteSecret: tx1.outNoteSecret[1] } };
    const journal = new MemoryJournal<Job>();
    const cfg: RelayerConfig = { chainId: Number(deployment.chainId), core: deployment.core, feeVault: deployment.vault, minFeeWei: 0n, gasEstimate: 1_800_000n, feeMarginBps: 2000, privateKey: RELAYER_KEY, masterSeed: utf8ToBytes("privacy-protocol/example-relayer"), rpcUrl: "", requireReadableFeePayload: false, journal };
    const r1 = new Relayer(cfg, clients);
    const first = await r1.submit(req);
    expect(journal.load().length).toBe(1);
    const r2 = new Relayer(cfg, clients); // restart
    expect((await r2.info()).inflight).toBe(2);
    await expect(r2.submit(req)).rejects.toMatchObject({ code: "nullifier_in_flight" });
    receiptStatus = "0x1";
    expect((await r2.status(first.txHash))?.status).toBe("mined");
    expect(journal.load()[0].status).toBe("mined");
    expect((await r2.info()).inflight).toBe(0);
    receiptStatus = null;
  });
});
