// @vitest-environment happy-dom
// The wallet side (spec v3.0 §7.5–§7.6; V7 Stage 8): the call data of a deposit through the router and of a wallet-mode
// withdrawal held to real mainnet transactions; the wallets a page can see (EIP-6963, the legacy provider last); the
// connection on mainnet or nothing; a transaction handed to the wallet and its receipt read from the app's endpoints.
import { describe, expect, it } from "vitest";
import type { Rpc } from "../src/history/sync";
import {
  decodePoolWithdraw,
  decodeRouterDeposit,
  encodePoolDeposit,
  encodePoolWithdraw,
  encodeRouterDeposit,
  encodeRouterWithdraw,
  relayerArgs,
  SELECTORS,
  type Hex,
} from "../src/wallet/calldata";
import { connect, MAINNET_CHAIN_ID, receiptOf, reconnect, sendTransaction, stateOf, waitForReceipt, watch } from "../src/wallet/connection";
import { discoverWallets, type Eip1193Provider } from "../src/wallet/injected";
import txs from "./fixtures/relayers/transactions.json";

const POOL = "0xa160cdab225685da1d56aa342ad8841c3b53f291" as const;
const ROUTER = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b" as const;
const word = (x: bigint | number) => BigInt(x).toString(16).padStart(64, "0");

describe("the call data against real transactions", () => {
  it("a real deposit through the router: the pool, the Deposit log's commitment, no encrypted note; re-encoded byte for byte", () => {
    const tx = txs.deposit.tx;
    expect(tx.to.toLowerCase()).toBe(ROUTER);
    expect(BigInt(tx.value)).toBe(100n * 10n ** 18n);
    const d = decodeRouterDeposit(tx.input as Hex);
    expect(d.instance).toBe(POOL);
    expect(d.commitment).toBe(txs.deposit.log.topics[1].toLowerCase());
    expect(d.encryptedNote).toBe("0x");
    expect(encodeRouterDeposit(d.instance, d.commitment, d.encryptedNote)).toBe(tx.input.toLowerCase());
    expect(encodeRouterDeposit(POOL, d.commitment)).toBe(tx.input.toLowerCase());
    expect(tx.input.startsWith(SELECTORS.routerDeposit)).toBe(true);
    expect(encodePoolDeposit(d.commitment)).toBe(`${SELECTORS.poolDeposit}${d.commitment.slice(2)}`);
  });

  it("a real wallet-mode withdrawal straight to the pool: no relayer, no fee, the Withdrawal log's nullifier hash; re-encoded byte for byte", () => {
    const tx = txs.withdrawal.tx;
    expect(tx.to.toLowerCase()).toBe(POOL);
    const a = decodePoolWithdraw(tx.input as Hex);
    expect(a.proof).toMatch(/^0x[0-9a-f]{512}$/);
    expect(a.relayer).toBe(`0x${"00".repeat(20)}`);
    expect(a.feeWei).toBe(0n);
    expect(a.refundWei).toBe(0n);
    expect(a.recipient).toMatch(/^0x[0-9a-f]{40}$/);
    const log = txs.withdrawal.log;
    expect(a.nullifierHash).toBe(`0x${log.data.slice(2 + 64, 2 + 128)}`);
    expect(encodePoolWithdraw(a)).toBe(tx.input.toLowerCase());
    // through the router: the instance first, the proof's offset after eight words
    const viaRouter = encodeRouterWithdraw(POOL, a);
    expect(viaRouter.startsWith(SELECTORS.routerWithdraw)).toBe(true);
    expect(viaRouter.slice(10, 74)).toBe(POOL.slice(2).padStart(64, "0"));
    expect(viaRouter.slice(74, 138)).toBe(word(8 * 32));
    expect(viaRouter.length).toBe(10 + 64 * 8 + 64 + 512);
    expect(viaRouter.slice(10 + 64 * 8)).toBe(tx.input.toLowerCase().slice(10 + 64 * 7));
    const args = relayerArgs(a);
    expect(args).toEqual([a.root, a.nullifierHash, a.recipient, a.relayer, `0x${word(0)}`, `0x${word(0)}`]);
  });

  it("refuses malformed inputs", () => {
    const a = decodePoolWithdraw(txs.withdrawal.tx.input as Hex);
    expect(() => encodePoolWithdraw({ ...a, proof: "0x12" })).toThrow(/512 hex/);
    expect(() => encodePoolWithdraw({ ...a, recipient: "0x12" })).toThrow(/address/);
    expect(() => encodePoolWithdraw({ ...a, root: "0x12" })).toThrow(/bytes32/);
    expect(() => encodePoolWithdraw({ ...a, feeWei: -1n })).toThrow(/256 bits/);
    expect(() => encodeRouterDeposit(POOL, a.root, "0x123")).toThrow(/whole hex bytes/);
    expect(() => decodeRouterDeposit(txs.withdrawal.tx.input as Hex)).toThrow(/not router\.deposit/);
  });
});

const fakeProvider = (
  answers: Record<string, unknown>,
  seen: { method: string; params?: unknown }[] = [],
): Eip1193Provider & { listeners: Record<string, ((...a: unknown[]) => void)[]> } => ({
  listeners: {},
  async request({ method, params }) {
    seen.push({ method, params });
    if (method in answers) return answers[method];
    throw new Error(`no answer for ${method}`);
  },
  on(event, listener) {
    (this.listeners[event] ??= []).push(listener);
  },
  removeListener(event, listener) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== listener);
  },
});

