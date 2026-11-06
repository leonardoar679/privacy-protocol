// A protect approves exactly its amount, from what the connected account already has open (a V6 follow-up of
// 2026-10-16). A deposit that failed or was refused leaves its approval behind, and USDT — like a few other tokens —
// refuses to change one non-zero allowance to another: its approve() reverts. A retry of the same protect then failed at
// its approval. Now an approval of exactly the amount is used as it is, and another amount is cleared to zero first.
// The real submitShield runs here against a chain fake and an injected wallet that keeps USDT's rule.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { configure, defaultConfig } from "../src/config";
import type { Deployment } from "../src/chain";
import { erc20Abi } from "../src/privacyProtocol";
import { approvalsFor, prepareShield, submitShield } from "../src/privateTx";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { CORE_IDS, POSEIDON2_ONE_TWO_THREE, WRAPPED_NATIVE_OF } from "@privacy-wallet/contracts/deployments";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469" as const;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const USDT_VAULT = "0x00000000000000000000000000000000000000C3" as const;
const ROUTER = "0x00000000000000000000000000000000000000a1" as const;
const OWNER = "0x00000000000000000000000000000000000000b0";
const ZERO = "0x0000000000000000000000000000000000000000";
const HASHER = "0x00000000000000000000000000000000000000E5" as const; // the core's Poseidon2 hasher
const deployment: Deployment = {
  chainId: 1,
  core: CORE,
  ethVault: ETH_VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDT", decimals: 6, token: USDT, vault: USDT_VAULT }],
  protectRouter: ROUTER,
};

/** What the chain and the connected wallet hold: the allowance toward the router, what was sent, each receipt. */
const w = vi.hoisted(() => ({
  allowance: 0n,
  sent: [] as { fn: "approve" | "deposit"; amount?: bigint; reverted: boolean }[],
  receipts: new Map<string, "success" | "reverted">(),
  commitment: 0n,
  /** the connected wallet's network, and the one it switches to after `switchAfter` sends (the deployment's is chain 1) */
  chain: "0x1",
  switchTo: null as null | { after: number; chain: string },
  /** the network the wallet switches to right after it answered an approval's receipt (the eleventh review round's critique of F11-10) */
  switchOnReceipt: null as null | string,
  /** V7 Stage 16: the session locks right after this many sends (a phone's handoff, or Lock) */
  lockAfter: null as null | number,
  /** the eighth review round (C-L6): the account the wallet names, and the one it switches to after `after` sends */
  account: "0x00000000000000000000000000000000000000b0",
  accountAfter: null as null | { after: number; account: string },
  chainIds: [] as string[],
  provider: null as null | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
}));
vi.mock("@privacy-wallet/wallet-engine/injected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/injected")>()),
  activeProvider: () => w.provider,
}));
const client = {
  // the deployment check before the first operation (packages/sdk/test/deployment-guard.test.ts)
  getChainId: async () => 1,
  readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
    if (address === CORE)
      return (
        {
          PROTOCOL_ID: CORE_IDS.protocolId,
          CIRCUIT_ID: CORE_IDS.circuitId,
          HASH_ID: CORE_IDS.hashId,
          VERIFIER: "0x00000000000000000000000000000000000000Ab",
          VAULT_FACTORY: FACTORY,
          LEVELS: 32n,
          HASHER,
        } as Record<string, unknown>
      )[functionName];
    if (address === FACTORY && functionName === "vaultOf")
      return ({ [ZERO]: ETH_VAULT, [USDT.toLowerCase()]: USDT_VAULT } as Record<string, string>)[String(args![0]).toLowerCase()] ?? ZERO;
    if (functionName === "VAULT_VERSION") return 1n;
    if (functionName === "INNER") return "0x00000000000000000000000000000000000000Cd"; // the key behind the adapter (the fifth review round, 2026-11-03)
    if (address === ROUTER && functionName === "CORE") return CORE;
    if (address === USDT && functionName === "decimals") return 6; // the token's own, as configured (critic gap 1)
    if (functionName === "poseidon2") return POSEIDON2_ONE_TWO_THREE; // the build's Poseidon2 on [1, 2, 3] (the eleventh review round, G11-1)
    if (functionName === "WRAPPED_NATIVE") return WRAPPED_NATIVE_OF[1]; // both factories take the chain's WETH (G11-6)
    throw new Error(`unexpected read ${address}.${functionName}`);
  },
  waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
    status: w.receipts.get(hash) ?? "success",
    gasUsed: 50_000n,
    effectiveGasPrice: 1n,
    logs: [],
  }),
};
vi.mock("../src/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/chain")>()),
  clientFor: () => client,
  // the deposit's receipt: the note inserted at leaf 7 (the protect's own commitment)
  minedTx: async (_c: unknown, hash: string) => {
    if (w.receipts.get(hash) !== "success") throw new Error(`transaction ${hash} reverted`);
    return { inserted: [{ leafIndex: 7, commitment: w.commitment }], costWei: 1n };
  },
}));

