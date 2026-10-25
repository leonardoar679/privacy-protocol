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

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const FACTORY = "0x00000000000000000000000000000000000000f1";
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469" as const;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const USDT_VAULT = "0x00000000000000000000000000000000000000C3" as const;
const ROUTER = "0x00000000000000000000000000000000000000a1" as const;
const OWNER = "0x00000000000000000000000000000000000000b0";
const ZERO = "0x0000000000000000000000000000000000000000";
const ID = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
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
        { PROTOCOL_ID: ID(1), CIRCUIT_ID: ID(2), HASH_ID: ID(3), VERIFIER: "0x00000000000000000000000000000000000000Ab", VAULT_FACTORY: FACTORY } as Record<
          string,
          unknown
        >
      )[functionName];
    if (address === FACTORY && functionName === "vaultOf")
      return ({ [ZERO]: ETH_VAULT, [USDT.toLowerCase()]: USDT_VAULT } as Record<string, string>)[String(args![0]).toLowerCase()] ?? ZERO;
    if (functionName === "VAULT_VERSION") return 1n;
    if (address === ROUTER && functionName === "CORE") return CORE;
    if (address === USDT && functionName === "decimals") return 6; // the token's own, as configured (critic gap 1)
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

/** The connected wallet over a token that keeps USDT's rule: approve(non-zero) reverts while a non-zero allowance is open. */
const usdtWallet = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
    if (method === "eth_chainId") return w.chain;
    if (method === "eth_call") return encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: w.allowance });
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
  w.sent.length = 0;
  w.receipts.clear();
  w.chain = "0x1";
  w.switchTo = null;
  w.chainIds.length = 0;
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
    expect(amounts(null), "unreadable: as before").toEqual([AMOUNT]);
    expect(amounts(AMOUNT), "what a refused deposit left").toEqual([]);
    expect(amounts(1_000_000n)).toEqual([0n, AMOUNT]);
    expect(amounts(2n ** 256n - 1n), "even an unlimited one: narrowed to the amount").toEqual([0n, AMOUNT]);
    expect(approvalsFor(0n, USDT, ROUTER, AMOUNT)[0]).toMatchObject({ to: USDT });
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
    expect(switched).toMatchObject({ code: "chain_mismatch" });
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
});
