// What a transaction spends, read from the chain (audit round 2, n12): a Send through a smart-contract account (a 4337
// bundle, a Safe) calls the core from another contract — its transaction's `to` is not the core —, and it had been read
// "not this spend" after a reload, its record needing recovery. Mined, the core's own ShieldedTransaction events say it.
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from "viem";
import { coreAbi } from "../src/privacyProtocol";
import type { Deployment } from "../src/chain";

const CORE = "0x00000000000000000000000000000000000000c0";
const OTHER = "0x0000000000000000000000000000000000000bad";
const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const h = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const spendLog = (address: string, n0: bigint, n1: bigint) => ({
  address,
  topics: encodeEventTopics({ abi: coreAbi, eventName: "ShieldedTransaction" }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [n0, n1, 1n, 2n, 3n]),
});
const receipts: Record<string, unknown> = {};
const txs: Record<string, unknown> = {};
const client = {
  getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    if (!receipts[hash]) throw new TransactionReceiptNotFoundError({ hash });
    return receipts[hash];
  },
  getTransaction: async ({ hash }: { hash: Hex }) => {
    if (!txs[hash]) throw new TransactionNotFoundError({ hash });
    return txs[hash];
  },
};
vi.mock("../src/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain")>()),
  clientFor: () => client,
  outcomeReads: () => ({ receipt: async () => null, txKnown: async () => false, spent: async () => false }),
}));

import { staleReads } from "../src/operations/stale";

const pi = {
  root: 1n,
  nullifier0: 7n,
  nullifier1: 8n,
  outputBody0: 0n,
  outputBody1: 0n,
  outputBody2: 0n,
  mode: 0n,
  withdrawalVault: 0n,
  withdrawalAmount: 0n,
  withdrawalRecipient: 0n,
  noteData0Hash: 0n,
  noteData1Hash: 0n,
  noteData2Hash: 0n,
  txDomain: 0n,
};
const transact = encodeFunctionData({ abi: coreAbi, functionName: "transact", args: ["0x", pi, "0x", "0x", "0x"] });

describe("what a transaction spends (audit round 2, n12)", () => {
  it("mined, from the core's own events, whoever called it; reverted or pending, from its own call to the core", async () => {
    const reads = staleReads({
      chainId: 1,
      core: CORE,
      ethVault: CORE,
      rpcUrl: "http://x",
      rpcUrls: ["http://x"],
      fromBlock: 0n,
      erc20Vaults: [],
    } as unknown as Deployment);
    // through a smart account: the entry point calls the account, the account calls the core
    receipts[h(1)] = { status: "success", logs: [spendLog(CORE, 7n, 8n), spendLog(OTHER, 70n, 80n)] };
    txs[h(1)] = { to: ENTRY_POINT, input: "0x" };
    expect(await reads.txSpends(h(1)), "the core's event; another contract's ignored").toEqual([[7n, 8n]]);
    // a direct call that reverted: its call says what it would have spent, as before
    receipts[h(2)] = { status: "reverted", logs: [] };
    txs[h(2)] = { to: CORE, input: transact };
    expect(await reads.txSpends(h(2))).toEqual([[7n, 8n]]);
    // pending
    txs[h(3)] = { to: CORE, input: transact };
    expect(await reads.txSpends(h(3))).toEqual([[7n, 8n]]);
    expect(await reads.txSpends(h(4)), "unknown to the node").toBeNull();
  });
});
