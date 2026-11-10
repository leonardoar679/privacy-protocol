// A Protect's transactions are never asked about at the privacy endpoints (the eleventh review round, F11-10): their `from` is the user's
// public address, and the endpoints that serve every later private spend would hold this IP beside it (threat model A2; gaps 80, 100). The
// scan's stale mover settles a Protect from its note, or from the wallet that sent it — never by the deposit's hash at every endpoint, as
// it had even with the note already found. The live flow takes its receipts from the connected wallet only: a wallet that gives none
// (another network, WalletConnect's reads that the policy blocks, ten minutes) leaves the deposit to the scan — deposit_unconfirmed — and
// stops before the deposit when the approval is not known (approval_unconfirmed); WalletConnect's provider, which answers no read, has its
// approval's receipt read from the first endpoint, the one stated exception (audit gap 100). The critique of the fix: a wallet whose node
// answered and then failed is read on to the time, never taken as one that cannot read; only the wallet holding the sending account is asked
// after the page is gone; a deposit with no word at all reads as such past the drop limit, and as never landed a day on; a second Protect is
// held back while the first may still land.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { walletReceipt, walletReceiptTiming, walletTxStatus, WALLET_READ_TRIES, type Deployment } from "../src/chain";
import { approvalReceiptTiming, prepareShield, submitShield } from "../src/privateTx";
import { classify } from "../src/operations/errors/catalog";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore } from "../src/wallet/notes";
import { applyEvent, getOperation, MAY_STILL_LAND_MS, newOperation, resetOperationsMemory, unresolvedOf } from "../src/operations/store";
import { kindFor } from "../src/operations/notify";
import { reconcileStaleOperations, staleReads, RELAYER_GONE_MS, STALE_DROP_WALLET_MS } from "../src/operations/stale";
import { CATALOG } from "../src/operations/errors/codes";

const w = vi.hoisted(() => ({
  provider: null as null | { isWalletConnect?: boolean; request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
}));
vi.mock("@privacy-wallet/wallet-engine/injected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/injected")>()),
  activeProvider: () => w.provider,
  connectedProvider: () => w.provider,
}));
// the deployment check reads the core's views through the endpoints: not what this file is about
vi.mock("../src/deploymentGuard", () => ({ guardDeployment: async () => undefined }));

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9" as const;
const ETH_VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_VAULT = "0x00000000000000000000000000000000000000C3" as const;
const ROUTER = "0x00000000000000000000000000000000000000a1" as const;
const A = "https://rpc-a.example/";
const B = "https://rpc-b.example/";
const d: Deployment = {
  chainId: 1,
  core: CORE,
  ethVault: ETH_VAULT,
  rpcUrl: A,
  rpcUrls: [A, B],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  protectRouter: ROUTER,
};
const ACCOUNT = "0x00000000000000000000000000000000000000b0";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000c7";
const PASSWORD = "a strong password";
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const rawReceipt = (hash: Hex, status: "0x1" | "0x0" = "0x1") => ({
  blockHash: `0x${"aa".repeat(32)}`,
  blockNumber: "0x10",
  contractAddress: null,
  cumulativeGasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  from: ACCOUNT,
  gasUsed: "0x5208",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status,
  to: ROUTER,
  transactionHash: hash,
  transactionIndex: "0x0",
  type: "0x2",
});

/** Every request an endpoint received, and what it answers: a receipt for any hash (a node that knows the transaction). */
const fetched: { url: string; method: string; params: unknown }[] = [];
const realFetch = globalThis.fetch;
/**
 * `receipts` false: the endpoint knows no receipt (the gap-100 read waits for one); "fail": its receipt reads fail at the transport;
 * `onReceipt`: called as a receipt is asked of it
 */
const endpoint: { receipts: boolean | "fail"; onReceipt?: () => void } = { receipts: true };
const endpointAnswer = (m: { id: number; method: string; params?: unknown[] }) => ({
  jsonrpc: "2.0",
  id: m.id,
  result:
    m.method === "eth_getTransactionReceipt"
      ? endpoint.receipts === true
        ? rawReceipt(m.params![0] as Hex)
        : null
      : m.method === "eth_chainId"
        ? "0x1"
        : m.method === "eth_blockNumber"
          ? "0x20"
          : null,
});
const askedAbout = (hash: Hex) =>
  fetched.filter((f) =>
    JSON.stringify(f.params ?? [])
      .toLowerCase()
      .includes(hash.slice(2).toLowerCase()),
  );
