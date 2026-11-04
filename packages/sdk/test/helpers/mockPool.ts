// A configurable loopback JSON-RPC pool (the ninth review round's chain probes, kept as a test helper): NoteInserted logs (duplicates allowed, any order),
// ShieldedTransaction spends, vault Deposited logs, nextLeafIndex/currentRoot/isNullifierSpent, a chosen eth_blockNumber,
// receipts by hash; every request recorded (method + params). Filters getLogs by address and topic0 like a node.
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, toFunctionSelector, toHex, type Hex } from "viem";
import { coreAbi } from "../../src/privacyProtocol";

export interface Insert {
  leafIndex: number;
  commitment: bigint;
  noteData: Hex;
  txHash?: Hex;
}
export interface Spend {
  n0: bigint;
  n1: bigint;
  txHash?: Hex;
}
export interface Dep {
  vault: string;
  ownerCommitment: bigint;
  amount: bigint;
  leafIndex: number;
}
const deposited = parseAbiItem("event Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex)");

export async function startPool(o: { core: string; inserts: Insert[]; next: number; root: bigint; block?: bigint }) {
  const state = {
    inserts: [...o.inserts],
    spends: [] as Spend[],
    deposits: [] as Dep[],
    next: o.next,
    root: o.root,
    block: o.block ?? 0x80n,
    spentBits: new Set<bigint>(),
    receipts: {} as Record<string, unknown>,
    log: [] as { method: string; params: unknown[] }[],
  };
  const core = o.core.toLowerCase();
  const sel = {
    next: toFunctionSelector("nextLeafIndex()"),
    root: toFunctionSelector("currentRoot()"),
    spent: toFunctionSelector("isNullifierSpent(uint256)"),
  };
  const pad = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
  const base = (i: number, tx: Hex) => ({
    blockNumber: "0x5",
    blockHash: "0x" + "22".repeat(32),
    transactionHash: tx,
    transactionIndex: "0x0",
    logIndex: toHex(i),
    removed: false,
  });
  const noteLog = (l: Insert, i: number) => ({
    address: core,
    topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: l.leafIndex } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
    ...base(i, l.txHash ?? (("0x" + "33".repeat(28) + l.leafIndex.toString(16).padStart(8, "0")) as Hex)),
  });
  const spendLog = (s: Spend, i: number) => ({
    address: core,
    topics: encodeEventTopics({ abi: coreAbi, eventName: "ShieldedTransaction" }),
    data: encodeAbiParameters(Array(5).fill({ type: "uint256" }), [s.n0, s.n1, 0n, 0n, 0n]),
    ...base(1000 + i, s.txHash ?? (("0x" + "55".repeat(31) + i.toString(16).padStart(2, "0")) as Hex)),
  });
  const depLog = (d: Dep, i: number) => ({
    address: d.vault.toLowerCase(),
    topics: encodeEventTopics({ abi: [deposited], eventName: "Deposited", args: { ownerCommitment: pad(d.ownerCommitment) } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }], [d.amount, d.leafIndex]),
    ...base(2000 + i, ("0x" + "66".repeat(31) + i.toString(16).padStart(2, "0")) as Hex),
  });
  function handle(req: { id: number; method: string; params: unknown[] }) {
    state.log.push({ method: req.method, params: req.params ?? [] });
    const res = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "eth_chainId":
        return res("0x1");
      case "eth_blockNumber":
        return res(toHex(state.block));
      case "eth_getLogs": {
        const f = (req.params[0] ?? {}) as { address?: string | string[]; topics?: (string | string[] | null)[] };
        const addrs = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a: string) => a.toLowerCase());
        const t0 = f.topics?.[0];
        const want = (topic: string) =>
          !t0 || (Array.isArray(t0) ? t0.map((x: string) => x.toLowerCase()).includes(topic.toLowerCase()) : t0.toLowerCase() === topic.toLowerCase());
        const all = [...state.inserts.map(noteLog), ...state.spends.map(spendLog), ...state.deposits.map(depLog)];
        return res(all.filter((l) => (!addrs.length || addrs.includes(l.address)) && want(l.topics[0] as string)));
      }
      case "eth_call": {
        const data = (req.params[0] as { data: string }).data;
        if (data.startsWith(sel.next)) return res(pad(BigInt(state.next)));
        if (data.startsWith(sel.root)) return res(pad(state.root));
        if (data.startsWith(sel.spent)) return res(pad(state.spentBits.has(BigInt("0x" + data.slice(10, 74))) ? 1n : 0n));
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
      }
      case "eth_getTransactionReceipt":
        return res(state.receipts[String(req.params[0]).toLowerCase()] ?? null);
      case "eth_getTransactionByHash":
        return res(null);
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock: ${req.method} unsupported` } };
    }
  }
  const server: Server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const j = JSON.parse(body);
      rs.setHeader("content-type", "application/json");
      rs.end(JSON.stringify(Array.isArray(j) ? j.map(handle) : handle(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