describe("the wallets a page can see", () => {
  it("EIP-6963 announcements answer the request; the legacy provider is used only when nothing announced; nothing is nothing", async () => {
    const announced = fakeProvider({});
    const onRequest = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: { info: { uuid: "u1", name: "Wallet One", icon: "data:image/svg+xml,", rdns: "one.example" }, provider: announced },
        }),
      );
    window.addEventListener("eip6963:requestProvider", onRequest);
    (window as unknown as { ethereum?: unknown }).ethereum = fakeProvider({});
    const found = await discoverWallets(20);
    window.removeEventListener("eip6963:requestProvider", onRequest);
    expect(found.map((w) => w.info)).toEqual([{ id: "one.example", name: "Wallet One", icon: "data:image/svg+xml," }]);
    expect(found[0].provider).toBe(announced);
    const legacyOnly = await discoverWallets(20);
    expect(legacyOnly.map((w) => w.info.id)).toEqual(["injected"]);
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    expect(await discoverWallets(20)).toEqual([]);
  });
});

describe("the connection", () => {
  const ACCOUNT = "0x75B9758bbA5671c1E71c533a3fa5557f85126C3E";

  it("one account on mainnet is connected; another chain is the wrong network; no account is disconnected", async () => {
    const seen: { method: string }[] = [];
    const p = fakeProvider({ eth_requestAccounts: [ACCOUNT], eth_chainId: "0x1" }, seen);
    expect(await connect(p)).toEqual({ status: "connected", account: ACCOUNT.toLowerCase(), chainId: 1 });
    expect(seen.map((s) => s.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
    expect(await connect(fakeProvider({ eth_requestAccounts: [ACCOUNT], eth_chainId: "0xaa36a7" }))).toEqual({
      status: "wrong-network",
      account: ACCOUNT.toLowerCase(),
      chainId: 11155111,
    });
    expect(await connect(fakeProvider({ eth_requestAccounts: [], eth_chainId: "0x1" }))).toEqual({ status: "disconnected" });
    expect(await reconnect(fakeProvider({ eth_accounts: [], eth_chainId: "0x1" }))).toEqual({ status: "disconnected" });
    expect(await reconnect(fakeProvider({ eth_accounts: [ACCOUNT], eth_chainId: "0x1" }))).toEqual({
      status: "connected",
      account: ACCOUNT.toLowerCase(),
      chainId: 1,
    });
    expect(stateOf([], 1)).toEqual({ status: "disconnected" });
    expect(MAINNET_CHAIN_ID).toBe(1);
    await expect(connect(fakeProvider({ eth_requestAccounts: "nope", eth_chainId: "0x1" }))).rejects.toThrow(/no accounts/);
    await expect(connect(fakeProvider({ eth_requestAccounts: [ACCOUNT], eth_chainId: "zz" }))).rejects.toThrow(/no chain id/);
  });

  it("follows account and chain changes until unsubscribed", () => {
    const p = fakeProvider({});
    const changes: unknown[] = [];
    const stop = watch(p, (c) => changes.push(c));
    expect(Object.keys(p.listeners).sort()).toEqual(["accountsChanged", "chainChanged"]);
    p.listeners.accountsChanged[0]([ACCOUNT]);
    p.listeners.chainChanged[0]("0x5");
    expect(changes).toEqual([{ accounts: [ACCOUNT.toLowerCase()] }, { chainId: 5 }]);
    stop();
    expect(p.listeners.accountsChanged).toEqual([]);
    expect(p.listeners.chainChanged).toEqual([]);
  });

  it("hands the transaction to the wallet with the value in hex and reads the receipt from the app's endpoints", async () => {
    const seen: { method: string; params?: unknown }[] = [];
    const hash = `0x${word(77)}` as Hex;
    const p = fakeProvider({ eth_sendTransaction: hash }, seen);
    const tx = { from: ACCOUNT.toLowerCase() as Hex, to: ROUTER, data: encodeRouterDeposit(POOL, `0x${word(5)}`), valueWei: 100n * 10n ** 18n };
    expect(await sendTransaction(p, tx)).toBe(hash);
    expect(seen[0]).toEqual({ method: "eth_sendTransaction", params: [{ from: tx.from, to: ROUTER, data: tx.data, value: "0x56bc75e2d63100000" }] });
    await expect(sendTransaction(fakeProvider({ eth_sendTransaction: "0x12" }), tx)).rejects.toThrow(/no transaction hash/);
    const receipts: unknown[] = [null, null, { status: "0x1", blockNumber: "0x190f0b4", transactionHash: hash }];
    const rpc: Rpc = async (method) => {
      expect(method).toBe("eth_getTransactionReceipt");
      return receipts.shift();
    };
    expect(await receiptOf(rpc, hash)).toBeNull();
    const slept: number[] = [];
    const r = await waitForReceipt(rpc, hash, { pollMs: 4000, sleep: async (ms) => void slept.push(ms) });
    expect(r).toEqual({ status: "success", blockNumber: 0x190f0b4, transactionHash: hash });
    expect(slept).toEqual([4000]);
    let clock = 0;
    await expect(
      waitForReceipt(async () => null, hash, { pollMs: 1000, maxMs: 2500, sleep: async () => void (clock += 1000), now: () => clock }),
    ).rejects.toThrow(/not mined in time/);
    expect(await receiptOf(async () => ({ status: "0x0", blockNumber: "0x10" }), hash)).toEqual({ status: "reverted", blockNumber: 16, transactionHash: hash });
  });
});