const timing = { ...walletReceiptTiming };

beforeAll(async () => {
  configure(defaultConfig({ storage: () => memoryStorage(), kdfLog2N: 12 }));
  await session.create(PASSWORD);
  session.acknowledgePhrase();
  // the flows' wallet reads, shortened: ten minutes become 300 ms, 1.5 s between reads 5 ms
  walletReceiptTiming.timeoutMs = 300;
  walletReceiptTiming.intervalMs = 5;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? "null"));
    const msgs = Array.isArray(body) ? body : [body];
    for (const m of msgs) fetched.push({ url, method: m.method, params: m.params });
    if (msgs.some((m) => m.method === "eth_getTransactionReceipt")) {
      endpoint.onReceipt?.();
      if (endpoint.receipts === "fail") throw new TypeError("Failed to fetch");
    }
    const out = Array.isArray(body) ? msgs.map(endpointAnswer) : endpointAnswer(msgs[0]);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  Object.assign(walletReceiptTiming, timing);
  w.provider = null;
});
beforeEach(() => {
  fetched.length = 0;
  w.provider = null;
  endpoint.receipts = true;
  endpoint.onReceipt = undefined;
});

type Answer = "read" | "reverted" | "pending" | "unknown" | "fail";
/**
 * A connected wallet: one account on `chain`, a hash per send, and its own node's answers — `receipts` "read" (the receipt), "pending"
 * (null, the transaction known), "unknown" (null, not known), or "fail" (the read throws, as WalletConnect's under the policy);
 * `walletConnect`: WalletConnect's provider (its `isWalletConnect`).
 */
