// A Protect's receipt through the connected wallet's own provider (the sixth review round, 2026-11-03): the privacy endpoints are
// never asked for the hash of a transaction whose `from` is the user's public address. A provider that does not answer the
// method, or none at all, leaves the endpoints' read as before.
import { afterEach, describe, expect, it } from "vitest";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { minedTx, receiptViaInjectedWallet } from "../src/chain";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const rawReceipt = {
  transactionHash: HASH,
  transactionIndex: "0x1",
  blockHash: "0x" + "22".repeat(32),
  blockNumber: "0x10",
  from: "0x" + "11".repeat(20),
  to: "0x" + "33".repeat(20),
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00",
  contractAddress: null,
  logs: [],
  logsBloom: "0x" + "00".repeat(256),
  status: "0x1",
  type: "0x2",
};
afterEach(() => setActiveProvider(null));

describe("receiptViaInjectedWallet", () => {
  it("polls the connected wallet's provider for the receipt and returns it formatted; minedTx takes it without asking any endpoint", async () => {
    const asked: string[] = [];
    let answers = 0;
    setActiveProvider({
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        if (method !== "eth_getTransactionReceipt") throw new Error(`unexpected ${method}`);
        return ++answers < 2 ? null : rawReceipt; // pending once, then mined
      },
    } as never);
    const r = await receiptViaInjectedWallet(HASH, { timeoutMs: 10_000, intervalMs: 5 });
    expect(r?.status).toBe("success");
    expect(r?.gasUsed).toBe(21000n);
    expect(r?.effectiveGasPrice).toBe(1_000_000_000n);
    expect(asked).toEqual(["eth_getTransactionReceipt", "eth_getTransactionReceipt"]);
    const client = {
      waitForTransactionReceipt: async () => {
        throw new Error("the endpoints must not be asked");
      },
    };
    const m = await minedTx(client as never, HASH, undefined, [client as never], { receipt: r! });
    expect(m.costWei).toBe(21000n * 1_000_000_000n);
    expect(m.inserted).toEqual([]);
    expect(m.blockNumber).toBe(16);
  });
  it("no provider, a provider without the method, or no answer in time: null — the endpoints are read as before", async () => {
    expect(await receiptViaInjectedWallet(HASH, { timeoutMs: 50, intervalMs: 5 })).toBeNull();
    setActiveProvider({
      request: async () => {
        throw new Error("unsupported method");
      },
    } as never);
    expect(await receiptViaInjectedWallet(HASH, { timeoutMs: 50, intervalMs: 5 })).toBeNull();
    let polls = 0;
    setActiveProvider({
      request: async () => {
        polls++;
        return null;
      },
    } as never);
    expect(await receiptViaInjectedWallet(HASH, { timeoutMs: 30, intervalMs: 5 }), "never mined within the time").toBeNull();
    // the connected wallet on another network than the transaction's: it never finds the receipt — given up at once, the endpoints read
    const asked: string[] = [];
    setActiveProvider({
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        return method === "eth_chainId" ? "0x2105" : rawReceipt;
      },
    } as never);
    expect(await receiptViaInjectedWallet(HASH, { timeoutMs: 10_000, intervalMs: 5, chainId: 1 })).toBeNull();
    expect(asked, "no receipt asked of another network").toEqual(["eth_chainId"]);
    setActiveProvider({ request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : rawReceipt) } as never);
    expect((await receiptViaInjectedWallet(HASH, { timeoutMs: 10_000, intervalMs: 5, chainId: 1 }))?.status, "the right network: read").toBe("success");
    // the flow over (a lock, a replace): the poll stops at once instead of running on
    setActiveProvider({
      request: async () => {
        polls++;
        return null;
      },
    } as never);
    polls = 0;
    expect(await receiptViaInjectedWallet(HASH, { timeoutMs: 10_000, intervalMs: 5, stop: () => polls >= 2 })).toBeNull();
    expect(polls).toBe(2);
  });
});
