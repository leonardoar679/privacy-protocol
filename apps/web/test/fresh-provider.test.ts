// The fresh funding address (spec §4/§6): a seed-derived key exposed to the zkAPI SDK as EIP-1193.
// Against a local mock JSON-RPC server: it reports its own account and chain, signs a transaction
// locally (the raw tx recovers to the fresh address) and broadcasts it, forwards reads, refuses to
// sign for any other sender and refuses message signing. Nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from "viem";
import { deriveFundingKey, freshAccountProvider } from "../src/zkapi/freshAccountProvider";
import { onRequest, type RequestRecord } from "@privacy-wallet/privacy-engine/transport/http";

const CHAIN_ID = 11155111;
const raws: Hex[] = [];
let server: Server;
let rpcUrl: string;

const block = {
  number: "0x10", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), nonce: "0x0000000000000000", sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32),
  miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x1",
  baseFeePerGas: "0x3b9aca00", mixHash: "0x" + "00".repeat(32), transactions: [], uncles: [],
};
function handle(req: { id: number; method: string; params: unknown[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId": return res(toHex(CHAIN_ID));
    case "eth_blockNumber": return res("0x10");
    case "eth_getBlockByNumber": return res(block);
    case "eth_maxPriorityFeePerGas": return res("0x3b9aca00");
    case "eth_gasPrice": return res("0x77359400");
    case "eth_estimateGas": return res("0x5208");
    case "eth_getTransactionCount": return res("0x7");
    case "eth_getBalance": return res("0xde0b6b3a7640000");
    case "eth_call": return res("0x" + "00".repeat(31) + "2a");
    case "eth_sendRawTransaction": raws.push(req.params[0] as Hex); return res(keccak256(req.params[0] as Hex));
    default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fresh funding key", () => {
  const seed = new Uint8Array(32).fill(9);
  it("is deterministic per seed and index, distinct across indexes, and a valid secp256k1 scalar", () => {
    const a = deriveFundingKey(seed, 0), b = deriveFundingKey(seed, 0), c = deriveFundingKey(seed, 1);
    expect(a.privateKey).toBe(b.privateKey);
    expect(a.address).toBe(b.address);
    expect(c.address).not.toBe(a.address);
    expect(a.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(a.privateKey)).toBeGreaterThan(0n);
    expect(deriveFundingKey(new Uint8Array(32).fill(10), 0).address).not.toBe(a.address);
  });
});

describe("fresh funding provider (EIP-1193 over a local key)", () => {
  const seed = new Uint8Array(32).fill(7);
  const key = deriveFundingKey(seed, 3);
  it("answers accounts / chain from the key, not from any wallet extension", async () => {
    const p = freshAccountProvider(key.privateKey, rpcUrl, CHAIN_ID);
    expect(await p.request({ method: "eth_requestAccounts" })).toEqual([key.address]);
    expect(await p.request({ method: "eth_accounts" })).toEqual([key.address]);
    expect(await p.request({ method: "eth_chainId" })).toBe(toHex(CHAIN_ID));
    expect(await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(CHAIN_ID) }] })).toBeNull();
    expect(p.isFreshFundingAddress).toBe(true);
  });
  it("signs eth_sendTransaction locally: the broadcast raw transaction recovers to the fresh address", async () => {
    const p = freshAccountProvider(key.privateKey, rpcUrl, CHAIN_ID);
    const to = "0x49fA19f9bdECe7A48Ebc7749fD69aD40F577590F";
    const hash = await p.request({ method: "eth_sendTransaction", params: [{ from: key.address, to, data: "0x1234", value: "0x2386f26fc10000" }] });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(raws.length).toBe(1);
    const tx = parseTransaction(raws[0]);
    expect(tx.to?.toLowerCase()).toBe(to.toLowerCase());
    expect(tx.value).toBe(10_000_000_000_000_000n);
    expect(tx.data).toBe("0x1234");
    expect(tx.nonce).toBe(7);
    expect(tx.chainId).toBe(CHAIN_ID);
    expect((await recoverTransactionAddress({ serializedTransaction: raws[0] })).toLowerCase()).toBe(key.address.toLowerCase());
  });
  it("reads and broadcasts through the privacy engine's transport: every request announced as rpc (audit round 2, n51)", async () => {
    const heard: RequestRecord[] = [];
    const off = onRequest((r) => heard.push(r));
    try {
      const p = freshAccountProvider(key.privateKey, rpcUrl, CHAIN_ID);
      expect(await p.request({ method: "eth_getBalance", params: [key.address, "latest"] })).toBe("0xde0b6b3a7640000");
      expect(heard.length, "announced").toBeGreaterThan(0);
      expect(heard.every((r) => r.purpose === "rpc" && r.host === "127.0.0.1")).toBe(true);
    } finally {
      off();
    }
  });
  it("forwards reads to the pinned RPC and refuses other senders and message signing", async () => {
    const p = freshAccountProvider(key.privateKey, rpcUrl, CHAIN_ID);
    expect(await p.request({ method: "eth_getBalance", params: [key.address, "latest"] })).toBe("0xde0b6b3a7640000");
    expect(await p.request({ method: "eth_call", params: [{ to: key.address, data: "0x" }, "latest"] })).toBe("0x" + "00".repeat(31) + "2a");
    await expect(p.request({ method: "eth_sendTransaction", params: [{ from: "0x000000000000000000000000000000000000dEaD", to: key.address }] })).rejects.toThrow(/not the fresh funding address/);
    await expect(p.request({ method: "personal_sign", params: ["0x01", key.address] })).rejects.toThrow(/signs transactions only/);
    await expect(p.request({ method: "eth_signTypedData_v4", params: [key.address, "{}"] })).rejects.toThrow(/signs transactions only/);
  });
});