function wallet(o: { chain?: () => string; receipts?: (hash: Hex) => Answer; walletConnect?: boolean; account?: string } = {}) {
  const sent: { to: string; hash: Hex }[] = [];
  const asked: string[] = [];
  w.provider = {
    ...(o.walletConnect ? { isWalletConnect: true } : {}),
    request: async ({ method, params }) => {
      asked.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [o.account ?? ACCOUNT];
      if (method === "eth_chainId") return o.chain ? o.chain() : "0x1";
      if (method === "eth_call") throw new Error("eth_call: the host is blocked"); // the allowance unread (C-L7)
      if (method === "eth_sendTransaction") {
        const hash = hashOf(0xd00 + sent.length + 1);
        sent.push({ to: String((params![0] as { to: string }).to).toLowerCase(), hash });
        return hash;
      }
      const hash = params?.[0] as Hex;
      const answer = o.receipts ? o.receipts(hash) : "read";
      if (method === "eth_getTransactionReceipt") {
        if (answer === "fail") throw new Error("Failed to fetch");
        return answer === "read" ? rawReceipt(hash) : answer === "reverted" ? rawReceipt(hash, "0x0") : null;
      }
      if (method === "eth_getTransactionByHash") {
        if (answer === "fail") throw new Error("Failed to fetch");
        return answer === "pending" ? { hash } : null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { sent, asked };
}

describe("walletReceipt: the connected wallet's receipt, or why there is none (F11-10)", () => {
  const H = hashOf(0xabc);
  it("each reason apart: no provider, another network, a provider that never answers, the time, the flow over", async () => {
    expect(await walletReceipt(H, { timeoutMs: 50, intervalMs: 1 })).toEqual({ none: "no-provider" });
    wallet({ chain: () => "0x2105" });
    expect(await walletReceipt(H, { timeoutMs: 1000, intervalMs: 1, chainId: 1 })).toEqual({ none: "other-chain" });
    const failing = wallet({ receipts: () => "fail" });
    expect(await walletReceipt(H, { timeoutMs: 10_000, intervalMs: 1, chainId: 1 })).toEqual({ none: "unreadable" });
    expect(
      failing.asked.filter((m) => m === "eth_getTransactionReceipt"),
      "tried, then taken as one that cannot read",
    ).toHaveLength(WALLET_READ_TRIES);
    wallet({ receipts: () => "pending" });
    expect(await walletReceipt(H, { timeoutMs: 20, intervalMs: 1, chainId: 1 })).toEqual({ none: "timeout" });
    let polls = 0;
    wallet({
      receipts: () => {
        polls++;
        return "pending";
      },
    });
    expect(await walletReceipt(H, { timeoutMs: 10_000, intervalMs: 1, stop: () => polls >= 2 })).toEqual({ none: "stopped" });
  });
  it("a provider that answered is read on through its failures — never taken as one that cannot read (the critique of F11-10)", async () => {
    // fail, pending, fail, fail, mined: the receipt
    const script: Answer[] = ["fail", "pending", "fail", "fail", "read"];
    let n = 0;
    wallet({ receipts: () => script[Math.min(n++, script.length - 1)] });
    const r = await walletReceipt(H, { timeoutMs: 10_000, intervalMs: 1, chainId: 1 });
    expect("receipt" in r && r.receipt.status).toBe("success");
    // pending twice, then its node down for good: read on to the time, never "unreadable"
    let m = 0;
    wallet({ receipts: () => (++m <= 2 ? "pending" : "fail") });
    expect(await walletReceipt(H, { timeoutMs: 100, intervalMs: 1, chainId: 1 })).toEqual({ none: "timeout" });
    expect(m, "read on through the failures").toBeGreaterThan(WALLET_READ_TRIES + 2);
  });
  it("walletTxStatus: mined, reverted, pending, unknown — through the wallet holding the sending account alone; never an endpoint", async () => {
    for (const [answer, status] of [
      ["read", "success"],
      ["reverted", "reverted"],
      ["pending", "pending"],
      ["unknown", "unknown"],
      ["fail", null],
    ] as const) {
      wallet({ receipts: () => answer });
      expect(await walletTxStatus(H, 1, ACCOUNT), answer).toBe(status);
    }
    wallet({ chain: () => "0x89" });
    expect(await walletTxStatus(H, 1, ACCOUNT), "another network").toBeNull();
    // another wallet connected (another account), or no account kept: never asked about the hash (the critique of F11-10)
    const other = wallet({ account: OTHER_ACCOUNT });
    expect(await walletTxStatus(H, 1, ACCOUNT), "another wallet's node").toBeNull();
    expect(other.asked, "asked its accounts alone").toEqual(["eth_accounts"]);
    const unkept = wallet();
    expect(await walletTxStatus(H, 1, undefined), "no sending account kept").toBeNull();
    expect(unkept.asked).toEqual([]);
    w.provider = null;
    expect(await walletTxStatus(H, 1, ACCOUNT), "no wallet connected").toBeNull();
    expect(fetched, "no endpoint asked").toEqual([]);
  });
});

/** An open Protect whose page went away: sent from ACCOUNT as `hash` with the note at counter `counter`, last moved at `at`. */
function sentProtect(hash: Hex, counter: number, at: number) {
  const r = newOperation(
    {
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: "100000000000000000" },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never,
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  applyEvent(r.id, { type: "progress", step: "submitting", noteCounter: counter, sender: ACCOUNT } as never, session, at);
  applyEvent(r.id, { type: "submitted", by: "wallet", txHash: hash } as never, session, at);
  resetOperationsMemory(); // the page that drove it is gone (a reload, a phone's wallet handoff)
  return r.id;
}
const foundNote = (counter: number, leafIndex: number, hash: Hex) =>
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: 1n, ownerCommitment: BigInt(counter), noteSecret: 2n },
    leafIndex,
    noteData: "0x",
    counter,
    spent: false,
    txHash: hash,
    label: "discovered",
    addedAt: Date.now(),
  } as never);

describe("the stale mover settles a Protect without the endpoints (F11-10)", () => {
  it("the scan found its note: completed at the note's leaf — no endpoint and not even the wallet asked about its hash", async () => {
    const H = hashOf(0xe01);
    const wal = wallet();
    const id = sentProtect(H, 101, Date.now() - 60_000);
    foundNote(101, 7, H);
    expect(await reconcileStaleOperations(staleReads(d, null), Date.now(), session)).toBe(1);
    expect(getOperation(id, session)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 7 } });
    expect(askedAbout(H), "no endpoint asked about the deposit").toEqual([]);
    expect(wal.asked, "the note settles it").toEqual([]);
  });
  it("no note yet: the wallet that sent it says mined, reverted, dropped or pending; the endpoints never hear of the hash", async () => {
    const old = Date.now() - STALE_DROP_WALLET_MS - 60_000;
    const cases = [
      ["read", "COMPLETED", undefined],
      ["reverted", "FAILED", "receipt_reverted"],
      ["unknown", "FAILED", "deposit_dropped"], // the Protect's own words since the twelfth review round (A12-1), never a Send's "Send it again"
      ["pending", "SOURCE_CONFIRMING", undefined], // held pending by its wallet: waited for
    ] as const;
    for (const [k, [answer, state, code]] of cases.entries()) {
      const H = hashOf(0xe10 + k);
      wallet({ receipts: () => answer });
      const id = sentProtect(H, 110 + k, old);
      await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
      const r = getOperation(id, session);
      expect(r?.state, answer).toBe(state);
      if (code) expect(r?.reason?.code, answer).toBe(code);
      expect(askedAbout(H), answer).toEqual([]);
    }
  });
  it("a recent one its wallet's node does not know yet is waited for, never 'nothing moved' within the drop limit (the critique of F11-10)", async () => {
    const H = hashOf(0xe18);
    wallet({ receipts: () => "unknown" });
    const id = sentProtect(H, 118, Date.now() - 2 * 60_000);
    await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
    expect(getOperation(id, session)?.state).toBe("SOURCE_CONFIRMING");
  });
  it("no word at all: waited for; past the drop limit a deposit not reported (its own words), a day on never landed — nothing moved", async () => {
    const H = hashOf(0xe20);
    wallet({ chain: () => "0x89" }); // the wallet is on another network now
    const id = sentProtect(H, 120, Date.now() - 5 * 60_000);
    await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
    expect(getOperation(id, session)?.state, "within the limit: as it was").toBe("SOURCE_CONFIRMING");
    await reconcileStaleOperations(staleReads(d, null), Date.now() + STALE_DROP_WALLET_MS, session);
    // never a Send's "your notes were spent": a deposit its wallet did not report (the critique of F11-10)
    expect(getOperation(id, session)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    wallet({ receipts: () => "pending" });
    await reconcileStaleOperations(staleReads(d, null), Date.now() + STALE_DROP_WALLET_MS, session);
    expect(getOperation(id, session)?.state, "a pending transaction waits").toBe("RECOVERY_REQUIRED");
    foundNote(120, 9, H);
    await reconcileStaleOperations(staleReads(d, null), Date.now() + STALE_DROP_WALLET_MS, session);
    expect(getOperation(id, session)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 9 } });
    // another that never lands: a day after it last moved, nothing moved
    const H2 = hashOf(0xe21);
    w.provider = null; // after a reload WalletConnect is not taken up (audit gap 112)
    const never = sentProtect(H2, 121, Date.now() - STALE_DROP_WALLET_MS - 60_000);
    await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
    expect(getOperation(never, session)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    await reconcileStaleOperations(staleReads(d, null), Date.now() + RELAYER_GONE_MS + 60_000, session);
    expect(getOperation(never, session)).toMatchObject({ state: "FAILED", reason: { code: "deposit_never_landed", fundsClass: "not-moved" } });
    expect(CATALOG.deposit_never_landed).toMatchObject({ fundsClass: "not-moved", actions: ["review"] });
    expect([...askedAbout(H), ...askedAbout(H2)]).toEqual([]);
  });
});

