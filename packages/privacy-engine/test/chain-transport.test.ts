// The PrivacyTransport (doc §64–§65; spec v2.0 §14.2) against a local JSON-RPC endpoint: a contract view, a broadcast, a
// block by tag and by number, the logs of a contract over a range — each the one JSON-RPC method it names, with the
// filter it was given and nothing about the user; every request announced to the leakage gate as an `rpc` request.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, parseAbi, parseAbiItem, toFunctionSelector } from "viem";
import { onRequest, privacyTransport, type RequestRecord } from "../src/index";

const CORE = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const RAW = "0x02f86c0180843b9aca00847735940082520894000000000000000000000000000000000000b0b080c0";
const seen: { method: string; params: unknown[] }[] = [];
let server: Server;
let url = "";

function answer(method: string, params: unknown[]): unknown {
  seen.push({ method, params });
  switch (method) {
    case "eth_chainId":
      return "0x7a69";
    case "eth_call":
      return encodeAbiParameters([{ type: "uint32" }], [7]);
    case "eth_sendRawTransaction":
      return HASH;
    case "eth_getBlockByNumber": {
      const n = params[0] === "latest" ? 0x10 : parseInt(String(params[0]), 16);
      return {
        number: "0x" + n.toString(16),
        hash: HASH,
        parentHash: HASH,
        timestamp: "0x65",
        baseFeePerGas: "0x3b9aca00",
        transactions: [],
        gasLimit: "0x1",
        gasUsed: "0x0",
        difficulty: "0x0",
        logsBloom: "0x" + "00".repeat(256),
        miner: CORE,
        extraData: "0x",
        nonce: "0x0000000000000000",
        sha3Uncles: HASH,
        stateRoot: HASH,
        receiptsRoot: HASH,
        transactionsRoot: HASH,
        size: "0x1",
        totalDifficulty: "0x0",
        uncles: [],
        mixHash: HASH,
      };
    }
    case "eth_getLogs":
      return [
        {
          address: CORE,
          topics: [HASH],
          data: "0x",
          blockNumber: "0x3",
          blockHash: HASH,
          transactionHash: HASH,
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        },
      ];
    default:
      throw new Error(`unexpected ${method}`);
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const one = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params ?? []) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the PrivacyTransport", () => {
  it("reads, broadcasts, fetches blocks and logs through one endpoint, each request announced as rpc", async () => {
    const records: RequestRecord[] = [];
    const off = onRequest((r) => records.push(r));
    try {
      const t = privacyTransport(url);
      expect(t.url).toBe(url);

      const abi = parseAbi(["function nextLeafIndex() view returns (uint32)"]);
      expect(await t.read<number>({ address: CORE, abi, functionName: "nextLeafIndex" })).toBe(7);
      expect(seen.at(-1)).toMatchObject({ method: "eth_call", params: [{ to: CORE, data: toFunctionSelector("nextLeafIndex()") }, "latest"] });

      expect(await t.broadcast(RAW)).toBe(HASH);
      expect(seen.at(-1)).toEqual({ method: "eth_sendRawTransaction", params: [RAW] });

      expect(await t.getBlock()).toEqual({ number: 16n, hash: HASH, timestamp: 101n, baseFeePerGas: 1_000_000_000n });
      expect(seen.at(-1)).toMatchObject({ method: "eth_getBlockByNumber", params: ["latest", false] });
      expect((await t.getBlock(5n)).number).toBe(5n);
      expect(seen.at(-1)).toMatchObject({ method: "eth_getBlockByNumber", params: ["0x5", false] });

      const event = parseAbiItem("event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)");
      const logs = await t.getLogs({ address: CORE, fromBlock: 0n });
      expect(logs).toHaveLength(1);
      expect(seen.at(-1)).toEqual({ method: "eth_getLogs", params: [{ address: CORE, fromBlock: "0x0", toBlock: "latest", topics: [] }] });
      await t.getLogs({ address: CORE, event, fromBlock: 2n, toBlock: 9n }).catch(() => []); // the scripted log does not decode as the event: the filter is what counts
      const filter = seen.at(-1)!.params[0] as { topics: string[]; fromBlock: string; toBlock: string };
      expect(filter).toMatchObject({ address: CORE, fromBlock: "0x2", toBlock: "0x9" });
      expect(filter.topics[0]).toMatch(/^0x[0-9a-f]{64}$/);

      expect(records.length).toBeGreaterThanOrEqual(6);
      for (const r of records) expect(r).toMatchObject({ host: "127.0.0.1", purpose: "rpc", method: "POST" });
      // the transport adds no account of its own: a view goes out without a sender
      for (const call of seen.filter((s) => s.method === "eth_call")) expect(call.params[0]).not.toHaveProperty("from");
    } finally {
      off();
    }
  });
});
