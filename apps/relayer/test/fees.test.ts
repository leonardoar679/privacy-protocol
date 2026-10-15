// The percentage privacy fee (Privacy Wallet Web spec v2.0 §3; the V6 decision "1 % everywhere"): the relayer's terms on
// /info, a withdrawal refused unless its fee note f covers ⌈(W + f)·b/10000⌉ on top of the minimum (fee_below_percent),
// a swap's escrow funding treated like any withdrawal (the V5 exemption is gone), a transfer checked against the
// minimum only (its amount is private), the minimum checked first, the product default, the receipt's actual cost on
// the job. On the forge e2e fixture's withdrawal (0.6 ETH, a 0.05 ETH fee note) over a mock JSON-RPC; no funds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, type Address, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { privateKeyToAccount } from "viem/accounts";
import { Relayer, type RelayerConfig } from "../src/relayer";
import { piFromStrings } from "../src/abi";
import { FIXTURE_ROOT, fixtureRequest, have } from "./fixture";

const block = { number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x0", baseFeePerGas: "0x3b9aca00", transactions: [], uncles: [] };
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res("0x7a69");
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_gasPrice": return res("0x3b9aca00"); // 1 gwei
    case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_getTransactionCount": return res("0x3");
    case "eth_estimateGas": return res("0x1b7740");
    case "eth_sendRawTransaction": return res(keccak256(req.params[0]));
    case "eth_getTransactionReceipt": return res(null);
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let relayer: Relayer;
let cfg: RelayerConfig;
const RELAYER_SEED = utf8ToBytes("privacy-protocol/example-relayer"); // the fixture's relayer
const RELAYER_KEY = ("0x" + "5e".repeat(32)) as Hex;
const FEE = "50000000000000000"; // the fixture's fee note: 0.05 ETH on a 0.6 ETH withdrawal

beforeAll(async () => {
  server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { deployment } = have ? fixtureRequest() : { deployment: { core: "0x" + "01".repeat(20), vault: "0x" + "02".repeat(20), chainId: 31337 } };
  cfg = { chainId: Number(deployment.chainId), core: deployment.core, feeVault: deployment.vault, minFeeWei: 0n, gasEstimate: 1_800_000n, feeMarginBps: 2000, privateKey: RELAYER_KEY, masterSeed: RELAYER_SEED, rpcUrl, requireReadableFeePayload: false };
  const chain = { id: cfg.chainId, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const transport = http(rpcUrl, { batch: true });
  relayer = new Relayer(cfg, { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account: privateKeyToAccount(RELAYER_KEY), chain, transport }) });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** a relayer with the percentage (each instance has its own in-flight set, so every submission here is a first one) */
const withBps = (bps: number, over: Partial<RelayerConfig> = {}) => new Relayer({ ...cfg, feePercentBps: bps, ...over }, relayer.clients);

describe("the terms on /info (spec §10)", () => {
  it("state the percentage and the minimum in wei; without the setting the percentage is 0 and the minimum stands", async () => {
    const info = await withBps(100).info();
    expect(info.feePercentBps).toBe(100);
    expect(info.feeMinimumWei).toBe(info.minFeeWei);
    expect(BigInt(info.feeMinimumWei)).toBe(2_160_000_000_000_000n); // 1.8M gas × 1 gwei × 1.2
    expect((await relayer.info()).feePercentBps).toBe(0);
  });
  it("the product default is 1.00 %: the example env and the local stack set it; the server reads FEE_PERCENT_BPS with 0 when absent", () => {
    expect(readFileSync(join(FIXTURE_ROOT, "apps/relayer/.env.example"), "utf8")).toMatch(/^FEE_PERCENT_BPS=100$/m);
    expect(readFileSync(join(FIXTURE_ROOT, "scripts/local-stack/start-services.mjs"), "utf8")).toMatch(/FEE_PERCENT_BPS: "100"/);
    // read strictly since 2026-10-15: 0 when absent, a whole number of basis points up to 100 %, or the start fails
    expect(readFileSync(join(FIXTURE_ROOT, "apps/relayer/src/server.ts"), "utf8")).toMatch(/feePercentBps: int\("FEE_PERCENT_BPS", 0, 0, 10_000\)/);
  });
});

describe.skipIf(!have)("the percentage on the forge-verified withdrawal (spec §10)", () => {
  it("accepted at 1 % (0.05 ETH ≥ 1 % of the 0.65 ETH leaving + 0.00216); refused at 10 % with fee_below_percent naming the required amount", async () => {
    const { req } = fixtureRequest();
    const r = await withBps(100).submit(req);
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.feeWei).toBe(FEE);
    await expect(withBps(1000).submit(req)).rejects.toMatchObject({
      code: "fee_below_percent",
      message: expect.stringMatching(/below 10\.00 % of the 650000000000000000 leaving the pool plus the minimum 2160000000000000 \(67160000000000000 in vault/),
    });
  });
  it("the percentage is of what leaves (W + f), rounded up: 7.36 % of 0.65 ETH plus the minimum is exactly the 0.05 ETH note, 7.37 % is not", async () => {
    const { req } = fixtureRequest();
    await expect(withBps(736).submit(req)).resolves.toMatchObject({ feeWei: FEE });
    await expect(withBps(737).submit(req)).rejects.toMatchObject({ code: "fee_below_percent" });
  });
  it("a private transfer is checked against the minimum only: its amount is not public, so the percentage is the wallet's to pay", async () => {
    const { req } = fixtureRequest();
    // mode 0 with the fixture's other inputs: the proof would no longer verify on chain — this checks the relayer's local rule only
    const transfer = { ...req, publicInputs: req.publicInputs.map((v, i) => (i === 6 ? "0" : v)) };
    await expect(withBps(1000).submit(transfer)).resolves.toMatchObject({ feeWei: FEE });
  });
  it("a swap's escrow funding pays the percentage like any withdrawal: naming the order exempts nothing (V6)", async () => {
    const { req } = fixtureRequest();
    const swap = { factory: ("0x" + "0f".repeat(20)) as Address, params: { named: "by the wallet" } };
    await expect(withBps(1000).submit({ ...req, swap } as typeof req), "an order named in the request").rejects.toMatchObject({ code: "fee_below_percent" });
    await expect(withBps(100).submit({ ...req, swap } as typeof req)).resolves.toMatchObject({ feeWei: FEE });
    const code = readFileSync(join(FIXTURE_ROOT, "apps/relayer/src/relayer.ts"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    expect(code, "no exemption left in the relayer's code").not.toMatch(/escrowFor|exempt/);
  });
  it("the minimum is the floor: checked first, and the binding term when the percentage is below it", async () => {
    const { req } = fixtureRequest();
    await expect(withBps(100, { minFeeWei: 51n * 10n ** 15n }).submit(req)).rejects.toMatchObject({ code: "fee_too_low" });
    await expect(withBps(100, { minFeeWei: 40n * 10n ** 15n }).submit(req)).resolves.toMatchObject({ feeWei: FEE }); // 1 % of 0.65 + 0.04 = 0.0465 ≤ 0.05
    await expect(withBps(100, { minFeeWei: 44n * 10n ** 15n }).submit(req), "0.0065 + 0.044 > 0.05").rejects.toMatchObject({ code: "fee_below_percent" });
    await expect(withBps(0, { minFeeWei: 40n * 10n ** 15n }).submit(req), "no percentage: the minimum alone").resolves.toMatchObject({ feeWei: FEE });
  });
});