describe("the live Protect takes its receipts from the connected wallet only (F11-10)", () => {
  async function protect(o: { token?: boolean } = {}) {
    const p = o.token
      ? prepareShield({ masterSeed: session.state().seed!, deployment: d, amount: 5_000_000n, token: USDC, vault: USDC_VAULT })
      : prepareShield({ masterSeed: session.state().seed!, deployment: d, amount: 10n ** 17n });
    return submitShield(p, { account: ACCOUNT }).then(
      () => null,
      (e: { code?: string }) => e,
    );
  }
  /** the provider wallet() made, with `onSend` run at each send */
  function onSend(f: () => void) {
    const send = w.provider!.request;
    w.provider = {
      ...w.provider!,
      request: async (a) => {
        if (a.method === "eth_sendTransaction") f();
        return send(a);
      },
    };
  }
  it("WalletConnect's reads, which the policy blocks: the deposit is left to the scan — deposit_unconfirmed, no endpoint asked anything", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    const err = await protect();
    expect(err?.code).toBe("deposit_unconfirmed");
    expect(CATALOG.deposit_unconfirmed).toMatchObject({ fundsClass: "unknown", actions: ["continue-monitoring"] });
    expect(wal.sent).toHaveLength(1);
    expect(fetched, "no endpoint asked").toEqual([]);
  });
  it("the wallet moved to another network while the deposit was awaited: deposit_unconfirmed, no endpoint asked", async () => {
    let sends = 0;
    const wal = wallet({ chain: () => (sends > 0 ? "0x89" : "0x1") });
    onSend(() => sends++);
    const err = await protect();
    expect(err?.code).toBe("deposit_unconfirmed");
    expect(wal.sent).toHaveLength(1);
    expect(fetched).toEqual([]);
  });
  it("an ERC-20 through WalletConnect: its approvals' receipts from the first endpoint alone — the stated exception — and the deposit's hash never", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    const err = await protect({ token: true });
    expect(err?.code).toBe("deposit_unconfirmed");
    expect(wal.sent.map((s) => s.to)).toEqual([USDC.toLowerCase(), USDC.toLowerCase(), ROUTER.toLowerCase()]); // approve(0), approve(amount), the deposit
    const [clear, approve, deposit] = wal.sent.map((s) => s.hash);
    for (const h of [clear, approve]) expect(new Set(askedAbout(h).map((f) => f.url)), "the approval: the first endpoint only").toEqual(new Set([A]));
    expect(askedAbout(deposit), "the deposit: no endpoint").toEqual([]);
  });
  it("any other wallet that cannot read stops at its approval: the exception is WalletConnect's alone (the critique of F11-10)", async () => {
    const wal = wallet({ receipts: () => "fail" });
    const err = await protect({ token: true });
    expect(err?.code).toBe("approval_unconfirmed");
    expect(
      wal.sent.map((s) => s.to),
      "the clearing approval only",
    ).toEqual([USDC.toLowerCase()]);
    expect(fetched, "no endpoint asked").toEqual([]);
  });
  it("a wallet whose node answered and then failed is read on to the time: approval_unconfirmed, its approval never asked of an endpoint", async () => {
    let reads = 0;
    const wal = wallet({ receipts: () => (++reads <= 2 ? "pending" : "fail") });
    const err = await protect({ token: true });
    expect(err?.code).toBe("approval_unconfirmed");
    expect(wal.sent).toHaveLength(1);
    expect(fetched, "no endpoint asked").toEqual([]);
  });
  it("an approval the wallet reports nothing for — on another network, or the wallet gone after its send: approval_unconfirmed, nothing deposited, no endpoint asked", async () => {
    let sends = 0;
    const moved = wallet({ chain: () => (sends > 0 ? "0x89" : "0x1") });
    onSend(() => sends++);
    expect((await protect({ token: true }))?.code).toBe("approval_unconfirmed");
    expect(CATALOG.approval_unconfirmed).toMatchObject({ fundsClass: "not-moved" });
    expect(
      moved.sent.map((s) => s.to),
      "the clearing approval only: no deposit",
    ).toEqual([USDC.toLowerCase()]);
    const gone = wallet();
    onSend(() => {
      queueMicrotask(() => (w.provider = null)); // disconnected right after its send
    });
    expect((await protect({ token: true }))?.code).toBe("approval_unconfirmed");
    expect(gone.sent).toHaveLength(1);
    expect(fetched).toEqual([]);
  });
  it("a second Protect is held back while one its wallet reported nothing for may still land — for as long as it reads so, a day at most (the critique of F11-10)", async () => {
    const H = hashOf(0xe30);
    const T0 = Date.now();
    const r = newOperation(
      {
        kind: "protect",
        amounts: { asset: "ETH", decimals: 18, input: "1" },
        destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
        tier: "standard",
      } as never,
      T0,
    );
    applyEvent(r.id, { type: "review" }, session, T0);
    applyEvent(r.id, { type: "confirm" }, session, T0);
    applyEvent(r.id, { type: "progress", step: "submitting", noteCounter: 130, sender: ACCOUNT } as never, session, T0);
    applyEvent(r.id, { type: "submitted", by: "wallet", txHash: H } as never, session, T0);
    applyEvent(r.id, { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt" }, session, T0);
    // the rule over this record alone (an earlier test's Protect may be held as well)
    expect(unresolvedOf([getOperation(r.id, session)!], "protect")?.id, "held: it may still land").toBe(r.id);
    // an hour on, still reading "do not protect it again": still held (the second critique: an hour had let a second deposit through)
    const hourOn = vi.spyOn(Date, "now").mockReturnValue(T0 + 60 * 60_000 + 1);
    try {
      expect(unresolvedOf([getOperation(r.id, session)!], "protect")?.id, "an hour on: still held").toBe(r.id);
    } finally {
      hourOn.mockRestore();
    }
    const dayOn = vi.spyOn(Date, "now").mockReturnValue(T0 + MAY_STILL_LAND_MS + 1);
    try {
      expect(unresolvedOf([getOperation(r.id, session)!], "protect"), "a day on: no longer held").toBeNull();
    } finally {
      dayOn.mockRestore();
    }
    foundNote(130, 11, H); // and once the scan records it, the stale pass completes it
    await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
    expect(getOperation(r.id, session)?.state).toBe("COMPLETED");
  });
});

