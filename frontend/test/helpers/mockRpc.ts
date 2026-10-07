// A loopback JSON-RPC mock of one deployed core for the wallet's sync / discovery tests: NoteInserted
// events at fixed leaf indexes, nextLeafIndex(), currentRoot(), isNullifierSpent(). Batched requests
// are answered element-wise, like a real endpoint. No chain, no funds.
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, toFunctionSelector, toHex, type Hex } from "viem";
import { coreAbi } from "../../src/sdk/privacyProtocol";

export interface MockCoreOptions { core: string; events: Record<number, { commitment: bigint; noteData: Hex }>; nextLeafIndex: number; root: bigint }

export async function startMockCore(o: MockCoreOptions) {
  const selNext = toFunctionSelector("nextLeafIndex()");
  const selRoot = toFunctionSelector("currentRoot()");
  const selSpent = toFunctionSelector("isNullifierSpent(uint256)");
  const pad32 = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
  const state = { root: o.root, spent: false, next: o.nextLeafIndex };
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
        const data: string = req.params[0].data;
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
