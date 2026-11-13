// The funding path shared by "Fund now" and the scheduler (V2 Stage 4): an abandoned order is never funded
// (the regression: its action used to stay pending and fire), a funded order's action is dropped, a
// journaled order's state is mirrored onto its Activity line, and the funding attempt itself refuses to
// start without a deployment or a factory before any note is touched. "Delay for more privacy" (spec v2.0 §14.1): an
// order to be funded from older notes hands their bound to the withdrawal.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { pendingActions, scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { abandonSwap, fundEscrow, FundingAlreadySent, fundingClock, fundingFate, fundingUnderWay, FundingUnderWay, isOpenSwap, OrderClosed, OrderOutdated, OrderWindowClosed, patchSwap, RelayerNotReady, runScheduledAction, TipStale, type FundingReads } from "@privacy-wallet/sdk/swapFunding";
import { returnFunds } from "@privacy-wallet/sdk/wallet/orderRunner";
import { mainOwnerCommitment } from "@privacy-wallet/sdk/keys/ownerKeys";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { fundingAttemptKey, type StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { predictEscrow } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";

// the private withdrawal has its own suites: here what the funding hands it is recorded
const withdrawals = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  events: [] as unknown[],
  afterEach: undefined as ((e: unknown) => void) | undefined,
  feeWei: undefined as bigint | undefined,
  /** a withdrawal under way waits here (the review round of 2026-11-03, E1): a second caller of the same order meanwhile */
  gate: null as Promise<void> | null,
  /** what happens in the journal between the call and the spend's own turn (E1: another tab's write, a reconcile) */
  before: undefined as (() => void) | undefined,
}));
// the relayer's /info: a relayer that names nothing (an older one), so the funding's own rules are what is tested here
vi.mock("@privacy-wallet/sdk/relayer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/relayer")>()),
  relayerInfo: async () => ({}),
}));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  privateWithdrawal: async (o: Record<string, unknown>) => {
    withdrawals.calls.push(o);
    if (withdrawals.gate) await withdrawals.gate;
    withdrawals.before?.();
    await (o.beforeSpend as (() => void | Promise<void>) | undefined)?.(); // the spend's turn runs the caller's re-check first (E1)
    const on = o.onEvent as ((e: unknown) => void) | undefined;
    for (const e of withdrawals.events) { on?.(e); withdrawals.afterEach?.(e); }
    return { txHash: "0x" + "33".repeat(32), ...(withdrawals.feeWei !== undefined ? { feeWei: withdrawals.feeWei } : {}) };
  },
}));

const KDF = { N: 1 << 12, r: 8, p: 1 };
const seed = new Uint8Array(32).fill(7);
// the refund note and the one-time signer this seed gives the test's orders at counter 0 and their attempt (the tenth review round, D-1: an
// order whose refund or signer is not the funding wallet's is never funded)
const REFUND0 = deriveRefundNote(seed, 0);
const SIGNER0 = deriveOrderKey(seed, ("0x" + "11".repeat(32)) as `0x${string}`).address;
const order = (id: string, state = "committed"): StoredSwap => ({
  orderId: id, attemptId: "0x" + "11".repeat(32), refundCounter: 0, provider: "thorchain", policy: "balanced", request: { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: "500000000000000000", destination: "bc1q", slippageBps: 50 },
  params: { amount: "500000000000000000" }, endpoint: "0x" + "ab".repeat(20), createdAt: 0, state,
});