/** A wallet's raw receipt: the status the chain gave the transaction (its gas as the endpoints' fake gives it). */
const rawReceipt = (hash: string) => ({
  blockHash: `0x${"aa".repeat(32)}`,
  blockNumber: "0x10",
  contractAddress: null,
  cumulativeGasUsed: "0xc350",
  effectiveGasPrice: "0x1",
  from: w.account,
  gasUsed: "0xc350",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: w.receipts.get(hash) === "reverted" ? "0x0" : "0x1",
  to: ROUTER,
  transactionHash: hash,
  transactionIndex: "0x0",
  type: "0x2",
});
/**
 * The connected wallet over a token that keeps USDT's rule: approve(non-zero) reverts while a non-zero allowance is open. Its own node gives
 * the receipts (the eleventh review round, F11-10: a Protect's receipts come from the connected wallet only).
 */
const usdtWallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [w.account];
    if (method === "eth_chainId") return w.chain;
    if (method === "eth_call") return encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: w.allowance });
    if (method === "eth_getTransactionReceipt") {
      const r = w.receipts.has(String(params![0])) ? rawReceipt(String(params![0])) : null;
      if (r && w.switchOnReceipt) w.chain = w.switchOnReceipt; // confirmed; then the user switches network
      return r;
    }
    if (method === "eth_sendTransaction") {
      const tx = params![0] as { to: string; data: Hex; chainId?: string };
      w.chainIds.push(String(tx.chainId));
      if (w.switchTo && w.sent.length + 1 === w.switchTo.after) w.chain = w.switchTo.chain; // the user switches network after this send
      const hash = `0x${(w.sent.length + 1).toString(16).padStart(64, "0")}`;
      if (tx.to.toLowerCase() === USDT.toLowerCase()) {
        const amount = (decodeFunctionData({ abi: erc20Abi, data: tx.data }).args as readonly [Address, bigint])[1];
        const reverted = amount !== 0n && w.allowance !== 0n; // require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))
        if (!reverted) w.allowance = amount;
        w.sent.push({ fn: "approve", amount, reverted });
        w.receipts.set(hash, reverted ? "reverted" : "success");
      } else {
        w.sent.push({ fn: "deposit", reverted: false });
        w.allowance = 0n; // the router pulls exactly the approved amount
        w.receipts.set(hash, "success");
      }
      if (w.lockAfter !== null && w.sent.length === w.lockAfter) session.lock();
      if (w.accountAfter && w.sent.length === w.accountAfter.after) w.account = w.accountAfter.account;
      return hash;
    }
    throw new Error(`unexpected ${method}`);
  },
};

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  w.provider = usdtWallet;
});
beforeEach(() => {
  w.account = OWNER;
  w.accountAfter = null;
  w.sent.length = 0;
  w.receipts.clear();
  w.chain = "0x1";
  w.switchTo = null;
  w.switchOnReceipt = null;
  w.chainIds.length = 0;
  w.lockAfter = null;
});

const AMOUNT = 5_000_000n; // 5 USDT
async function protect(open: bigint) {
  w.allowance = open;
  const p = prepareShield({ masterSeed: session.state().seed!, deployment, amount: AMOUNT, token: USDT, vault: USDT_VAULT });
  w.commitment = noteCommitment(noteBody(p.note), 7n);
  const events: { type: string; step?: string; i?: number; n?: number }[] = [];
  const r = await submitShield(p, { onEvent: (e) => events.push(e as never) });
  const prompts = events.filter((e) => e.type === "wallet-prompt").map((e) => `${e.step} ${e.i}/${e.n}`);
  return {
    r,
    prompts,
    approved: events.filter((e) => e.type === "approved").length,
    sent: w.sent.map((s) => (s.fn === "approve" ? `approve ${s.amount}` : s.fn)),
  };
}