describe("the twelfth review round (A12-2, B12-5; W6 §2): WalletConnect's request expiry, and the approval's endpoint read bounded", () => {
  async function protect(o: { token?: boolean } = {}) {
    const p = o.token
      ? prepareShield({ masterSeed: session.state().seed!, deployment: d, amount: 5_000_000n, token: USDC, vault: USDC_VAULT })
      : prepareShield({ masterSeed: session.state().seed!, deployment: d, amount: 10n ** 17n });
    return submitShield(p, { account: ACCOUNT }).then(
      () => null,
      (e: unknown) => e,
    );
  }
  /** WalletConnect's own utilities, the installed copy (resolved from @walletconnect/core's directory) */
  function walletConnectUtils() {
    const req = createRequire(import.meta.url);
    return req(req.resolve("@walletconnect/utils", { paths: [dirname(req.resolve("@walletconnect/core"))] })) as {
      createDelayedPromise: (ttl: number, message: string) => { done: () => Promise<unknown> };
      getSdkError: (key: string) => { message: string; code: number };
    };
  }
  /** the sign client's rejection of a request it had published, at its session's delete (cleanupPendingSentRequestsForTopic): 6000 */
  const sessionEnded = () => walletConnectUtils().getSdkError("USER_DISCONNECTED");
  /** the sign client's own request expiry, as its fifteen minutes end (@walletconnect/utils createDelayedPromise, the installed copy) */
  async function expiry(): Promise<unknown> {
    return walletConnectUtils()
      .createDelayedPromise(1, "Request expired. Please try again.")
      .done()
      .then(
        () => null,
        (e: unknown) => e,
      );
  }
  /** the provider wallet() made, its `n`th send answered with `err`: the prompts it was asked, counted */
  function sendFails(n: number, err: unknown): () => number {
    let sends = 0;
    const send = w.provider!.request;
    w.provider = {
      ...w.provider!,
      request: async (a) => {
        if (a.method === "eth_sendTransaction" && ++sends === n) throw err;
        return send(a);
      },
    };
    return () => sends;
  }

  it("an ERC-20 Protect's approval prompt its wallet app did not answer in time: approval_unanswered — nothing deposited, the deposit never prompted", async () => {
    const wal = wallet({ walletConnect: true });
    const prompts = sendFails(1, await expiry());
    const err = (await protect({ token: true })) as { code?: string } | null;
    expect(err?.code).toBe("approval_unanswered");
    expect(classify(err)).toMatchObject({ code: "approval_unanswered", fundsClass: "not-moved", actions: ["review"] });
    expect(prompts(), "the first approval's prompt alone").toBe(1);
    expect(wal.sent, "nothing sent").toEqual([]);
  });

  it("an approval prompt open when its session ended (6000): approval_unanswered — nothing deposited, the deposit never prompted", async () => {
    const wal = wallet({ walletConnect: true });
    const prompts = sendFails(2, sessionEnded()); // the clearing approval sent, the approval for the amount open
    const err = (await protect({ token: true })) as { code?: string } | null;
    expect(err?.code).toBe("approval_unanswered");
    expect(prompts(), "the two approvals' prompts alone").toBe(2);
    expect(
      wal.sent.map((x) => x.to),
      "the clearing approval alone",
    ).toEqual([USDC.toLowerCase()]);
  });

  it("an approval prompt refused with WalletConnect's own refusal (getSdkError, a plain {message, code: 5000}) comes through as the user's refusal", async () => {
    wallet({ walletConnect: true });
    const refusal = walletConnectUtils().getSdkError("USER_REJECTED");
    sendFails(1, refusal);
    const err = await protect({ token: true });
    expect(err, "unchanged: never the approval's own stop").toBe(refusal);
    expect(classify(err)).toMatchObject({ code: "user_rejected", fundsClass: "not-moved" });
  });

  it("an approval prompt the user refused stays their refusal — only the expiry is the approval's own stop", async () => {
    wallet({ walletConnect: true });
    sendFails(1, Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const err = await protect({ token: true });
    expect(classify(err)).toMatchObject({ code: "user_rejected" });
  });

  it("the deposit's prompt its wallet app did not answer in time: the library's expiry, read wallet_request_expired — its funds unknown, never a quote's", async () => {
    wallet({ walletConnect: true });
    sendFails(1, await expiry());
    const err = await protect();
    expect(classify(err)).toMatchObject({ code: "wallet_request_expired", fundsClass: "unknown", actions: ["continue-monitoring"] });
  });

  it("the deposit's prompt open when its session ended (the sign client's own 6000): wallet_session_ended — its funds unknown, never 'nothing was sent'", async () => {
    wallet({ walletConnect: true });
    sendFails(1, sessionEnded());
    const err = await protect();
    expect(classify(err)).toMatchObject({ code: "wallet_session_ended", fundsClass: "unknown", actions: ["continue-monitoring"] });
  });

  it("a self-submitted Send whose request its session's end rejected (6000): RECOVERY_REQUIRED, the next Send held while its pair is unspent", () => {
    const at = Date.now();
    const r = newOperation(
      {
        kind: "send",
        amounts: { asset: "ETH", decimals: 18, input: "1000" },
        destination: { kind: "privacy-address", display: "pp1…", chain: "ethereum" },
        tier: "standard",
      } as never,
      at,
    );
    applyEvent(r.id, { type: "review" }, session, at);
    applyEvent(r.id, { type: "confirm" }, session, at);
    applyEvent(r.id, { type: "progress", step: "proof" }, session, at);
    applyEvent(r.id, { type: "progress", step: "submitting", nullifiers: ["6001", "6002"] } as never, session, at);
    const c = classify(sessionEnded());
    // the screens' rule (SendScreen, ProtectScreen): a row whose funds are unknown is a recovery, any other a failure
    applyEvent(
      r.id,
      c.fundsClass === "unknown"
        ? { type: "recovery-required", code: c.code, detail: c.detail }
        : { type: "submission-failed", code: c.code, detail: c.detail },
      session,
      at,
    );
    expect(getOperation(r.id, session)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "wallet_session_ended", fundsClass: "unknown" } });
    expect(unresolvedOf([getOperation(r.id, session)!], "send")?.id, "held: the wallet app may have sent it").toBe(r.id);
  });

  it("the approval's receipt the first endpoint does not give within its bound: approval_unconfirmed — never unknown after three minutes, the deposit never prompted", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    endpoint.receipts = false;
    const bound = { ...approvalReceiptTiming };
    Object.assign(approvalReceiptTiming, { timeoutMs: 300, intervalMs: 100 });
    try {
      const err = (await protect({ token: true })) as { code?: string } | null;
      expect(err?.code).toBe("approval_unconfirmed");
      // read at its interval, never back to back: the endpoint holds this IP beside the approval (gap 100)
      const reads = fetched.filter((f) => f.method === "eth_getTransactionReceipt").length;
      expect(reads, "one read, then one each interval up to the bound").toBeGreaterThanOrEqual(2);
      expect(reads, "one read, then one each interval up to the bound").toBeLessThanOrEqual(300 / 100 + 2);
      expect(
        wal.sent.map((x) => x.to),
        "the first approval alone",
      ).toEqual([USDC.toLowerCase()]);
    } finally {
      Object.assign(approvalReceiptTiming, bound);
    }
  });

  it("the approval's receipt the first endpoint gives after a few reads: read on to it, the Protect goes on to its deposit", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    endpoint.receipts = false;
    let reads = 0;
    endpoint.onReceipt = () => {
      if (++reads === 3) endpoint.receipts = true; // mined at the third read
    };
    const bound = { ...approvalReceiptTiming };
    Object.assign(approvalReceiptTiming, { timeoutMs: 5000, intervalMs: 20 });
    try {
      const err = (await protect({ token: true })) as { code?: string } | null;
      expect(err?.code, "the deposit sent, its wallet reporting nothing (WalletConnect's reads)").toBe("deposit_unconfirmed");
      expect(
        wal.sent.map((x) => x.to),
        "both approvals, then the deposit",
      ).toEqual([USDC.toLowerCase(), USDC.toLowerCase(), ROUTER.toLowerCase()]);
    } finally {
      Object.assign(approvalReceiptTiming, bound);
    }
  });

  it("the approval's receipt read failing at the first endpoint's transport: approval_unconfirmed — never relayer_unreachable, the deposit never prompted", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    endpoint.receipts = "fail";
    const err = (await protect({ token: true })) as { code?: string } | null;
    expect(err?.code).toBe("approval_unconfirmed");
    expect(classify(err)).toMatchObject({ code: "approval_unconfirmed", fundsClass: "not-moved" });
    expect(
      fetched.some((f) => f.method === "eth_getTransactionReceipt"),
      "the endpoint was asked",
    ).toBe(true);
    expect(
      wal.sent.map((x) => x.to),
      "the first approval alone",
    ).toEqual([USDC.toLowerCase()]);
  });

  it("a lock while the first endpoint is read for the approval's receipt ends the read: locked_mid_flow, the endpoint never asked again (B-I3)", async () => {
    const wal = wallet({ receipts: () => "fail", walletConnect: true });
    endpoint.receipts = false;
    const bound = { ...approvalReceiptTiming };
    Object.assign(approvalReceiptTiming, { timeoutMs: 5000, intervalMs: 20 });
    let atLock = -1;
    endpoint.onReceipt = () => {
      if (atLock >= 0) return;
      atLock = fetched.length; // this read is in flight; none may follow it
      session.lock();
    };
    try {
      const err = (await protect({ token: true })) as { code?: string } | null;
      expect(err?.code).toBe("locked_mid_flow");
      expect(atLock, "the endpoint was asked").toBeGreaterThan(0);
      expect(
        fetched.slice(atLock).filter((f) => f.method === "eth_getTransactionReceipt"),
        "no receipt asked after the lock",
      ).toEqual([]);
      expect(
        wal.sent.map((x) => x.to),
        "the first approval alone",
      ).toEqual([USDC.toLowerCase()]);
    } finally {
      endpoint.onReceipt = undefined;
      Object.assign(approvalReceiptTiming, bound);
      // this file's storage is a fresh one at every access: a locked session never opens again — a new one, as beforeAll's, for the tests after
      await session.create(PASSWORD);
      session.acknowledgePhrase();
    }
  });
});