describe("swap funding", () => {
  let s: WalletSession;
  beforeEach(async () => {
    noteStore.clear(); settings.reset();
    s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw");
  });

  it("an ETH order whose tip no longer pays its execution at today's gas price is stopped before funding; an ERC-20 order's is not re-valued (audit round 2, p04)", async () => {
    const GWEI = 10n ** 9n;
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const params = {
      orderId: ("0x" + "ad".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: (2_000_000n * GWEI).toString(),
    };
    const committed: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params) };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [committed]; });
    withdrawals.calls.length = 0;
    // a 2M-gas tip priced at 1 gwei; the base fee is 4 gwei now
    const risen = async () => ({ baseFeePerGas: 4n * GWEI, priorityFeePerGas: GWEI / 10n });
    const e = await fundEscrow({ masterSeed: seed, deployment, stored: committed, session: s, relayerUrl: "http://relayer.test", fees: risen }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TipStale);
    expect(withdrawals.calls, "nothing withdrawn").toHaveLength(0);
    // fees as at the commit: the tip pays — the funding goes on to its next checks
    const calm = async () => ({ baseFeePerGas: GWEI / 2n, priorityFeePerGas: GWEI / 10n });
    expect(await fundEscrow({ masterSeed: seed, deployment, stored: committed, session: s, relayerUrl: "http://relayer.test", fees: calm }).catch((x: unknown) => x)).not.toBeInstanceOf(TipStale);
    // an ERC-20 order's tip is never re-valued here
    const tokenParams = { ...params, orderId: ("0x" + "ae".repeat(32)) as `0x${string}`, assetType: 1 };
    const token: StoredSwap = { ...order(tokenParams.orderId), params: tokenParams, endpoint: predictEscrow(FACTORY, tokenParams) };
    s.update((j) => { j.swaps = [...j.swaps, token]; });
    expect(await fundEscrow({ masterSeed: seed, deployment, stored: token, session: s, relayerUrl: "http://relayer.test", fees: risen }).catch((x: unknown) => x)).not.toBeInstanceOf(TipStale);
    withdrawals.calls.length = 0; // the funded ones: nothing of them reaches the next case
  });

  it("a funding is read landed only from a spend of its own notes: a hash the relayer named that spends others is not it (audit round 2, n11)", async () => {
    const NOW = 1_900_000_000_000;
    const attempt = { nullifiers: ["7", "8"], by: "relayer" as const, relayerUrl: "http://relayer.test", at: NOW - 1000 };
    const reads = (spends: [bigint, bigint][] | null): FundingReads => ({
      spent: async () => false, // the nullifier read lags
      relayerJob: async () => ({ txHash: ("0x" + "ee".repeat(32)) as `0x${string}` }),
      receipt: async () => "success",
      txKnown: async () => true,
      txSpends: async () => spends,
    });
    expect(await fundingFate(attempt, reads([[7n, 8n]]), NOW)).toBe("landed");
    expect(await fundingFate(attempt, reads([[71n, 81n]]), NOW), "another spend, mined: this funding is still on its way").toBe("pending");
    expect(await fundingFate(attempt, reads(null), NOW), "not read: as before").toBe("landed");
  });

  it("abandoning an order removes its scheduled funding and marks its Activity line; the runner drops actions of closed or funded orders", async () => {
    s.update((j) => { j.swaps = [order("0xa"), order("0xb"), order("0xc")]; });
    for (const id of ["0xa", "0xb", "0xc"]) { recordActivity({ id: activityId("swap", id), kind: "swap", asset: "ETH", decimals: 18, amount: "1", status: "committed", ref: id }, s); scheduleAction({ kind: "fund-escrow", orderId: id, dueAt: 0 }, s); }
    abandonSwap("0xa", s);
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xb", "0xc"]);
    expect(s.journal().swaps.find((x) => x.orderId === "0xa")!.state).toBe("abandoned");
    expect(s.journal().activity!.find((r) => r.id === "swap:0xa")!.status).toBe("abandoned");
    expect(isOpenSwap({ state: "abandoned" })).toBe(false);
    // 0xb was funded by hand meanwhile: its action is dropped, not run
    patchSwap("0xb", { fundedTx: "0x" + "22".repeat(32), state: "funded" }, s);
    expect(s.journal().activity!.find((r) => r.id === "swap:0xb")!.status).toBe("funded");
    await runScheduledAction(pendingActions(s).find((a) => a.orderId === "0xb")!, { masterSeed: seed, deployment: null, session: s });
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xc"]);
    // 0xc is open and unfunded: the runner tries to fund it (and, with no deployment, says why it cannot)
    await expect(runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s })).rejects.toThrow(/No deployment configured/);
    expect(pendingActions(s).map((a) => a.orderId), "a failed attempt keeps the action for the backoff").toEqual(["0xc"]);
    // an order journaled funded without a transaction — reconciled from its escrow, or a funding that landed while its page
    // was gone (audit round 2, r10) — has its action dropped too: it had been funded again, or refused on the backoff for good
    patchSwap("0xc", { state: "funded" }, s);
    await runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s });
    expect(pendingActions(s), "dropped, never run").toEqual([]);
    // an action whose order is gone from the journal is dropped too
    scheduleAction({ kind: "fund-escrow", orderId: "0xzz", dueAt: 0 }, s);
    await runScheduledAction(pendingActions(s).find((a) => a.orderId === "0xzz")!, { masterSeed: seed, deployment: null, session: s });
    expect(pendingActions(s)).toEqual([]);
    // the review round of 2026-11-03 (E2): an order whose funding is on its way is never abandoned — abandoned, it is no longer open,
    // and a funding that lands then sits in the escrow with no way back in the app; a caller that read the attempt dead says so
    s.update((j) => { j.swaps = [{ ...order("0xf"), fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: 1 } }]; });
    expect(() => abandonSwap("0xf", s)).toThrow(FundingAlreadySent);
    expect(s.journal().swaps[0].state, "still open").toBe("committed");
    abandonSwap("0xf", s, { fundingDead: true });
    expect(s.journal().swaps[0].state).toBe("abandoned");
  });

  it("a scheduled funding whose escrow already holds the order journals it funded and sends nothing (audit round 2, n36)", async () => {
    s.update((j) => { j.swaps = [order("0xd")]; });
    scheduleAction({ kind: "fund-escrow", orderId: "0xd", dueAt: 0 }, s);
    withdrawals.calls.length = 0;
    // a funding that landed with nothing journaled: the escrow holds the order's amount
    await runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s, escrowBalance: async () => 500000000000000000n });
    expect(withdrawals.calls, "never sent a second time").toHaveLength(0);
    expect(s.journal().swaps[0].state).toBe("funded");
    expect(pendingActions(s), "its action done").toEqual([]);
    // an escrow short of it, or unread: the funding goes on (here, with no deployment, it says why it cannot)
    s.update((j) => { j.swaps = [order("0xe")]; });
    scheduleAction({ kind: "fund-escrow", orderId: "0xe", dueAt: 0 }, s);
    await expect(runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s, escrowBalance: async () => 1n })).rejects.toThrow(/No deployment configured/);
    await expect(runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s, escrowBalance: async () => null })).rejects.toThrow(/No deployment configured/);
  });

  it("fundEscrow refuses closed, funded and unconfigured orders before touching a note", async () => {
    await expect(fundEscrow({ masterSeed: seed, deployment: null, stored: order("0x1"), session: s })).rejects.toThrow(/No deployment configured/);
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] } as any;
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1", "abandoned"), session: s })).rejects.toThrow(/is abandoned/);
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: { ...order("0x1"), fundedTx: "0x11" }, session: s })).rejects.toThrow(/already funded/);
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1"), session: s })).rejects.toThrow(/Not enough ETH/);
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1"), session: s }), "no factory: the escrow cannot be recomputed, nothing is funded").rejects.toThrow(/VITE_SWAP_FACTORY/);
    expect(withdrawals.calls).toHaveLength(0);
  });

  it("'Delay for more privacy': the order's older-notes bound goes to the withdrawal; an order without it spends any notes", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const params = {
      orderId: ("0x" + "ab".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const endpoint = predictEscrow(FACTORY, params);
    const stored = (runner: StoredSwap["runner"]): StoredSwap => ({ ...order(params.orderId), params, endpoint, runner });
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [stored({ confirmedAt: 0, maxTiming: 0.3 })]; });
    withdrawals.calls.length = 0;
    await fundEscrow({ masterSeed: seed, deployment, stored: stored({ confirmedAt: 0, maxTiming: 0.3 }), session: s, relayerUrl: "http://relayer.test" });
    expect(withdrawals.calls[0]).toMatchObject({ amount: 5n * 10n ** 17n, recipient: endpoint, maxTiming: 0.3, record: false });
    expect(s.journal().swaps[0]).toMatchObject({ state: "funded", fundedTx: "0x" + "33".repeat(32) });
    // a second funding of the same order: the journal says funded, so the spend's turn would refuse a stale copy (the review round of
    // 2026-11-03, E1) — the order is journaled unfunded again for the second case
    s.update((j) => { j.swaps = [stored({ confirmedAt: 0 })]; });
    await fundEscrow({ masterSeed: seed, deployment, stored: stored({ confirmedAt: 0 }), session: s, relayerUrl: "http://relayer.test" });
    expect(withdrawals.calls[1]).toMatchObject({ amount: 5n * 10n ** 17n, recipient: endpoint });
    expect(withdrawals.calls[1]).not.toHaveProperty("maxTiming");
    // the fee note the funding paid is journaled with it (audit round 2, n25): a relayer asking less than the Review's bound
    withdrawals.feeWei = 5_500_000_000_000_000n;
    try {
      s.update((j) => { j.swaps = [stored({ confirmedAt: 0 })]; });
      await fundEscrow({ masterSeed: seed, deployment, stored: stored({ confirmedAt: 0 }), session: s, relayerUrl: "http://relayer.test" });
      expect(s.journal().swaps[0]).toMatchObject({ state: "funded", fundedFee: "5500000000000000" });
    } finally {
      withdrawals.feeWei = undefined;
    }
  });

  it("a swap into the protected balance is funded only once its relayer took the shield job (the audit round of 2026-10-16, c12)", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const params = {
      orderId: ("0x" + "5d".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const shield = {
      factory: "0x" + "5f".repeat(20), receiver: "0x" + "5e".repeat(20), counter: 3, noteData: "0x01" + "ab".repeat(168), vouch: "0x" + "77".repeat(65),
      params: { receiptId: "0x" + "6e".repeat(32), asset: "0x" + "c0".repeat(20), minAmount: "410000000", shieldTip: "4100000", ownerCommitment: "5", noteSecret: "6", noteDataHash: "0x" + "00".repeat(32), fallbackRecipient: "0x" + "fb".repeat(20) },
    };
    const stored: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params), shield };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [stored]; });
    const asked: { path: string; body?: unknown }[] = [];
    let shieldAnswer: [number, unknown] = [400, { error: "this relayer shields for 0x0…f2, not 0x5f…", code: "unknown_factory" }];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      asked.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const [status, body] = path === "/shield" ? shieldAnswer : [200, {}];
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      withdrawals.calls.length = 0;
      const refused = await fundEscrow({ masterSeed: seed, deployment, stored, session: s, relayerUrl: "http://relayer.test" }).catch((e: unknown) => e);
      expect(refused, "a relayer for another factory").toBeInstanceOf(RelayerNotReady);
      expect(withdrawals.calls, "nothing was funded").toHaveLength(0);
      expect(asked.find((a) => a.path === "/shield")?.body).toMatchObject({ factory: shield.factory, params: shield.params, noteData: shield.noteData, deliverBy: params.refundAfter, vouch: shield.vouch });
      await expect(fundEscrow({ masterSeed: seed, deployment, stored, session: s, relayerUrl: null }), "no relayer: nobody shields it").rejects.toBeInstanceOf(RelayerNotReady);
      shieldAnswer = [503, { error: "too many open shield jobs", code: "capacity" }];
      const full = await fundEscrow({ masterSeed: seed, deployment, stored, session: s, relayerUrl: "http://relayer.test" }).catch((e: unknown) => e);
      expect(full, "a full relayer: retried later, not stopped").not.toBeInstanceOf(RelayerNotReady);
      expect(withdrawals.calls).toHaveLength(0);
      shieldAnswer = [200, { id: shield.params.receiptId, state: "waiting-delivery" }];
      let registeredWhenFunded: unknown = null;
      withdrawals.events = [{ type: "fee-terms" }];
      withdrawals.afterEach = () => (registeredWhenFunded = s.journal().swaps[0].shield?.registeredAt ?? null);
      await fundEscrow({ masterSeed: seed, deployment, stored, session: s, relayerUrl: "http://relayer.test" });
      expect(withdrawals.calls, "accepted: funded").toHaveLength(1);
      expect(registeredWhenFunded, "the shield job taken before the funding").toEqual(expect.any(Number));
      expect(s.journal().swaps[0].shield).toMatchObject({ job: { state: "waiting-delivery" } });
    } finally {
      globalThis.fetch = realFetch;
      withdrawals.events = [];
      withdrawals.afterEach = undefined;
    }
  });

  it("fundEscrow keeps its own rules (the audit round of 2026-10-16, c37/c38): no relayer, a funding already sent, a closed window — nothing is sent", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const NOW = 1_900_000_000_000;
    const params = {
      orderId: ("0x" + "3e".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: NOW / 1000 + 3600, refundAfter: NOW / 1000 + 7200, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const stored: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params) };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [stored]; });
    withdrawals.calls.length = 0;
    const relayed = { masterSeed: seed, deployment, session: s, relayerUrl: "http://relayer.test", now: NOW };
    // c37: through the connected wallet nobody would execute the escrow
    await expect(fundEscrow({ ...relayed, stored, relayerUrl: null }), "no relayer").rejects.toBeInstanceOf(RelayerNotReady);
    // c38: a funding already sent — on its way, or dead without the user's word — is never sent again
    const reads = (fate: "pending" | "dead"): FundingReads => ({ spent: async () => false, relayerJob: async () => null, receipt: async () => (fate === "dead" ? "reverted" : null), txKnown: async () => fate === "pending" });
    const sent = { ...stored, fundingAttempt: { nullifiers: ["7", "8"], by: "relayer" as const, relayerUrl: "http://relayer.test", txHash: "0x" + "ee".repeat(32), at: NOW - 1000 } };
    await expect(fundEscrow({ ...relayed, stored: sent, reads: reads("pending") }), "on its way").rejects.toBeInstanceOf(FundingAlreadySent);
    await expect(fundEscrow({ ...relayed, stored: sent, reads: reads("dead") }), "dead, but nobody asked again").rejects.toBeInstanceOf(FundingAlreadySent);
    // past (or about to pass) the window: its escrow could only refund
    await expect(fundEscrow({ ...relayed, stored, now: NOW + 3600_000 - 60_000 }), "the window closes in a minute").rejects.toBeInstanceOf(OrderWindowClosed);
    expect(withdrawals.calls, "nothing was sent").toHaveLength(0);
    // the user's word replaces a dead funding, once
    await fundEscrow({ ...relayed, stored: sent, reads: reads("dead"), replaceDead: true });
    expect(withdrawals.calls).toHaveLength(1);
    // ... the attempt read dead kept by its key (the twelfth review round, the critique of 12e1, YT): a backup still holding it in flight never
    // brings it back as a funding through a merge
    expect(s.journal().swaps[0].deadAttempts).toEqual([fundingAttemptKey(sent.fundingAttempt)]);
    // the review round of 2026-11-03 (E1): one funding of an order at a time — a second caller is refused while the first is under way
    // (it had passed every check while the first was proving, waited its turn in the spend queue and funded the escrow again).
    // `stored` is the journal's own object, patched funded by the fundings above: each case starts from an unfunded copy
    const unfunded = (): StoredSwap => ({ ...stored, fundedTx: undefined, fundingAttempt: undefined, fundedFee: undefined, state: "committed" });
    s.update((j) => { j.swaps = [unfunded()]; });
    withdrawals.calls.length = 0;
    let release!: () => void;
    withdrawals.gate = new Promise<void>((r) => { release = r; });
    const first = fundEscrow({ ...relayed, stored: s.journal().swaps[0] });
    await expect(fundEscrow({ ...relayed, stored: s.journal().swaps[0] }), "a second caller while the first proves").rejects.toMatchObject({ fate: "pending" });
    release();
    withdrawals.gate = null;
    await first;
    expect(withdrawals.calls, "one funding").toHaveLength(1);
    // the spend's own turn reads the journal first: funded meanwhile (another tab's write, a reconcile), nothing is proved or sent
    s.update((j) => { j.swaps = [unfunded()]; });
    withdrawals.before = () => s.update((j) => { j.swaps[0].fundedTx = "0x" + "44".repeat(32); j.swaps[0].state = "funded"; });
    await expect(fundEscrow({ ...relayed, stored: s.journal().swaps[0] })).rejects.toMatchObject({ fate: "landed" });
    withdrawals.before = undefined;
    // the review round of 2026-11-03 (E6): a scheduled funding stopped by a permanent refusal — here the relayer not running swaps, the
    // wallet submitting through the connected wallet — is abandoned with the reason and its action done: never the backoff for good
    s.update((j) => { j.swaps = [unfunded()]; j.schedule = []; });
    scheduleAction({ kind: "fund-escrow", orderId: stored.orderId, dueAt: 0 }, s);
    settings.set({ ...settings.get(), submission: { kind: "wallet" } });
    await runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment, session: s });
    expect(s.journal().swaps[0]).toMatchObject({ state: "abandoned", paused: { code: "relayer_not_ready" } });
    expect(pendingActions(s), "its action done").toEqual([]);
    settings.reset();
  });

  it("a funding reads the window by the later of the device's clock and the chain's: a device clock behind funds nothing past the deadline (audit round 2, critic gap 5)", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const NOW = 1_900_000_000_000;
    const params = {
      orderId: ("0x" + "5c".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: NOW / 1000 + 3600, refundAfter: NOW / 1000 + 7200, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const stored: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params) };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [stored]; });
    withdrawals.calls.length = 0;
    const at = (ms: number) => async () => BigInt(Math.floor(ms / 1000));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW); // the device: an hour before the deadline
    try {
      // the chain is a minute past the deadline: the device's clock is an hour and a minute behind
      await expect(fundEscrow({ masterSeed: seed, deployment, session: s, relayerUrl: "http://relayer.test", stored, latestBlock: at(NOW + 3600_000 + 60_000) })).rejects.toBeInstanceOf(OrderWindowClosed);
      expect(withdrawals.calls, "nothing was sent").toHaveLength(0);
      // the clock itself: the later of the two; a chain behind never moves it back, a read that fails leaves the device's
      expect(await fundingClock(deployment, NOW, at(NOW + 600_000))).toBe(NOW + 600_000);
      expect(await fundingClock(deployment, NOW, at(NOW - 600_000))).toBe(NOW);
      expect(await fundingClock(deployment, NOW, async () => { throw new Error("no RPC answered"); })).toBe(NOW);
      // the chain agrees with the device: funded
      await fundEscrow({ masterSeed: seed, deployment, session: s, relayerUrl: "http://relayer.test", stored, latestBlock: at(NOW + 15_000) });
      expect(withdrawals.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dead funding sent again is a new funding: never one of an order an older build committed under the privacy address (audit round 2, n10)", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const NOW = 1_900_000_000_000;
    const params = {
      orderId: ("0x" + "40".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: NOW / 1000 + 3600, refundAfter: NOW / 1000 + 7200, refundVault: deployment.ethVault,
      refundOwnerCommitment: mainOwnerCommitment(deriveKeys(seed)).toString(), refundNoteSecret: "2", refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const sent: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params), fundingAttempt: { nullifiers: ["7", "8"], by: "relayer", relayerUrl: "http://relayer.test", txHash: "0x" + "ee".repeat(32), at: NOW - 1000 } };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [sent]; });
    withdrawals.calls.length = 0;
    const dead: FundingReads = { spent: async () => false, relayerJob: async () => null, receipt: async () => "reverted", txKnown: async () => false };
    await expect(fundEscrow({ masterSeed: seed, deployment, session: s, relayerUrl: "http://relayer.test", now: NOW, stored: sent, reads: dead, replaceDead: true })).rejects.toBeInstanceOf(OrderOutdated);
    expect(withdrawals.calls, "nothing sent").toHaveLength(0);
  });

  it("a funding that landed while its page was gone is journaled: the order funded, its transaction kept, nothing sent again (audit round 2, r10)", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const NOW = 1_900_000_000_000;
    const params = {
      orderId: ("0x" + "3f".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: NOW / 1000 + 3600, refundAfter: NOW / 1000 + 7200, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const TX = "0x" + "ee".repeat(32);
    const sent: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params), fundingAttempt: { nullifiers: ["7", "8"], by: "relayer", relayerUrl: "http://relayer.test", txHash: TX, at: NOW - 1000 } };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [sent]; });
    withdrawals.calls.length = 0;
    const landed: FundingReads = { spent: async () => true, relayerJob: async () => null, receipt: async () => "success", txKnown: async () => true };
    await expect(fundEscrow({ masterSeed: seed, deployment, session: s, relayerUrl: "http://relayer.test", now: NOW, stored: sent, reads: landed, replaceDead: true })).rejects.toMatchObject({ fate: "landed" });
    expect(s.journal().swaps[0]).toMatchObject({ state: "funded", fundedTx: TX });
    expect(withdrawals.calls, "nothing sent again").toHaveLength(0);
  });

  it("the funding's own submission is journaled before it is sent, then its transaction; a merge before it never is", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const params = {
      orderId: ("0x" + "cd".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const stored: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params) };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [stored]; });
    const own = { type: "submitting", by: "relayer", nullifiers: ["7", "8"], relayerUrl: "http://relayer.test" };
    withdrawals.events = [
      { type: "fee-terms" },
      { type: "merging", i: 1, n: 1 },
      { type: "proving" }, { type: "submitting", by: "relayer", nullifiers: ["1", "2"], relayerUrl: "http://relayer.test" }, { type: "submitted", txHash: "0x" + "aa".repeat(32), by: "relayer" },
      { type: "syncing" }, { type: "proving" }, own, { type: "submitted", txHash: "0x" + "bb".repeat(32), by: "relayer" },
    ];
    const seen: unknown[] = [];
    withdrawals.afterEach = (e) => {
      const attempt = s.journal().swaps[0].fundingAttempt;
      if (e === own || (e as { type?: string }).type === "submitting") seen.push(attempt ? { ...attempt } : null);
    };
    await fundEscrow({ masterSeed: seed, deployment, stored, session: s, relayerUrl: "http://relayer.test" });
    expect(seen, "nothing for the merge; the funding's nullifiers as soon as it is submitted, before any answer").toEqual([
      null,
      { nullifiers: ["7", "8"], by: "relayer", relayerUrl: "http://relayer.test", at: expect.any(Number) },
    ]);
    expect(s.journal().swaps[0].fundingAttempt).toMatchObject({ nullifiers: ["7", "8"], txHash: "0x" + "bb".repeat(32) });
    expect(s.journal().swaps[0]).toMatchObject({ state: "funded" });
    withdrawals.events = [];
    withdrawals.afterEach = undefined;
  });

  it("an order is neither abandoned nor returned while this tab funds it, and one closed meanwhile all the same is not sent (the ninth review round, 2026-11-04, C-04)", async () => {
    const FACTORY = ("0x" + "fa".repeat(20)) as `0x${string}`;
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY } as any;
    const params = {
      orderId: ("0x" + "c4".repeat(32)) as `0x${string}`, assetType: 0, asset: ("0x" + "00".repeat(20)) as `0x${string}`, amount: "500000000000000000",
      orderSigner: SIGNER0, executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400, refundVault: deployment.ethVault,
      refundOwnerCommitment: REFUND0.ownerCommitment.toString(), refundNoteSecret: REFUND0.noteSecret.toString(), refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`, executorTip: "0",
    };
    const stored: StoredSwap = { ...order(params.orderId), params, endpoint: predictEscrow(FACTORY, params) };
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    s.update((j) => { j.swaps = [{ ...stored }]; });
    withdrawals.calls.length = 0;
    // the funding proves (its withdrawal held here): no attempt is journaled yet, and the order reads unfunded
    let release!: () => void;
    withdrawals.gate = new Promise<void>((r) => { release = r; });
    const funding = fundEscrow({ masterSeed: seed, deployment, stored: s.journal().swaps[0], session: s, relayerUrl: "http://relayer.test" });
    expect(fundingUnderWay(stored.orderId)).toBe(true);
    expect(() => abandonSwap(stored.orderId, s), "the Advanced page's Abandon").toThrow(FundingUnderWay);
    await expect(returnFunds(stored.orderId, { masterSeed: seed, deployment, session: s }), "the Swap screen's Return funds").rejects.toBeInstanceOf(FundingUnderWay);
    expect(s.journal().swaps[0].state, "nothing was changed").toBe("committed");
    release();
    withdrawals.gate = null;
    await funding;
    expect(fundingUnderWay(stored.orderId)).toBe(false);
    expect(s.journal().swaps[0]).toMatchObject({ state: "funded" });
    // closed while its funding was proved, by a write other than an abandon: read again at the send, nothing goes
    s.update((j) => { j.swaps = [{ ...stored }]; });
    withdrawals.calls.length = 0;
    withdrawals.events = [{ type: "proving" }, { type: "submitting", by: "relayer", nullifiers: ["7", "8"], relayerUrl: "http://relayer.test" }, { type: "submitted", txHash: "0x" + "bb".repeat(32), by: "relayer" }];
    withdrawals.before = () => s.update((j) => { j.swaps[0].state = "abandoned"; });
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: s.journal().swaps[0], session: s, relayerUrl: "http://relayer.test" })).rejects.toBeInstanceOf(OrderClosed);
    expect(s.journal().swaps[0].fundingAttempt, "no attempt journaled: nothing was sent").toBeUndefined();
    expect(s.journal().swaps[0]).toMatchObject({ state: "abandoned" });
    withdrawals.events = [];
    withdrawals.before = undefined;
  });
});
