// The relayer's one account sends one transaction at a time, and a send's fate is the node's answer (a V6 follow-up of
// 2026-10-15). Three senders share the account (the submissions, the swap executor, the shield executor) and each read
// its nonce from the node's pending count while another send could still be between that read and its broadcast: two
// sends at once read one nonce, and the node refused the second. Here, against a mock node with a mempool: straight
// through viem two sends at once collide; through the one sender the node takes both; a broadcast whose answer was lost
// is sent when the node holds it; a refused one, or one that never left, is not, and nothing waits for it. And no
// transaction leaves the relayer any other way. No real chain, no funds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseTransaction,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Sender, reasonOf } from "../src/sender";

const CHAIN_ID = 1;
const account = privateKeyToAccount(("0x" + "7e".repeat(32)) as Hex);
const TO = "0x00000000000000000000000000000000000000f2" as Address;

// ---- a mock node: the pending nonce counts its mempool, a second transaction at a held nonce is refused ----
const pool = new Map<Hex, number>(); // hash -> nonce
let mode: "take" | "refuse" | "lose-answer" = "take";
let countDown = false;
let readsDown = false;
let lost = false;
const block = {
  number: "0x10",
  hash: "0x" + "11".repeat(32),
  parentHash: "0x" + "00".repeat(32),
  nonce: "0x0000000000000000",
  sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: "0x" + "00".repeat(32),
  stateRoot: "0x" + "00".repeat(32),
  receiptsRoot: "0x" + "00".repeat(32),
  miner: "0x" + "00".repeat(20),
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x1",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x1",
  baseFeePerGas: "0x3b9aca00",
  mixHash: "0x" + "00".repeat(32),
  transactions: [],
  uncles: [],
};
function handle(req: { id: number; method: string; params: any[] }) {
  const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const err = (message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
  switch (req.method) {
    case "eth_chainId":
      return res(toHex(CHAIN_ID));
    case "eth_blockNumber":
      return res("0x10");
    case "eth_getBlockByNumber":
      return res(block);
    case "eth_gasPrice":
      return res("0x3b9aca00");
    case "eth_maxPriorityFeePerGas":
      return res("0x3b9aca00");
    case "eth_getTransactionCount":
      return countDown ? err("header not found") : res(toHex(pool.size));
    case "eth_sendRawTransaction": {
      const raw = req.params[0] as Hex;
      const hash = keccak256(raw);
      const { nonce } = parseTransaction(raw);
      if (mode === "refuse") return err("insufficient funds for gas * price + value");
      if (pool.has(hash)) return err("already known");
      if ([...pool.values()].includes(nonce!)) return err("replacement transaction underpriced");
      pool.set(hash, nonce!);
      if (mode === "lose-answer") {
        mode = "take";
        lost = true;
      } // taken, and the answer is lost on the way back
      return res(hash);
    }
    case "eth_getTransactionByHash": {
      if (readsDown) return err("header not found");
      const nonce = pool.get(req.params[0]);
      if (nonce === undefined) return res(null);
      return res({
        hash: req.params[0],
        nonce: toHex(nonce),
        from: account.address,
        to: TO,
        input: "0x",
        value: "0x0",
        gas: "0x5208",
        blockHash: null,
        blockNumber: null,
        transactionIndex: null,
        type: "0x2",
        chainId: toHex(CHAIN_ID),
        maxFeePerGas: "0x77359400",
        maxPriorityFeePerGas: "0x3b9aca00",
        v: "0x0",
        yParity: "0x0",
        r: "0x1",
        s: "0x1",
      });
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
  }
}

let server: Server;
let clients: { publicClient: PublicClient; walletClient: WalletClient };
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      const out = JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j));
      if (lost) {
        lost = false;
        res.statusCode = 502;
        return res.end("bad gateway");
      } // a proxy between the relayer and its node
      res.setHeader("content-type", "application/json");
      res.end(out);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = {
    id: CHAIN_ID,
    name: "test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const transport = http(rpcUrl, { batch: true, retryDelay: 10 });
  clients = { publicClient: createPublicClient({ chain, transport }) as PublicClient, walletClient: createWalletClient({ account, chain, transport }) };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  pool.clear();
  mode = "take";
  countDown = readsDown = lost = false;
});

const tx = (n: number) => ({ to: TO, data: toHex(n, { size: 4 }), gas: 100_000n });

describe("one transaction of the account at a time", () => {
  it("straight through viem, two sends at once read one nonce and the node refuses the second (what the relayer did)", async () => {
    const send = (n: number) => clients.walletClient.sendTransaction({ account, chain: clients.walletClient.chain, ...tx(n) });
    const both = await Promise.allSettled([send(1), send(2)]);
    const refused = both.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String(refused[0].reason)).toMatch(/replacement transaction underpriced/);
    expect([...pool.values()]).toEqual([0]);
  });
  it("through the one sender, each send reads its nonce after the one before it was broadcast, and the node takes all", async () => {
    const sender = new Sender(account, clients);
    const sent = await Promise.all([1, 2, 3].map((n) => sender.send(tx(n))));
    expect(sent.every((s) => s.ok)).toBe(true);
    expect([...pool.values()].sort()).toEqual([0, 1, 2]);
    expect(new Set(sent.map((s) => (s.ok ? s.hash : null))).size).toBe(3);
    for (const s of sent) if (s.ok) expect(pool.has(s.hash), "the hash is the transaction's own").toBe(true);
  });
  it("a send that fails does not stop the ones after it", async () => {
    const sender = new Sender(account, clients);
    mode = "refuse";
    const first = sender.send(tx(1));
    const second = first.then(() => {
      mode = "take";
      return sender.send(tx(2));
    });
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
  });
});

describe("a send's fate is the node's answer", () => {
  it("a broadcast whose answer was lost: the node holds it, so it was sent (a retry was refused as already known)", async () => {
    mode = "lose-answer";
    const r = await new Sender(account, clients).send(tx(1));
    expect(r).toEqual({ ok: true, hash: [...pool.keys()][0] });
    expect(pool.size).toBe(1);
  });
  it("a broadcast the node refused and does not know: not sent, with the node's own words, nothing to wait for", async () => {
    mode = "refuse";
    const r = await new Sender(account, clients).send(tx(1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/insufficient funds for gas \* price \+ value/);
  });
  it("a broadcast whose fate cannot be read: sent, and watched until it is mined or dropped", async () => {
    mode = "lose-answer";
    readsDown = true;
    const r = await new Sender(account, clients).send(tx(1));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note).toMatch(/answer was lost .* watched until it is mined or dropped/);
  });
  it("a send whose nonce could not be read never left: not sent", async () => {
    countDown = true;
    const r = await new Sender(account, clients).send(tx(1));
    expect(r.ok).toBe(false);
    expect(pool.size).toBe(0);
  });
  it("an error's reason is one line without a URL's path", () => {
    const e = Object.assign(new Error("HTTP request failed.\n\nURL: https://rpc.example/v2/KEY"), {
      shortMessage: "HTTP request failed.",
      details: "502 from https://rpc.example/v2/KEY",
    });
    expect(reasonOf(e)).toBe("HTTP request failed: 502 from https://rpc.example/…");
  });
});

describe("no transaction leaves the relayer any other way", () => {
  it("only src/sender.ts broadcasts, and the server hands the relayer's sender to both executors", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "sender.ts"))
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/sendTransaction|sendRawTransaction|writeContract|deployContract|signTransaction/);
    const server = readFileSync(join(dir, "server.ts"), "utf8");
    expect(server.match(/sender: relayer\.sender/g)).toHaveLength(2);
  });
});