describe("a deposit its wallet did not report, said and settled as such (the second critique of F11-10)", () => {
  it("a first stale pass a day after the send reads never landed at once — the chain's verdict, never a Send's 'outcome unknown' for a second day", async () => {
    const H = hashOf(0xe40);
    w.provider = null; // after a reload WalletConnect is not taken up (audit gap 112)
    const id = sentProtect(H, 140, Date.now() - RELAYER_GONE_MS - 60_000);
    await reconcileStaleOperations(staleReads(d, null), Date.now(), session);
    expect(getOperation(id, session)).toMatchObject({ state: "FAILED", reason: { code: "deposit_never_landed", fundsClass: "not-moved" } });
  });
  it("no 'needs your attention' notification for a deposit its wallet did not report; one for any other recovery", () => {
    const at = Date.now();
    const r = newOperation(
      {
        kind: "protect",
        amounts: { asset: "ETH", decimals: 18, input: "1" },
        destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
        tier: "standard",
      } as never,
      at,
    );
    applyEvent(r.id, { type: "review" }, session, at);
    applyEvent(r.id, { type: "confirm" }, session, at);
    applyEvent(r.id, { type: "submitted", by: "wallet", txHash: hashOf(0xe41) } as never, session, at);
    const sent = getOperation(r.id, session)!;
    expect(sent.state).toBe("SOURCE_CONFIRMING");
    const recovery = (code: string) => ({ ...sent, state: "RECOVERY_REQUIRED" as const, reason: { code, fundsClass: "unknown" as const } });
    expect(kindFor(sent, recovery("deposit_unconfirmed") as never), "settled by the scan within minutes").toBeNull();
    expect(kindFor(sent, recovery("locked_after_send") as never)).toBe("recovery-required");
  });
});