describe("a protect's approvals (a V6 follow-up of 2026-10-16)", () => {
  it("approvalsFor: none for exactly the amount, approve(0) first for another one, approve(amount) otherwise", () => {
    const amounts = (open: bigint | null) =>
      approvalsFor(open, USDT, ROUTER, AMOUNT).map((tx) => (decodeFunctionData({ abi: erc20Abi, data: tx.data }).args as readonly [Address, bigint])[1]);
    expect(amounts(0n)).toEqual([AMOUNT]);
    expect(amounts(null), "unreadable (a WalletConnect provider's reads): cleared first, as another open amount (the eighth review round, C-L7)").toEqual([
      0n,
      AMOUNT,
    ]);
    expect(amounts(AMOUNT), "what a refused deposit left").toEqual([]);
    expect(amounts(1_000_000n)).toEqual([0n, AMOUNT]);
    expect(amounts(2n ** 256n - 1n), "even an unlimited one: narrowed to the amount").toEqual([0n, AMOUNT]);
    expect(approvalsFor(0n, USDT, ROUTER, AMOUNT)[0]).toMatchObject({ to: USDT });
  });

  it("every prompt from the account the Review showed (the eighth review round, C-L6): an account switched after the approval is refused at the deposit, nothing more sent", async () => {
    w.allowance = 0n;
    w.accountAfter = { after: 1, account: "0x00000000000000000000000000000000000000c7" };
    const p = prepareShield({ masterSeed: session.state().seed!, deployment, amount: AMOUNT, token: USDT, vault: USDT_VAULT });
    w.commitment = noteCommitment(noteBody(p.note), 7n);
    const err = await submitShield(p, { account: OWNER }).catch((e) => e);
    expect((err as Error).name).toBe("WalletOtherAccount");
    expect(
      w.sent.map((s) => s.fn),
      "the approval only: no deposit from another account",
    ).toEqual(["approve"]);
  });

  it("a first protect approves exactly its amount, then deposits", async () => {
    const { r, prompts, approved, sent } = await protect(0n);
    expect(sent).toEqual([`approve ${AMOUNT}`, "deposit"]);
    expect(prompts).toEqual(["approve 1/2", "deposit 2/2"]);
    expect([approved, !!r.approveTx, r.leafIndex]).toEqual([1, true, 7]);
  });

  it("a retry after a refused deposit uses the approval that one left: no second approval, which USDT would refuse", async () => {
    const { r, prompts, approved, sent } = await protect(AMOUNT);
    expect(sent).toEqual(["deposit"]);
    expect(prompts).toEqual(["deposit 1/1"]);
    expect([approved, r.approveTx, r.leafIndex]).toEqual([0, undefined, 7]);
  });

  it("another amount open: cleared to zero, approved for exactly the amount, deposited — nothing reverted, nothing left", async () => {
    const { prompts, approved, sent } = await protect(1_000_000n);
    expect(sent).toEqual(["approve 0", `approve ${AMOUNT}`, "deposit"]);
    expect(prompts).toEqual(["approve 1/3", "approve 2/3", "deposit 3/3"]);
    expect(approved, "one approval of the amount").toBe(1);
    expect(w.sent.some((s) => s.reverted)).toBe(false);
    expect(w.allowance).toBe(0n);
  });

  it("a protect sends on the deployment's chain only: a wallet on another network is refused before anything is sent, and so is one switched there between the approval and the deposit", async () => {
    w.chain = "0x89"; // Polygon
    const away = await protect(0n).catch((e: unknown) => e);
    expect(away).toMatchObject({
      code: "chain_mismatch",
      name: "WalletOnOtherChain",
      message: expect.stringMatching(/on chain 137, not this deployment's chain 1; nothing was sent/),
    });
    expect(w.sent, "nothing sent").toEqual([]);
    w.chain = "0x1";
    w.switchTo = { after: 1, chain: "0x89" };
    const switched = await protect(0n).catch((e: unknown) => e);
    // the approval's receipt is not on that network: nothing more is sent, and no endpoint is asked (the eleventh review round, F11-10)
    expect(switched).toMatchObject({ code: "approval_unconfirmed" });
    expect(
      w.sent.map((x) => x.fn),
      "the approval went out on chain 1; the deposit never left",
    ).toEqual(["approve"]);
    w.sent.length = 0;
    w.chainIds.length = 0;
    w.switchTo = null;
    w.chain = "0x1";
    await protect(AMOUNT); // what that approval left: used as it is
    expect(w.chainIds, "every transaction names its chain").toEqual(["0x1"]);
  });

  it("a wallet switched to another network after its approval was confirmed: the deposit is refused before it is sent (chain_mismatch), nothing deposited", async () => {
    // the approval's own wait now notices another network first (approval_unconfirmed, above); the deposit's network check is kept for the
    // window after the approval's receipt was read (the eleventh review round's critique of F11-10)
    w.switchOnReceipt = "0x89";
    const err = await protect(0n).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "chain_mismatch", name: "WalletOnOtherChain" });
    expect(
      w.sent.map((s) => s.fn),
      "the approval only",
    ).toEqual(["approve"]);
  });

  it("the session locks between two prompts (V7 Stage 16, spec v3.0 §9): nothing more is asked of the wallet; what was sent stays sent", async () => {
    w.lockAfter = 1; // the clearing approval goes out, then the page locks (a phone's handoff, or Lock)
    const stopped = await protect(1n).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ code: "locked_mid_flow", message: expect.stringMatching(/locked before the next prompt/) });
    expect(
      w.sent.map((s) => s.fn),
      "the approval of the amount and the deposit were never asked for",
    ).toEqual(["approve"]);
    expect(await session.unlock("a strong password")).toBe(true);
  });
});
