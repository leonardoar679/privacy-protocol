// A loopback JSON-RPC mock of one deployed core for the wallet's sync / discovery tests: NoteInserted
// events at fixed leaf indexes, nextLeafIndex(), currentRoot(), isNullifierSpent(). Batched requests
// are answered element-wise, like a real endpoint. No chain, no funds.
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, toFunctionSelector, toHex, type Hex } from "viem";
import { coreAbi } from "../../src/sdk/privacyProtocol";

/** A Chainlink-shaped feed the mock serves at an address (whale spec §13 tests): description(), latestRoundData(). */
export interface MockFeed { description: string; answer: bigint; updatedAt: number; roundId?: bigint }
export interface MockCoreOptions {
  core: string; events: Record<number, { commitment: bigint; noteData: Hex }>; nextLeafIndex: number; root: bigint;
  /** feeds by address (lowercase or checksummed) */
  feeds?: Record<string, MockFeed>;
  /** the Feed Registry's getFeed(base, USD) answers: base denomination → feed address */
  registry?: Record<string, string>;
}

export async function startMockCore(o: MockCoreOptions) {
  const selNext = toFunctionSelector("nextLeafIndex()");
  const selRoot = toFunctionSelector("currentRoot()");
  const selSpent = toFunctionSelector("isNullifierSpent(uint256)");
  const selDescription = "0x7284e416", selLatestRoundData = "0xfeaf968c", selGetFeed = "0xd2edb6dd";
  const FEED_REGISTRY = "0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf";
  const pad32 = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
  const state = { root: o.root, spent: false, next: o.nextLeafIndex, feeds: { ...(o.feeds ?? {}) } as Record<string, MockFeed>, calls: 0 };
  const feedAt = (to: string) => Object.entries(state.feeds).find(([a]) => a.toLowerCase() === to.toLowerCase())?.[1];
  const logFor = (leafIndex: number, l: { commitment: bigint; noteData: Hex }) => ({
    address: o.core.toLowerCase(), topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
    blockNumber: "0x5", blockHash: "0x" + "22".repeat(32), transactionHash: ("0x" + "33".repeat(31) + leafIndex.toString(16).padStart(2, "0")) as Hex, transactionIndex: "0x0", logIndex: toHex(leafIndex), removed: false,
  });
  function handle(req: { id: number; method: string; params: any[] }) {
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId": return res("0x7a69");
      case "eth_blockNumber": return res("0x10");
      case "eth_getLogs": return res(Object.entries(o.events).map(([i, l]) => logFor(Number(i), l)));
      case "eth_call": {
        state.calls++;
        const data: string = req.params[0].data;
        const to: string = String(req.params[0].to ?? "").toLowerCase();
        if (to === FEED_REGISTRY && data.startsWith(selGetFeed)) {
          const base = "0x" + data.slice(10, 74).slice(24);
          const feed = Object.entries(o.registry ?? {}).find(([b]) => b.toLowerCase() === base.toLowerCase())?.[1];
          return feed ? res(pad32(BigInt(feed))) : { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock registry: Feed not found" } };
        }
        const feed = feedAt(to);
        if (feed) {
          if (data.startsWith(selDescription)) return res(encodeAbiParameters([{ type: "string" }], [feed.description]));
          if (data.startsWith(selLatestRoundData)) return res(encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [feed.roundId ?? 1n, feed.answer, BigInt(feed.updatedAt), BigInt(feed.updatedAt), feed.roundId ?? 1n]));
          return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock feed: unknown call" } };
        }
        if (data.startsWith(selNext)) return res(pad32(BigInt(state.next)));
        if (data.startsWith(selRoot)) return res(pad32(state.root));
        if (data.startsWith(selSpent)) return res(pad32(state.spent ? 1n : 0n));
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
      }
      default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock rpc: ${req.method} unsupported` } };
    }
  }
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const j = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j))); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
