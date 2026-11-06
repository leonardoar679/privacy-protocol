// A Protect's receipt through the connected wallet's own provider (the sixth review round, 2026-11-03): the privacy endpoints are
// never asked for the hash of a transaction whose `from` is the user's public address. A provider that does not answer the method,
// or none at all, gives the caller none — and since the eleventh review round (F11-10) the caller never reads the endpoints in its
// place: a deposit ends deposit_unconfirmed and the scan records it, an approval stops (WalletConnect's excepted, audit gap 100).
import { afterEach, describe, expect, it } from "vitest";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { minedTx, walletReceipt } from "../src/chain";

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

describe("walletReceipt", () => {
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
    const got = await walletReceipt(HASH, { timeoutMs: 10_000, intervalMs: 5 });
    const r = "receipt" in got ? got.receipt : null;
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
  it("no provider, a provider without the method, no answer in time, another network, the flow over: no receipt, and why (F11-10: what the caller may do instead depends on it)", async () => {
    expect(await walletReceipt(HASH, { timeoutMs: 50, intervalMs: 5 })).toEqual({ none: "no-provider" });
    setActiveProvider({
      request: async () => {
        throw new Error("unsupported method");
      },
    } as never);
    expect(await walletReceipt(HASH, { timeoutMs: 50, intervalMs: 5 }), "it never answered: a provider that cannot read").toEqual({ none: "unreadable" });
    let polls = 0;
    setActiveProvider({
      request: async () => {
        polls++;
        return null;
      },
    } as never);
    expect(await walletReceipt(HASH, { timeoutMs: 30, intervalMs: 5 }), "never mined within the time").toEqual({ none: "timeout" });
    // the connected wallet on another network than the transaction's: it never finds the receipt — given up at once
    const asked: string[] = [];
    setActiveProvider({
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        return method === "eth_chainId" ? "0x2105" : rawReceipt;
      },
    } as never);
    expect(await walletReceipt(HASH, { timeoutMs: 10_000, intervalMs: 5, chainId: 1 })).toEqual({ none: "other-chain" });
    expect(asked, "no receipt asked of another network").toEqual(["eth_chainId"]);
    setActiveProvider({ request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : rawReceipt) } as never);
    const right = await walletReceipt(HASH, { timeoutMs: 10_000, intervalMs: 5, chainId: 1 });
    expect("receipt" in right && right.receipt.status, "the right network: read").toBe("success");
    // the flow over (a lock, a replace): the poll stops at once instead of running on
    setActiveProvider({
      request: async () => {
        polls++;
        return null;
      },
    } as never);
    polls = 0;
    expect(await walletReceipt(HASH, { timeoutMs: 10_000, intervalMs: 5, stop: () => polls >= 2 })).toEqual({ none: "stopped" });
    expect(polls).toBe(2);
  });
});
