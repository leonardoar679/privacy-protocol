// The twelfth review round, slice 12e1 (E12-1, NF-1; the reconciler's decision W6 §1): a backup merged into this device's journal of the same
// wallet merges the orders, campaigns and address-book entries both hold by lineage — the copy that saw everything the other saw, and more,
// wins; a fact is never undone (notes, Activity lines and other records both hold stay the device's). Until then the device's copy of a campaign,
// an order's state, a scheduled action and an address-book entry won whole: a step the backup's installation committed and funded was committed
// again here (a second order for one piece, the first orphaned with its escrow), and a Pause, a Return the rest, an abandon or a retirement made
// there was undone. The reviewer's and the verifiers' probes (scratchpad review12/E, VE, W2, W6) and the critiques' became these cases.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCampaign,
  exposure,
  nextAction,
  rateE18,
  replan,
  withCampaignState,
  withTrancheState,
  type Campaign,
  type ExecutionBounds,
  type Tranche,
  type TranchePlan,
} from "@privacy-wallet/protocol/wallet/campaign";
import { addEntry, approveEntry, canUse, markSettled, markUsed, retire, verifyEntry, type AddressBookEntry } from "@privacy-wallet/protocol/wallet/addressBook";
import { configure, defaultConfig } from "../src/config";
import { WalletSession } from "../src/wallet/session";
import { memoryStorage } from "../src/wallet/storage";
import { deadAttemptCleared, emptyJournal, fundingAttemptKey, type JournalData, type ScheduledAction, type StoredSwap } from "../src/wallet/journal";
import { CAMPAIGN_ENDED, DIVERGED_DETAIL, ONE_ORDER_DETAIL, TAKEN_UP_DETAIL, lineageOf, mergeJournals, mergedProblems } from "../src/wallet/journalMerge";
import { TERMINAL_STATES, cancelCampaign, pauseCampaign, replanRemainder } from "../src/wallet/campaigns";
import { runCampaignTick, type CampaignIo } from "../src/wallet/campaignRunner";
import { defaultSettings } from "../src/wallet/settings";
import { noteStore } from "../src/wallet/notes";
import { abandonSwap } from "../src/swapFunding";
import { journalStateOf } from "../src/orderTracker";
import { CATALOG } from "../src/operations/errors/codes";
import type { OperationRecord } from "../src/wallet/operationRecord";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const ETH = 10n ** 18n;
const T0 = Date.parse("2026-11-06T10:00:00Z");
const bounds = (amount: bigint): ExecutionBounds =>
  ({
    orderId: "0x" + "11".repeat(32),
    assetIn: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
    chainIn: "ethereum",
    amountInLimit: amount.toString(),
    assetOut: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
    chainOut: "bitcoin",
    destination: { kind: "fresh-per-tranche" },
    minimumOutput: rateE18(24_000_000n, 800n * ETH).toString(),
    expiry: 9_999_999_999,
    maxFeeBps: 60,
    privacyMode: "balanced",
    maxExternalExposure: ((amount * 5000n) / 10000n).toString(),
    executeWindowSeconds: 7200,
  }) as ExecutionBounds;
const plan = {
  riskClass: "R5",
  bandBps: [500, 3400],
  capBps: 5000,
  sizing: "varied",
  concurrency: "sequential",
  maxParallel: 1,
  gate: "destination-final",
  cadenceSeconds: [600, 5400],
  providerShareCapBps: 10000,
  executeWindowSeconds: 7200,
  estimatedTranches: 3,
  estimatedSeconds: 60_000,
  shapeNotes: false,
} as TranchePlan;
const CAMPAIGN = "camp-12e1";
function campaign(): Campaign {
  const c = createCampaign({
    id: CAMPAIGN,
    now: T0,
    mode: "balanced",
    tier: "high-value",
    request: { from: bounds(30n * ETH).assetIn, to: bounds(30n * ETH).assetOut, amount: (30n * ETH).toString(), preference: "balanced" } as never,
    bounds: bounds(30n * ETH),
    plan,
    pieces: [10n * ETH, 10n * ETH, 10n * ETH],
    referenceRateE18: rateE18(24_000_000n, 800n * ETH),
  });
  return { ...withCampaignState(c, "running", T0 + 1000), provider: "thorchain" };
}
/** A step's history the way the runner writes it. */
function stepThrough(c: Campaign, i: number, states: string[], at0: number, orderId: string): Campaign {
  let x = withTrancheState(c, i, "committed", at0, { orderId, provider: "thorchain" });
  states.forEach((s, k) => {
    x = withTrancheState(x, i, s as never, at0 + (k + 1) * 100);
  });
  return x;
}
const X = "0x" + "ab".repeat(32);
const order = (orderId: string, extra: Partial<StoredSwap> = {}): StoredSwap =>
  ({
    orderId,
    attemptId: "0x" + "22".repeat(32),
    refundCounter: 1,
    provider: "thorchain",
    policy: "privacy-execution",
    request: { amount: (10n * ETH).toString(), destination: "bc1qadopteddestination00000000000000000000" },
    params: { amount: (10n * ETH).toString(), executeDeadline: Math.floor(T0 / 1000) + 9000, refundAfter: Math.floor(T0 / 1000) + 18000 },
    endpoint: "0x" + "e5".repeat(20),
    createdAt: T0 + 2000,
    state: "committed",
    ...extra,
  }) as unknown as StoredSwap;
const funded = (orderId: string, extra: Partial<StoredSwap> = {}): StoredSwap =>
  order(orderId, {
    state: "funded",
    fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", at: T0 + 2500 },
    fundedTx: "0x" + "cd".repeat(32),
    campaign: { id: CAMPAIGN, index: 0 },
    ...extra,
  });
const journal = (o: Partial<JournalData>): JournalData => ({ ...emptyJournal(), ...o });
const NOW = T0 + 60 * 60_000;
const merge = (device: JournalData, backup: JournalData): JournalData => mergeJournals(device, backup, () => 0.5, NOW);

/** An io that records every call and stops the tick at the first one it does not script (a commit, a signature). */
function recordingIo(calls: string[], scripted: Partial<CampaignIo> = {}): CampaignIo {
  const base: Record<string, unknown> = {
    risk: async () => null,
    gasPriceWei: async () => null,
    crossRateE18: () => null,
    notesShaped: () => true,
    shape: async () => {},
    freshDestination: () => ({ address: "bc1q12e1freshdestination000000000000000000", index: 0 }),
    escrowBalance: async () => null,
    job: async () => null,
    commit: async (_c: Campaign, t: { index: number }) => {
      calls.push(`commit:${t.index}`);
      throw new Error("the test stops at the commit");
    },
    ...scripted,
  };
  return new Proxy(base, {
    get: (t, k) =>
      k in t
        ? t[k as string]
        : () => {
            calls.push(String(k));
            throw new Error(`the test stops at ${String(k)}`);
          },
  }) as unknown as CampaignIo;
}
const tick = (s: WalletSession, calls: string[], now = NOW, scripted: Partial<CampaignIo> = {}) =>
  runCampaignTick(
    { id: `campaign-tick:${CAMPAIGN}`, kind: "campaign-tick", orderId: CAMPAIGN, dueAt: T0 },
    {
      masterSeed: s.state().seed!,
      deployment: null,
      session: s,
      io: recordingIo(calls, scripted),
      now: () => now,
      settings: () => defaultSettings(),
      rng: () => 0.5,
    },
  ).catch(() => null);

afterEach(() => noteStore.releaseCounters(0));

describe("A → B → A through the session: the backup's installation ran the campaign (E12-1)", () => {
  /** Device A confirms the campaign, its backup goes to B, B acts (`onB`), B's backup comes back to A over A's own journal. */
  async function roundTrip(onB: (B: WalletSession) => void, onA: (A: WalletSession) => void = () => {}): Promise<WalletSession> {
    const diskA = memoryStorage();
    configure(defaultConfig({ storage: () => diskA, kdfLog2N: 12 }));
    const A = new WalletSession(diskA, KDF);
    await A.create("pw", new Uint8Array(32).fill(77));
    A.acknowledgePhrase();
    A.update((j) => {
      j.campaigns = [campaign()];
    });
    onA(A);
    const backupA = A.exportBackup();
    A.lock();
    const B = new WalletSession(memoryStorage(), KDF);
    expect(await B.restoreFromBackup(backupA, "pw")).toBe(true);
    onB(B);
    const backupB = B.exportBackup();
    B.lock();
    expect(await A.restoreFromBackup(backupB, "pw", { replace: true })).toBe(true);
    noteStore.releaseCounters(0); // the restore's hold, as a complete scan releases it: the runner may commit again
    return A;
  }
  const fundStep0 = (B: WalletSession) =>
    B.update((j) => {
      j.campaigns = [stepThrough(j.campaigns![0], 0, ["funded"], T0 + 2000, X)];
      j.swaps = [...j.swaps, funded(X)];
    });

  it("B committed and funded step 0 (order X): A's merged step 0 is B's — order X — and A's tick commits nothing for it", async () => {
    const A = await roundTrip(fundStep0);
    const c = A.journal().campaigns![0];
    expect(c.tranches[0]).toMatchObject({ state: "funded", orderId: X });
    expect(mergedProblems(A.journal())).toEqual([]);
    const calls: string[] = [];
    await tick(A, calls);
    expect(calls, "no second order for step 0").not.toContain("commit:0");
    A.lock();
  });

  it("the control: without B's step, A's tick commits step 0 (the harness reaches a commit)", async () => {
    const A = await roundTrip(() => {});
    const calls: string[] = [];
    await tick(A, calls);
    expect(calls).toContain("commit:0");
    A.lock();
  });

  it("B's Pause stands: the merged campaign is paused and commits nothing", async () => {
    const A = await roundTrip((B) => {
      fundStep0(B);
      pauseCampaign(CAMPAIGN, B, T0 + 5000);
    });
    expect(A.journal().campaigns![0]).toMatchObject({ state: "paused", pause: { reason: "user" } });
    const calls: string[] = [];
    await tick(A, calls);
    expect(calls.filter((x) => x.startsWith("commit"))).toEqual([]);
    A.lock();
  });

  it("B's Return the rest stands: the merged campaign winds down, its planned steps skipped", async () => {
    const A = await roundTrip((B) => {
      fundStep0(B);
      cancelCampaign(CAMPAIGN, B, T0 + 5000);
    });
    const c = A.journal().campaigns![0];
    expect(c.state).toBe("winding-down");
    expect(c.tranches.slice(1).map((t) => t.state)).toEqual(["skipped", "skipped"]);
    const calls: string[] = [];
    await tick(A, calls);
    expect(calls.filter((x) => x.startsWith("commit"))).toEqual([]);
    A.lock();
  });

  it("an order B abandoned stays abandoned, and A's pending funding of it is dropped", async () => {
    const O = "0x" + "0a".repeat(32);
    const A = await roundTrip(
      (B) => abandonSwap(O, B),
      (A) =>
        A.update((j) => {
          j.swaps = [...j.swaps, order(O)];
          j.schedule = [...j.schedule, { id: `fund-escrow:${O}`, kind: "fund-escrow", orderId: O, dueAt: T0 + 60_000 }];
        }),
    );
    expect(A.journal().swaps.find((x) => x.orderId === O)?.state).toBe("abandoned");
    expect(A.journal().schedule.some((a) => a.id === `fund-escrow:${O}` && !a.done)).toBe(false);
    A.lock();
  });
});

describe("orders by lineage (W6 §1: the reopen of gap 91, C12-3, the abandon)", () => {
  const handed = { fundedTx: "0x" + "ab".repeat(32), jobId: "job-1", handedOverAt: 10, executionTx: "0x" + "cd".repeat(32) };
  const closedHist = [
    { state: "PROVIDER_EXECUTING", at: 1_000 },
    { state: "PROVIDER_FAILED", at: 2_000, note: "Needs attention" },
  ];
  const closed = order("0x0f", {
    ...handed,
    state: "completed",
    track: { state: "PROVIDER_FAILED", label: "Needs attention", at: 2_000 },
    history: closedHist,
  });
  const reopenedState = journalStateOf(closed, { state: "LATE_REFUND" }, { state: "completed" });
  const reopened = order("0x0f", {
    ...handed,
    state: String(reopenedState),
    track: { state: "LATE_REFUND", label: "Needs attention", at: 90_000 },
    history: [...closedHist, { state: "LATE_REFUND", at: 90_000, note: "Needs attention" }],
  });
  const one = (d: StoredSwap, b: StoredSwap): StoredSwap => merge(journal({ swaps: [d] }), journal({ swaps: [b] })).swaps[0];

  it("the reopen itself: executed, and only late_refund offers Return funds", () => {
    expect(reopenedState).toBe("executed");
    expect(CATALOG.provider_failed.actions).not.toContain("start-refund");
    expect(CATALOG.late_refund.actions).toContain("start-refund");
  });

  it("a backup reopened over a closed device: the reopen comes across (its Return funds)", () => {
    expect(one(closed, reopened)).toMatchObject({ state: "executed", track: { state: "LATE_REFUND" } });
  });

  it("a device reopened over an older closed backup: the reopen stays", () => {
    expect(one(reopened, closed)).toMatchObject({ state: "executed", track: { state: "LATE_REFUND" } });
  });

  it("reopened, then refunded on one copy (Return funds): refunded, whichever copy is the device's", () => {
    const back = order("0x0f", {
      ...handed,
      state: "refunded",
      refunds: [{ leafIndex: 9, vault: "0x1", amount: "990000000000000000" }],
      track: { state: "REFUNDED", label: "Refunded", at: 95_000 },
      history: [...reopened.history!, { state: "REFUND_PENDING", at: 93_000 }, { state: "REFUNDED", at: 95_000 }],
    });
    expect(one(reopened, back).state).toBe("refunded");
    expect(one(back, reopened).state).toBe("refunded");
  });

  it("closed by its refund with no reading written: the older reopened copy does not reopen it again", () => {
    // journalRefunds and the runner's settle close an order without a history entry: the closed copy's last entry is the reopen itself
    const closedAgain = { ...reopened, state: "refunded", refunds: [{ leafIndex: 9, vault: "0x1", amount: "990000000000000000" }] } as StoredSwap;
    expect(one(reopened, closedAgain).state).toBe("refunded");
    expect(one(closedAgain, reopened).state).toBe("refunded");
  });

  it("a reading that did not settle never reopens a closed order through a merge (C12-3, a backup an older build wrote)", () => {
    const unsettled = order("0x0f", {
      ...handed,
      state: "executed",
      track: { state: "PROVIDER_EXECUTING", label: "Executing", at: 90_000 },
      history: [...closedHist, { state: "PROVIDER_EXECUTING", at: 90_000 }],
    });
    expect(one(closed, unsettled).state).toBe("completed");
    expect(one(unsettled, closed).state).toBe("completed");
  });

  it("an abandon stands for an order nothing funded, never for one either copy funded or sent a funding for", () => {
    expect(one(order("0x0a"), order("0x0a", { state: "abandoned" })).state).toBe("abandoned");
    expect(one(order("0x0a", { state: "abandoned" }), order("0x0a")).state).toBe("abandoned");
    const paid = order("0x0a", { state: "funded", fundedTx: "0x" + "11".repeat(32) });
    expect(one(paid, order("0x0a", { state: "abandoned" }))).toMatchObject({ state: "funded", fundedTx: paid.fundedTx });
    expect(one(order("0x0a", { state: "abandoned" }), paid)).toMatchObject({ state: "funded", fundedTx: paid.fundedTx });
    const sent = order("0x0a", { fundingAttempt: { nullifiers: ["5", "6"], by: "relayer", at: T0 } });
    expect(one(order("0x0a", { state: "abandoned" }), sent)).toMatchObject({ state: "committed", fundingAttempt: sent.fundingAttempt });
  });

  it("two copies that each read the order after their common point (gap 51): the later reading's block, both histories once each", () => {
    const d = order("0x0e", {
      state: "executing",
      jobId: "j",
      history: [
        { state: "SOURCE_FINAL", at: 1 },
        { state: "PROVIDER_EXECUTING", at: 5 },
      ],
      track: { state: "PROVIDER_EXECUTING", label: "Executing", at: 5 },
    });
    const b = order("0x0e", {
      state: "executed",
      jobId: "j",
      history: [
        { state: "SOURCE_FINAL", at: 1 },
        { state: "DESTINATION_SUBMITTED", at: 9 },
      ],
      track: { state: "DESTINATION_SUBMITTED", label: "Delivering", at: 9 },
    });
    const m = one(d, b);
    expect(m).toMatchObject({ state: "executed", track: { state: "DESTINATION_SUBMITTED" } });
    expect(m.history?.map((h) => h.state)).toEqual(["SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED"]);
    expect(one(b, d).state, "whichever copy is the device's").toBe("executed");
  });

  it("equal histories keep the device's block; the backup's funding facts and refunds come across; both histories once each", () => {
    const d = order("0x0b", { history: [{ state: "SOURCE_SUBMITTED", at: 5 }], refunds: [{ leafIndex: 2, vault: "0x2", amount: "1" }] });
    const b = order("0x0b", {
      state: "funded",
      fundedTx: "0x" + "77".repeat(32),
      refunds: [{ leafIndex: 3, vault: "0x2", amount: "1" }],
      history: [{ state: "SOURCE_SUBMITTED", at: 5 }],
    });
    expect(one(d, b)).toMatchObject({
      state: "committed",
      fundedTx: b.fundedTx,
      refunds: [...d.refunds!, ...b.refunds!],
      history: [{ state: "SOURCE_SUBMITTED", at: 5 }],
    });
  });

  it("the escrow's own facts come across: its Executed event's transaction with its mark, its executed flag read true", () => {
    const d = order("0x0c", { state: "executing", jobId: "job-9" });
    const b = order("0x0c", { state: "executing", jobId: "job-9", executionTx: "0x" + "99".repeat(32), executionFromEvent: true, escrowExecutedSeen: true });
    expect(one(d, b)).toMatchObject({ executionTx: b.executionTx, executionFromEvent: true, escrowExecutedSeen: true });
  });

  it("a same-chain swap's shield receipt: the notes either copy found, the executor's later report, the registration", () => {
    const shield = (extra: object) => ({ factory: "0xf", receiver: "0xr", params: {} as never, counter: 7, noteData: "0x", ...extra });
    const d = order("0x0d", { shield: shield({ job: { state: "waiting-delivery", at: 10 }, leaves: [{ leafIndex: 1, vault: "0xv", amount: "5" }] }) });
    const b = order("0x0d", { shield: shield({ registeredAt: 8, job: { state: "shielded", at: 20 }, leaves: [{ leafIndex: 4, vault: "0xv", amount: "6" }] }) });
    expect(one(d, b).shield).toMatchObject({
      registeredAt: 8,
      job: { state: "shielded", at: 20 },
      leaves: [
        { leafIndex: 1, vault: "0xv", amount: "5" },
        { leafIndex: 4, vault: "0xv", amount: "6" },
      ],
    });
    expect(one(b, d).shield?.job, "the later report, whichever copy holds it").toMatchObject({ state: "shielded" });
  });

  it("an order's operation record comes from the copy its state came from; any other record stays the device's unless the backup's is a success it lacks", () => {
    const rec = (id: string, state: OperationRecord["state"]): OperationRecord =>
      ({
        id,
        kind: "swap",
        state,
        createdAt: 1,
        updatedAt: 2,
        amounts: { asset: "ETH", decimals: 18, input: "1" },
        fees: [],
        destination: { kind: "fresh", display: "x", chain: "bitcoin" },
        refs: { txHashes: [] },
        fundsClass: "unknown",
      }) as unknown as OperationRecord;
    const id = "swap:0x0f";
    const m = merge(
      journal({ swaps: [closed], operations: [rec(id, "RECOVERY_REQUIRED")] }),
      journal({ swaps: [reopened], operations: [rec(id, "MONITORING" as never)] }),
    );
    expect(m.operations?.find((r) => r.id === id)?.state).toBe("MONITORING");
    const n = merge(journal({ operations: [rec("op:1", "SUBMITTING" as never)] }), journal({ operations: [rec("op:1", "COMPLETED")] }));
    expect(n.operations?.[0].state, "the backup's success over the device's open record").toBe("COMPLETED");
  });
});

describe("campaigns by lineage (W6 §1: the descendant whole, the diverged merge)", () => {
  it("the history is compared by what each copy saw, not by its order: a tick's write sorts an answer given meanwhile into place", () => {
    const a = [
      { state: "running", at: 1 },
      { state: "paused", at: 3 },
    ];
    const b = [
      { state: "running", at: 1 },
      { state: "reassessing", at: 2 },
      { state: "paused", at: 3 },
    ];
    expect(lineageOf(a, b)).toBe("backup");
    expect(lineageOf(b, a)).toBe("device");
    expect(lineageOf(a, a)).toBe("equal");
    expect(lineageOf([{ state: "x", at: 1 }], [{ state: "y", at: 2 }])).toBe("diverged");
  });

  it("a Pause the other copy gave with nothing else changed stands: the campaign's own history is compared, not only its steps", () => {
    const both = stepThrough(campaign(), 0, ["funded"], T0 + 2000, X);
    const paused = withCampaignState(both, "paused", T0 + 5000, "paused by you", {
      pause: { reason: "user", detail: "Paused by you.", at: T0 + 5000 } as never,
      decidedAt: T0 + 5000,
    });
    expect(merge(journal({ campaigns: [both], swaps: [funded(X)] }), journal({ campaigns: [paused], swaps: [funded(X)] })).campaigns![0]).toMatchObject({
      state: "paused",
      decidedAt: T0 + 5000,
    });
    expect(merge(journal({ campaigns: [paused], swaps: [funded(X)] }), journal({ campaigns: [both], swaps: [funded(X)] })).campaigns![0].state).toBe("paused");
  });

  it("an older backup over a newer device (gap 118's direction): the device's further copy stays whole", () => {
    const newer = stepThrough(campaign(), 0, ["funded", "signed"], T0 + 2000, X);
    const m = merge(journal({ campaigns: [newer], swaps: [funded(X)] }), journal({ campaigns: [campaign()] }));
    expect(m.campaigns![0]).toEqual(newer);
  });

  it("a refund on the backup's copy: the refunded step stays refunded and the remainder is the backup's own re-plan", () => {
    const device = stepThrough(campaign(), 0, ["funded", "signed", "executing"], T0 + 2000, X);
    let other = stepThrough(campaign(), 0, ["funded", "signed", "executing", "refunding"], T0 + 2000, X);
    other = withTrancheState(other, 0, "refunded", T0 + 2900, { outcome: { refunded: ((99n * ETH) / 10n).toString() } });
    other = replanRemainder(other, T0 + 3000, () => 0.3);
    const m = merge(journal({ campaigns: [device], swaps: [funded(X)] }), journal({ campaigns: [other], swaps: [funded(X, { state: "refunded" })] }));
    expect(m.campaigns![0]).toEqual(other);
    expect(mergedProblems(m)).toEqual([]);
  });

  describe("both copies ran it (gap 51's concurrent use)", () => {
    const Y = "0x" + "cc".repeat(32);
    // the common point: step 0 funded with X; then each copy went on alone
    const common = stepThrough(campaign(), 0, ["funded"], T0 + 2000, X);
    // the device: step 0 executing, then step 1 committed with Y and its funding sent
    const deviceCopy = stepThrough(withTrancheState(common, 0, "executing", T0 + 4000), 1, [], T0 + 5000, Y);
    // the backup: step 0 refunded, its remainder re-planned (other pieces from index 1 on), later than the device's last event
    const backupCopy = replanRemainder(
      withTrancheState(withTrancheState(common, 0, "refunding", T0 + 4500), 0, "refunded", T0 + 6000, { outcome: { refunded: (10n * ETH).toString() } }),
      T0 + 6100,
      () => 0.9,
    );
    const swaps = [funded(X), funded(Y, { campaign: { id: CAMPAIGN, index: 1 }, fundedTx: undefined, state: "committed" })];

    it("the base is the later copy; step 0 by its rank (a terminal step never yields); the device's funded step 1 is taken up, no step planned beside it; paused reconcile", () => {
      const m = merge(journal({ campaigns: [deviceCopy], swaps }), journal({ campaigns: [backupCopy], swaps: [funded(X, { state: "refunded" })] }));
      const c = m.campaigns![0];
      expect(c.tranches[0].state, "refunded over executing").toBe("refunded");
      expect(c.tranches[1]).toMatchObject({ orderId: Y, state: "committed" });
      // the remainder is not planned here: the runner plans it once nothing is in flight, asking first — step 0 came back (B1)
      expect(c.tranches.length).toBe(2);
      expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: DIVERGED_DETAIL } });
      expect(mergedProblems(m)).toEqual([]);
      const settled = {
        ...c,
        state: "running" as const,
        pause: undefined,
        tranches: c.tranches.map((t) => (t.index === 1 ? { ...t, state: "settled" as const } : t)),
      };
      expect(nextAction(settled, { now: NOW, pause: null, notesShaped: true }), "the returned 10 ETH is asked about before it is swapped again").toMatchObject({
        kind: "pause",
        reason: "bounds",
        replan: true,
      });
    });

    it("both copies committed their own order for one step: the further along is the step's; the other's, sent a funding, is taken up at the next position, its order's step index following", () => {
      const Z = "0x" + "21".repeat(32);
      const W = "0x" + "12".repeat(32);
      const dev = stepThrough(common, 1, [], T0 + 5000, Z); // committed, its funding sent
      const bak = stepThrough(withTrancheState(common, 0, "executing", T0 + 4000), 1, ["funded"], T0 + 7000, W);
      const m = merge(
        journal({
          campaigns: [dev],
          swaps: [funded(X), order(Z, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: { nullifiers: ["7", "8"], by: "relayer", at: T0 + 5050 } })],
        }),
        journal({ campaigns: [bak], swaps: [funded(X), funded(W, { campaign: { id: CAMPAIGN, index: 1 } })] }),
      );
      const c = m.campaigns![0];
      expect(c.tranches[1]).toMatchObject({ orderId: W, state: "funded" });
      expect(c.tranches[2]).toMatchObject({ index: 2, orderId: Z, state: "committed" });
      expect(m.swaps.find((x) => x.orderId === Z)?.campaign).toEqual({ id: CAMPAIGN, index: 2 });
      expect(
        c.tranches.filter((t) => t.state === "planned"),
        "nothing left to plan beside three steps of 10",
      ).toEqual([]);
      expect(mergedProblems(m)).toEqual([]);
    });

    it("an order of the campaign no step names and nothing funded is given up", () => {
      const lone = order("0x" + "dd".repeat(32), { campaign: { id: CAMPAIGN, index: 2 } });
      const m = merge(journal({ campaigns: [deviceCopy], swaps: [...swaps, lone] }), journal({ campaigns: [backupCopy] }));
      expect(m.swaps.find((x) => x.orderId === lone.orderId)?.state).toBe("abandoned");
      expect(mergedProblems(m)).toEqual([]);
    });

    it("a stop either copy gave is never undone: Return the rest on the device winds the merged campaign down", () => {
      const stoppedDevice = withCampaignState(deviceCopy, "winding-down", T0 + 5500, "cancelled by you", { decidedAt: T0 + 5500 });
      const m = merge(journal({ campaigns: [stoppedDevice], swaps }), journal({ campaigns: [backupCopy] }));
      const c = m.campaigns![0];
      expect(c.state).toBe("winding-down");
      expect(c.tranches.some((t) => t.state === "planned" || t.state === "ready")).toBe(false);
      expect(c.decidedAt).toBe(T0 + 5500);
    });
  });
});

describe("the merged schedule follows the merged records (W6 §1)", () => {
  const action = (id: string, kind: ScheduledAction["kind"], orderId: string, extra: Partial<ScheduledAction> = {}): ScheduledAction => ({
    id,
    kind,
    orderId,
    dueAt: T0,
    ...extra,
  });

  it("one pending tick due at the merge for a campaign not ended — a done tick of an unfinished campaign had stopped it — and none for an ended one", () => {
    const ended = { ...withCampaignState(campaign(), "completed", T0 + 9000), id: "camp-ended" };
    const m = merge(
      journal({
        campaigns: [campaign(), ended],
        schedule: [
          action(`campaign-tick:${CAMPAIGN}`, "campaign-tick", CAMPAIGN, { done: true }),
          action("campaign-tick:camp-ended", "campaign-tick", "camp-ended"),
        ],
      }),
      journal({ campaigns: [campaign()], schedule: [action(`campaign-shape:${CAMPAIGN}`, "campaign-shape", CAMPAIGN)] }),
    );
    expect(m.schedule.filter((a) => a.orderId === CAMPAIGN)).toEqual([
      { id: `campaign-tick:${CAMPAIGN}`, kind: "campaign-tick", orderId: CAMPAIGN, dueAt: NOW },
    ]);
    expect(m.schedule.some((a) => a.orderId === "camp-ended")).toBe(false);
  });

  it("an order's funding only while it is open, not a campaign's and not funded; the device's entry and backoff when both hold it", () => {
    const open = order("0x01");
    const gone = order("0x02", { state: "abandoned" });
    const paid = order("0x03", { state: "funded", fundedTx: "0x" + "33".repeat(32) });
    const step = order("0x04", { campaign: { id: CAMPAIGN, index: 0 } });
    const fe = (o: StoredSwap, extra: Partial<ScheduledAction> = {}) => action(`fund-escrow:${o.orderId}`, "fund-escrow", o.orderId, extra);
    const m = merge(
      journal({ swaps: [open, gone, paid, step], schedule: [fe(open, { attempts: 2, nextAttemptAt: T0 + 1 }), fe(gone), fe(paid), fe(step)] }),
      journal({ swaps: [open], schedule: [fe(open)] }),
    );
    expect(m.schedule).toEqual([fe(open, { attempts: 2, nextAttemptAt: T0 + 1 })]);
  });

  it("maintenance and the note scan never from the backup (A11-9)", () => {
    const m = merge(
      journal({}),
      journal({ schedule: [action("housekeeping:auto", "housekeeping", "auto"), action("discovery:pool", "discovery", "pool", { heldFailures: 3 })] }),
    );
    expect(m.schedule).toEqual([]);
  });
});

describe("the address book field by field (NF-1)", () => {
  const entered = (): AddressBookEntry =>
    addEntry({ id: "bitcoin:bc1qdest", chain: "bitcoin", address: "bc1qdest", normalized: "bc1qdest", source: "entered", now: T0 });
  const ready = (): AddressBookEntry => approveEntry(verifyEntry(entered(), "signed-message", T0 + 1000), T0 + 2000);
  const one = (d: AddressBookEntry, b: AddressBookEntry): AddressBookEntry =>
    merge(journal({ addressBook: [d] }), journal({ addressBook: [b] })).addressBook![0];
  const late = { tier: "high-value" as const, now: T0 + 3 * 86_400_000 };

  it("a retirement either copy made stands: never paid again at any size", () => {
    expect(canUse(one(ready(), retire(ready())), late)).toEqual({ ok: false, reason: "retired" });
    expect(canUse(one(retire(ready()), ready()), late)).toEqual({ ok: false, reason: "retired" });
    const fresh = addEntry({ id: "bitcoin:bc1qfresh", chain: "bitcoin", address: "bc1qfresh", normalized: "bc1qfresh", source: "fresh", now: T0 });
    expect(one(markUsed(fresh, "op", T0 + 1), markSettled(markUsed(fresh, "op", T0 + 1), T0 + 2)).lifecycle, "a fresh address paid once").toBe("retired");
  });

  it("verified from either, the later approval, every use, the later cooling-off; the device's label", () => {
    const d = { ...entered(), label: "mine", addedAt: T0 + 50 };
    const b = markUsed(ready(), "order-1", T0 + 4000);
    const m = one(d, { ...b, coolingUntil: T0 + 90_000_000, usedBy: ["order-1", "order-2"] });
    expect(m).toMatchObject({
      label: "mine",
      lifecycle: "used",
      verification: { status: "verified", method: "signed-message" },
      approvedAt: T0 + 2000,
      lastUsedAt: T0 + 4000,
      coolingUntil: T0 + 90_000_000,
      usedBy: ["order-1", "order-2"],
      addedAt: T0,
    });
  });
});

describe("the campaign runner takes up an order another copy committed for a step (W6 §1 item 4)", () => {
  async function session(swaps: StoredSwap[], c: Campaign = campaign()): Promise<WalletSession> {
    const disk = memoryStorage();
    configure(defaultConfig({ storage: () => disk, kdfLog2N: 12 }));
    const s = new WalletSession(disk, KDF);
    await s.create("pw", new Uint8Array(32).fill(78));
    s.acknowledgePhrase();
    s.update((j) => {
      j.campaigns = [c];
      j.swaps = swaps;
    });
    return s;
  }
  const step = (s: WalletSession, i: number) => s.journal().campaigns![0].tranches[i];
  const orderIn = (s: WalletSession, id: string) => s.journal().swaps.find((x) => x.orderId === id);

  it("a funded order naming a planned step is taken up at its own facts' step — funded —, never committed again", async () => {
    const s = await session([funded(X)]);
    const calls: string[] = [];
    await tick(s, calls);
    expect(calls).not.toContain("commit:0");
    expect(step(s, 0)).toMatchObject({ state: "funded", orderId: X });
    await tick(s, calls, NOW + 2000);
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("an order whose only funding fact is one sent (its fate unknown) is taken up committed: the funding is followed, never sent again", async () => {
    const sent = order(X, { campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: { nullifiers: ["5", "6"], by: "relayer", at: T0 + 2500 } });
    const s = await session([sent]);
    const calls: string[] = [];
    await tick(s, calls);
    expect(step(s, 0)).toMatchObject({ state: "committed", orderId: X });
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("of two orders naming one step, the one carrying a funding is taken up, whichever comes first", async () => {
    const stale = order("0x" + "ef".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
    const s = await session([stale, funded(X)]);
    const calls: string[] = [];
    await tick(s, calls);
    expect(step(s, 0).orderId).toBe(X);
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("taken up while the campaign had not started, the campaign starts: the next pass advances that step, never commits the next beside it", async () => {
    const fresh = createCampaign({
      id: CAMPAIGN,
      now: T0,
      mode: "balanced",
      tier: "high-value",
      request: campaign().request,
      bounds: bounds(30n * ETH),
      plan,
      pieces: [10n * ETH, 10n * ETH, 10n * ETH],
      referenceRateE18: rateE18(24_000_000n, 800n * ETH),
    });
    const s = await session([funded(X)], { ...fresh, provider: "thorchain" });
    expect(s.journal().campaigns![0].state).toBe("user-confirmed");
    const calls: string[] = [];
    await tick(s, calls);
    expect(s.journal().campaigns![0].state).toBe("running");
    await tick(s, calls, NOW + 2000);
    expect(calls.filter((x) => x.startsWith("commit"))).toEqual([]);
    s.lock();
  });

  it("an order of another size is taken up at its own size; the planned steps go, the rest planned again once nothing is in flight", async () => {
    const small = funded(X, { request: { amount: (5n * ETH).toString(), destination: "bc1qadopteddestination00000000000000000000" } });
    const s = await session([small]);
    await tick(s, []);
    const c = s.journal().campaigns![0];
    expect(c.tranches[0]).toMatchObject({ orderId: X, amount: (5n * ETH).toString() });
    expect(
      c.tranches.filter((t) => t.state === "planned"),
      "no stale piece beside it",
    ).toEqual([]);
    expect(exposure(c).remaining, "what the runner plans next").toBe(25n * ETH);
    s.lock();
  });

  it("an open order this journal knows no funding of is read first: its executor holding it takes it up, handed over", async () => {
    const lone = order("0x" + "ee".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
    const s = await session([lone]);
    const calls: string[] = [];
    await tick(s, calls, NOW, { job: async () => ({ id: "job-77", state: "executing" }) as never });
    expect(step(s, 0)).toMatchObject({ state: "executing", orderId: lone.orderId, jobId: "job-77" });
    expect(orderIn(s, lone.orderId)).toMatchObject({ jobId: "job-77", state: "executing" });
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("an order already handed over (its job journaled) is taken up executing, never funded again", async () => {
    const handed = order(X, { campaign: { id: CAMPAIGN, index: 0 }, jobId: "job-5", handedOverAt: T0 + 3000, state: "executing" });
    const s = await session([handed]);
    const calls: string[] = [];
    await tick(s, calls);
    expect(step(s, 0)).toMatchObject({ state: "executing", orderId: X, jobId: "job-5", handedOverAt: T0 + 3000 });
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("... an escrow holding the order's own smaller size takes it up at that size (never the step's)", async () => {
    const lone = order("0x" + "ee".repeat(32), {
      campaign: { id: CAMPAIGN, index: 0 },
      request: { amount: (5n * ETH).toString(), destination: "bc1qadopteddestination00000000000000000000" },
    });
    const s = await session([lone]);
    await tick(s, [], NOW, { escrowBalance: async () => 5n * ETH });
    expect(step(s, 0)).toMatchObject({ orderId: lone.orderId, amount: (5n * ETH).toString() });
    expect(orderIn(s, lone.orderId)?.state).not.toBe("abandoned");
    s.lock();
  });

  it("... its escrow holding it takes it up funded, the read journaled as a funding: a later read that fails, on another route, never gives it up", async () => {
    const lone = order("0x" + "ee".repeat(32), { campaign: { id: CAMPAIGN, index: 0 }, provider: "chainflip" });
    const s = await session([lone]);
    const calls: string[] = [];
    await tick(s, calls, NOW, { escrowBalance: async () => 10n * ETH });
    expect(step(s, 0)).toMatchObject({
      state: "funded",
      orderId: lone.orderId,
      provider: "chainflip",
      destination: "bc1qadopteddestination00000000000000000000",
    });
    expect(orderIn(s, lone.orderId)).toMatchObject({ state: "funded", fundedAt: NOW });
    for (const k of [1, 2]) await tick(s, calls, NOW + k * 2000, { escrowBalance: async () => null });
    expect(orderIn(s, lone.orderId)?.state).not.toBe("abandoned");
    expect(step(s, 0).orderId).toBe(lone.orderId);
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("... its escrow unreadable: neither given up nor replaced — the step waits", async () => {
    const lone = order("0x" + "ee".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
    const s = await session([lone]);
    const calls: string[] = [];
    await tick(s, calls, NOW, { escrowBalance: async () => null });
    expect(orderIn(s, lone.orderId)?.state).toBe("committed");
    expect(step(s, 0)).toMatchObject({ state: "planned" });
    expect(calls).not.toContain("commit:0");
    s.lock();
  });

  it("... its escrow read empty with no job: given up before the step commits its own", async () => {
    const lone = order("0x" + "ee".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
    const s = await session([lone]);
    const calls: string[] = [];
    await tick(s, calls, NOW, { escrowBalance: async () => 0n });
    expect(orderIn(s, lone.orderId)?.state).toBe("abandoned");
    expect(calls).toContain("commit:0");
    s.lock();
  });

  it("an order its own route change gave up with its funding read dead is never taken up again: the step commits its own (no loop)", async () => {
    let c: Campaign = { ...campaign(), provider: "chainflip" };
    c = withTrancheState(c, 0, "committed", T0 + 2000, { orderId: X, provider: "thorchain" });
    const sent = order(X, { campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", at: T0 + 2500 } });
    const s = await session([sent], c);
    const calls: string[] = [];
    let now = NOW;
    for (let k = 0; k < 6; k++) {
      await tick(s, calls, now, { escrowBalance: async () => 0n, fundingFate: async () => "dead" } as never);
      now += 2000;
    }
    expect(orderIn(s, X)?.state).toBe("abandoned");
    expect(calls).toContain("commit:0");
    expect(step(s, 0).orderId, "never X again").not.toBe(X);
    s.lock();
  });

  it("an order of a later step waits for that step: this step commits its own", async () => {
    const s = await session([funded(X, { campaign: { id: CAMPAIGN, index: 2 } })]);
    const calls: string[] = [];
    await tick(s, calls);
    expect(calls).toContain("commit:0");
    expect(step(s, 2).orderId).toBeUndefined();
    s.lock();
  });

  it("an order another step already names is never taken up again for this one, whatever index it carries", async () => {
    const s = await session([funded(X, { campaign: { id: CAMPAIGN, index: 0 } })]);
    s.update((j) => {
      j.campaigns = [withTrancheState(j.campaigns![0], 1, "settled", T0 + 3000, { orderId: X })];
    });
    const calls: string[] = [];
    await tick(s, calls);
    expect(step(s, 0).orderId, "step 0 never takes step 1's order").toBeUndefined();
    expect(calls, "it commits its own").toContain("commit:0");
    s.lock();
  });
});

describe("the critique of 12e1 (YR): what the merge must also hold", () => {
  const rec = (id: string, state: string): OperationRecord =>
    ({
      id,
      kind: "swap",
      state,
      createdAt: 1,
      updatedAt: 2,
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      fees: [],
      destination: { kind: "fresh", display: "x", chain: "bitcoin" },
      refs: { txHashes: [] },
      fundsClass: "unknown",
    }) as unknown as OperationRecord;
  const one = (d: StoredSwap, b: StoredSwap): StoredSwap => merge(journal({ swaps: [d] }), journal({ swaps: [b] })).swaps[0];
  const sentAttempt = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 2500 };

  it("the device's funding facts come across when the backup's block is taken: no funding planned again (A11-1 in the other direction)", () => {
    const O = "0x" + "1a".repeat(32);
    const d = order(O, { fundingAttempt: sentAttempt, fundedTx: "0x" + "44".repeat(32), history: [{ state: "SOURCE_SUBMITTED", at: 5 }] });
    const b = order(O, {
      state: "executing",
      jobId: "job-3",
      history: [
        { state: "SOURCE_SUBMITTED", at: 5 },
        { state: "PROVIDER_EXECUTING", at: 9 },
      ],
    });
    const m = merge(journal({ swaps: [d], schedule: [{ id: `fund-escrow:${O}`, kind: "fund-escrow", orderId: O, dueAt: T0 }] }), journal({ swaps: [b] }));
    expect(m.swaps[0]).toMatchObject({ state: "executing", jobId: "job-3", fundedTx: d.fundedTx, fundingAttempt: sentAttempt });
    expect(m.schedule.some((a) => a.id === `fund-escrow:${O}`)).toBe(false);
  });

  it("an order given up after its funding was read dead stays given up, whichever copy is the device's", () => {
    const O = "0x" + "1b".repeat(32);
    const gaveUp = order(O, { state: "abandoned", fundingAttempt: sentAttempt });
    const open = order(O, { fundingAttempt: sentAttempt });
    expect(one(gaveUp, open).state).toBe("abandoned");
    expect(one(open, gaveUp).state).toBe("abandoned");
    // ... but a funding sent with other notes since (another attempt) is live: the order comes back open for it
    const later = order(O, { fundingAttempt: { nullifiers: ["7", "8"], by: "relayer", at: T0 + 9000 } });
    expect(one(gaveUp, later).state).toBe("committed");
  });

  it("an order one copy gave up while the other funded it: funded, with the funded copy's record — never the give-up's Cancelled", () => {
    const O = "0x" + "0a".repeat(32);
    const id = `swap:${O}`;
    const gaveUp = order(O, { state: "abandoned" });
    const paid = order(O, { state: "funded", fundedTx: "0x" + "11".repeat(32) });
    const m = merge(journal({ swaps: [gaveUp], operations: [rec(id, "CANCELLED")] }), journal({ swaps: [paid], operations: [rec(id, "SOURCE_CONFIRMING")] }));
    expect(m.swaps[0].state).toBe("funded");
    expect(m.operations?.find((r) => r.id === id)?.state).toBe("SOURCE_CONFIRMING");
    // with no record of the funded copy, none: the order's next sync writes one from the merged order
    const n = merge(journal({ swaps: [gaveUp], operations: [rec(id, "CANCELLED")] }), journal({ swaps: [paid] }));
    expect(n.operations?.find((r) => r.id === id)).toBeUndefined();
  });

  it("the record comes from the device's block when the device saw more: an older backup's open record never hides the device's Return funds", () => {
    const O = "0x" + "1c".repeat(32);
    const id = `swap:${O}`;
    const d = order(O, {
      state: "executed",
      history: [
        { state: "PROVIDER_EXECUTING", at: 5 },
        { state: "LATE_REFUND", at: 9 },
      ],
    });
    const b = order(O, { state: "executing", history: [{ state: "PROVIDER_EXECUTING", at: 5 }] });
    const m = merge(journal({ swaps: [d], operations: [rec(id, "RECOVERY_REQUIRED")] }), journal({ swaps: [b], operations: [rec(id, "MONITORING")] }));
    expect(m.operations?.find((r) => r.id === id)?.state).toBe("RECOVERY_REQUIRED");
  });

  it("two diverged copies: the later reading is the latest of a reading, a history entry or a pause — a runner's stop is kept", () => {
    const O = "0x" + "1d".repeat(32);
    const base = [{ state: "SOURCE_FINAL", at: 1 }];
    const byTrack = order(O, { state: "funded", history: [...base, { state: "A", at: 3 }], track: { state: "SOURCE_FINAL", label: "x", at: 20 } });
    const byHistory = order(O, { state: "executing", history: [...base, { state: "B", at: 10 }] });
    expect(one(byTrack, byHistory).state, "the reading at 20 beats the entry at 10").toBe("funded");
    const byPause = order(O, { state: "funded", history: [...base, { state: "A", at: 3 }], paused: { code: "minimum_moved", at: 30 } });
    expect(one(byHistory, byPause).paused?.code, "the pause at 30 beats the entry at 10").toBe("minimum_moved");
  });

  it("a descendant whose steps do not name a funded order of the campaign takes it up and pauses for a reconcile (a funding the other copy sent)", () => {
    // both held step 0 committed with X; B sent X's funding (its answer lost); A gave X up before funding, planned step 0 again, committed and funded Y
    const Y = "0x" + "1e".repeat(32);
    let a = withTrancheState(campaign(), 0, "committed", T0 + 2000, { orderId: X });
    const b = a;
    a = withTrancheState(a, 0, "planned", T0 + 3000, { orderId: undefined }, "the route changed");
    a = withTrancheState(a, 0, "committed", T0 + 4000, { orderId: Y });
    a = withTrancheState(a, 0, "funded", T0 + 4100);
    const m = merge(
      journal({ campaigns: [a], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } }), funded(Y)] }),
      journal({ campaigns: [b], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: sentAttempt })] }),
    );
    const c = m.campaigns![0];
    expect(m.swaps.find((o) => o.orderId === X)?.state, "the abandon yields to the funding sent").toBe("committed");
    expect(c.tranches.find((t) => t.orderId === X)).toMatchObject({ state: "committed" });
    expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: TAKEN_UP_DETAIL } });
    expect(mergedProblems(m)).toEqual([]);
  });

  it("a journal naming one order on two steps (an earlier merge's) comes back with one, the further along, and pauses for a reconcile", () => {
    const Z = "0x" + "5b".repeat(32);
    let twice = withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: X });
    twice = withTrancheState(twice, 0, "settled", T0 + 1100);
    twice = withTrancheState(twice, 1, "executing", T0 + 2000, { orderId: Z, jobId: "jz" });
    twice = withTrancheState(twice, 2, "committed", T0 + 3000, { orderId: Z });
    const swaps = [
      order(X, { state: "completed", jobId: "jx", campaign: { id: CAMPAIGN, index: 0 } }),
      order(Z, { state: "executing", jobId: "jz", campaign: { id: CAMPAIGN, index: 1 } }),
    ];
    const m = merge(journal({ campaigns: [twice], swaps }), journal({ campaigns: [twice], swaps }));
    const c = m.campaigns![0];
    expect(c.tranches.filter((t) => t.orderId === Z).map((t) => t.state)).toEqual(["executing"]);
    expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: ONE_ORDER_DETAIL } });
    expect(mergedProblems(m)).toEqual([]);
  });

  it("two diverged merges in a row never name one order twice (40 ETH of steps for a 30 ETH order)", () => {
    const S0 = "0x" + "50".repeat(32);
    const W = "0x" + "57".repeat(32);
    const Z = "0x" + "5a".repeat(32);
    let common = withTrancheState(campaign(), 0, "committed", T0 + 1100, { orderId: S0 });
    common = withTrancheState(common, 0, "settled", T0 + 1200);
    const D1 = withTrancheState(withTrancheState(common, 1, "committed", T0 + 2000, { orderId: W }), 1, "funded", T0 + 4000);
    const B1 = withTrancheState(common, 1, "committed", T0 + 3000, { orderId: Z });
    const s0 = order(S0, { state: "completed", fundedTx: "0x" + "01".repeat(32), jobId: "j0", campaign: { id: CAMPAIGN, index: 0 } });
    const w = funded(W, { campaign: { id: CAMPAIGN, index: 1 } });
    const zSent = order(Z, { fundingAttempt: { nullifiers: ["3", "4"], by: "relayer", at: T0 + 3050 }, campaign: { id: CAMPAIGN, index: 1 } });
    const M1 = mergeJournals(journal({ campaigns: [D1], swaps: [s0, w] }), journal({ campaigns: [B1], swaps: [s0, zSent] }), () => 0.5, T0 + 10_000);
    const M1r = withCampaignState(
      withCampaignState(M1.campaigns![0], "reassessing", T0 + 20_000, "resumed by you", { pause: undefined, decidedAt: T0 + 20_000 }),
      "running",
      T0 + 20_100,
      "requoted",
    );
    let B2 = withTrancheState(B1, 1, "funded", T0 + 12_000);
    B2 = withTrancheState(B2, 1, "executing", T0 + 14_000, { jobId: "jz", handedOverAt: T0 + 14_000 });
    const zHanded = order(Z, {
      state: "executing",
      fundedTx: "0x" + "03".repeat(32),
      jobId: "jz",
      handedOverAt: T0 + 14_000,
      fundingAttempt: zSent.fundingAttempt,
      campaign: { id: CAMPAIGN, index: 1 },
    });
    const M2 = mergeJournals(journal({ campaigns: [M1r], swaps: M1.swaps }), journal({ campaigns: [B2], swaps: [s0, zHanded] }), () => 0.5, T0 + 30_000);
    const c = M2.campaigns![0];
    expect(c.tranches.filter((t) => t.orderId === Z).length).toBe(1);
    expect(c.tranches.find((t) => t.orderId === Z)?.state, "the further along of the two").toBe("executing");
    expect(c.tranches.reduce((n, t) => n + BigInt(t.amount), 0n) <= 30n * ETH).toBe(true);
    expect(mergedProblems(M2)).toEqual([]);
  });

  describe("both copies ran it: which copy is the base, and what comes from the other", () => {
    const Y = "0x" + "cc".repeat(32);
    const common = stepThrough(campaign(), 0, ["funded"], T0 + 2000, X);

    it("a stop the later copy gave winds it down — Return the rest on the backup's copy, or a cancelled copy", () => {
      const dev = stepThrough(withTrancheState(common, 0, "executing", T0 + 4000), 1, [], T0 + 5000, Y);
      const swaps = [funded(X), order(Y, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: { nullifiers: ["9", "9"], by: "relayer", at: T0 + 5050 } })];
      const winding = withCampaignState(withTrancheState(common, 0, "executing", T0 + 4200), "winding-down", T0 + 6500, "cancelled by you", {
        decidedAt: T0 + 6500,
      });
      const m = merge(journal({ campaigns: [dev], swaps }), journal({ campaigns: [winding], swaps: [funded(X)] }));
      expect(m.campaigns![0].state).toBe("winding-down");
      expect(m.campaigns![0].tranches.some((t) => t.state === "planned" || t.state === "ready")).toBe(false);
      const cancelled = withCampaignState(winding, "cancelled", T0 + 6600);
      expect(
        merge(journal({ campaigns: [dev], swaps }), journal({ campaigns: [cancelled], swaps: [funded(X)] })).campaigns![0].state,
        "a step still open on the device: it returns",
      ).toBe("winding-down");
    });

    it("a stop with nothing taken up: the planned and ready steps skipped, nothing left but to complete; a cancelled base with nothing open stays cancelled", () => {
      const stoppedDev = withCampaignState(withTrancheState(common, 0, "executing", T0 + 4000), "winding-down", T0 + 5500, "cancelled by you", {
        decidedAt: T0 + 5500,
      });
      let bak = withTrancheState(withTrancheState(common, 0, "refunding", T0 + 4500), 0, "refunded", T0 + 6000, {
        outcome: { refunded: (10n * ETH).toString() },
      });
      bak = replanRemainder(bak, T0 + 6100, () => 0.9);
      bak = withTrancheState(bak, 1, "ready", T0 + 7000, { destination: "bc1qready" });
      const m = merge(
        journal({ campaigns: [stoppedDev], swaps: [funded(X, { state: "refunded" })] }),
        journal({ campaigns: [bak], swaps: [funded(X, { state: "refunded" })] }),
      );
      const c = m.campaigns![0];
      expect(c.state).toBe("winding-down");
      expect(c.tranches.some((t) => t.state === "planned" || t.state === "ready")).toBe(false);
      expect(nextAction(c, { now: NOW, pause: null, notesShaped: true }).kind).toBe("complete");
      // the stop's own entry is the device's; nothing false is written beside it
      expect(c.history.filter((h) => h.state === "winding-down").map((h) => h.note)).toEqual(["cancelled by you"]);
      const ended = withCampaignState(
        withTrancheState(stoppedDev, 0, "refunded", T0 + 9000, { outcome: { refunded: (10n * ETH).toString() } }),
        "cancelled",
        T0 + 9100,
      );
      expect(merge(journal({ campaigns: [ended] }), journal({ campaigns: [bak] })).campaigns![0].state).toBe("cancelled");
    });

    it("a terminal step on the copy that is not the base stays terminal (a refund the base did not see)", () => {
      const dev = withTrancheState(withTrancheState(common, 0, "refunding", T0 + 4500), 0, "refunded", T0 + 6000, {
        outcome: { refunded: (10n * ETH).toString() },
      });
      const bak = stepThrough(withTrancheState(common, 0, "executing", T0 + 4000), 1, [], T0 + 7000, Y);
      const m = merge(
        journal({ campaigns: [dev], swaps: [funded(X, { state: "refunded" })] }),
        journal({ campaigns: [bak], swaps: [funded(X), order(Y, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: sentAttempt })] }),
      );
      expect(m.campaigns![0].tranches[0].state).toBe("refunded");
    });

    it("a step taken up from the other copy keeps that copy's own step — funded, with its expected minimum", () => {
      const expected = { minOut: "123", rateE18: "456", etaSeconds: 600 };
      const dev = withTrancheState(stepThrough(withTrancheState(common, 0, "executing", T0 + 4000), 1, ["funded"], T0 + 5000, Y), 1, "funded", T0 + 5200, {
        expected,
      });
      const bak = replanRemainder(
        withTrancheState(withTrancheState(common, 0, "refunding", T0 + 4500), 0, "refunded", T0 + 6000, { outcome: { refunded: (10n * ETH).toString() } }),
        T0 + 6100,
        () => 0.9,
      );
      const m = merge(
        journal({ campaigns: [dev], swaps: [funded(X), funded(Y, { campaign: { id: CAMPAIGN, index: 1 } })] }),
        journal({ campaigns: [bak], swaps: [funded(X, { state: "refunded" })] }),
      );
      expect(m.campaigns![0].tranches.find((t) => t.orderId === Y)).toMatchObject({ state: "funded", expected });
    });

    it("the device later: its copy is the base (its route kept); both copies' history; another campaign's order never taken up here", () => {
      const other = "0x" + "a0".repeat(32);
      const second = { ...campaign(), id: "camp-other", tranches: [{ ...campaign().tranches[0], state: "funded" as const, orderId: other }] };
      const dev = {
        ...stepThrough(
          withCampaignState(withCampaignState(withTrancheState(common, 0, "executing", T0 + 4000), "rerouting", T0 + 7900), "running", T0 + 8000, "rerouted"),
          1,
          [],
          T0 + 9000,
          Y,
        ),
        provider: "chainflip",
      };
      const bak = withCampaignState(withTrancheState(common, 0, "refunding", T0 + 4500), "paused", T0 + 4600, "a note only the backup holds");
      const swaps = [
        funded(X),
        order(Y, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: sentAttempt }),
        funded(other, { campaign: { id: "camp-other", index: 0 } }),
      ];
      const m = merge(journal({ campaigns: [dev, second], swaps }), journal({ campaigns: [bak, second] }));
      const c = m.campaigns!.find((x) => x.id === CAMPAIGN)!;
      expect(c.provider).toBe("chainflip");
      expect(c.history.map((h) => h.note)).toEqual(expect.arrayContaining(["rerouted", "a note only the backup holds"]));
      expect(c.tranches.some((t) => t.orderId === other)).toBe(false);
      expect(mergedProblems(m)).toEqual([]);
    });
  });

  it("an order's tick stays while it is open and not a campaign's; a funded order loses only its funding action", () => {
    const paid = order("0x" + "1f".repeat(32), { state: "funded", fundedTx: "0x" + "33".repeat(32) });
    const gone = order("0x" + "2f".repeat(32), { state: "abandoned" });
    const act = (kind: ScheduledAction["kind"], o: StoredSwap): ScheduledAction => ({ id: `${kind}:${o.orderId}`, kind, orderId: o.orderId, dueAt: T0 });
    const m = merge(
      journal({ swaps: [paid, gone], schedule: [act("fund-escrow", paid), act("order-tick", paid), act("fund-escrow", gone), act("order-tick", gone)] }),
      journal({}),
    );
    expect(m.schedule.map((a) => a.id)).toEqual([`order-tick:${paid.orderId}`]);
  });

  it("an address-book entry this device is ahead on keeps its stage and every use of both copies", () => {
    const fresh = addEntry({ id: "bitcoin:bc1qa", chain: "bitcoin", address: "bc1qa", normalized: "bc1qa", source: "fresh", now: T0 });
    const m = merge(
      journal({ addressBook: [markUsed(fresh, "op-a", T0 + 10)] }),
      journal({ addressBook: [{ ...fresh, lifecycle: "verified" as const, usedBy: ["op-b"], lastUsedAt: T0 + 5 }] }),
    ).addressBook![0];
    expect(m.lifecycle).toBe("used");
    expect([...m.usedBy].sort()).toEqual(["op-a", "op-b"]);
    expect(m.lastUsedAt).toBe(T0 + 10);
  });

  it("the invariant oracle sees what it is there for: a misplaced index, an order named twice in one campaign or in two, a funded order named by none", () => {
    const c = campaign();
    const bad: JournalData = journal({
      campaigns: [
        {
          ...c,
          tranches: [
            { ...c.tranches[0], orderId: X },
            { ...c.tranches[1], orderId: X },
            { ...c.tranches[2], index: 7 },
          ],
        },
        { ...c, id: "camp-b", tranches: [{ ...c.tranches[0], orderId: X }] },
      ],
      swaps: [funded("0x" + "99".repeat(32))],
    });
    const p = mergedProblems(bad);
    expect(p.some((x) => x.includes("carries index 7"))).toBe(true);
    expect(p.some((x) => x.includes("named by two steps"))).toBe(true);
    expect(p.some((x) => x.includes("and by camp-b"))).toBe(true);
    expect(p.some((x) => x.includes("named by no step"))).toBe(true);
  });
});

describe("the critique of 12e1 (YS): steps given up beside a funding, the attempt's key, ended campaigns, records", () => {
  const rec = (id: string, state: string): OperationRecord =>
    ({
      id,
      kind: id.startsWith("swap:") ? "swap" : "send",
      state,
      createdAt: 1,
      updatedAt: 2,
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      fees: [],
      destination: { kind: "fresh", display: "x", chain: "bitcoin" },
      refs: { txHashes: [] },
      fundsClass: "unknown",
    }) as unknown as OperationRecord;
  const sent = { nullifiers: ["7", "8"] as [string, string], by: "relayer" as const, at: T0 + 4000 };

  describe("a Return the rest on one copy, a funding sent or seen on the other", () => {
    const common = withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X, provider: "thorchain" });
    // A sent X's funding after its backup went to B (its answer lost: no step entry); B's Return the rest read X's escrow empty and gave it up
    const a = withCampaignState(common, "paused", T0 + 5000, "funding sent, not confirmed", {
      pause: { reason: "reconcile", detail: "x", at: T0 + 5000 } as never,
    });
    let b = withCampaignState(common, "winding-down", T0 + 6000, "cancelled by you: the rest returns to the private balance", { decidedAt: T0 + 6000 });
    for (const i of [1, 2]) b = withTrancheState(b, i, "skipped", T0 + 6000, {}, "cancelled before it started");
    b = withTrancheState(b, 0, "skipped", T0 + 6100, {}, "never funded: given up while the rest returned");
    const onA = journal({ campaigns: [a], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: sent })] });
    const onB = journal({ campaigns: [b], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] });

    for (const [name, d, k] of [
      ["restored on A", onA, onB],
      ["restored on B", onB, onA],
    ] as const)
      it(`${name}: the order stays open for its funding and its step comes back, followed — the campaign winds down with it`, () => {
        const m = merge(d, k);
        const c = m.campaigns![0];
        expect(m.swaps.find((o) => o.orderId === X)).toMatchObject({ state: "committed", fundingAttempt: sent });
        expect(c.tranches.find((t) => t.orderId === X)?.state).toBe("committed");
        expect(c.state).toBe("winding-down");
        expect(nextAction(c, { now: NOW, pause: null, notesShaped: true }).kind, "never complete with the funding unfollowed").not.toBe("complete");
        expect(mergedProblems(m)).toEqual([]);
      });

    it("the other copy funded and handed it over while this one skipped it: the step comes back executing with its job", () => {
      const handed = withTrancheState(withTrancheState(common, 0, "funded", T0 + 4000), 0, "executing", T0 + 4500, { jobId: "jx", handedOverAt: T0 + 4500 });
      const m = merge(
        journal({ campaigns: [b], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] }),
        journal({
          campaigns: [handed],
          swaps: [
            order(X, { state: "executing", fundedTx: "0x" + "61".repeat(32), jobId: "jx", handedOverAt: T0 + 4500, campaign: { id: CAMPAIGN, index: 0 } }),
          ],
        }),
      );
      expect(m.campaigns![0].tranches.find((t) => t.orderId === X)).toMatchObject({ state: "executing", jobId: "jx" });
      expect(mergedProblems(m)).toEqual([]);
    });
  });

  it("a funding sent again over the same unspent notes is live, whichever copy read the first one dead: the order open, its tick kept", () => {
    const O = "0x" + "b1".repeat(32);
    const dead = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 2500 };
    const again = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 2 * 3_600_000 };
    const tickOf = { id: `order-tick:${O}`, kind: "order-tick" as const, orderId: O, dueAt: T0 };
    const m = merge(
      journal({ swaps: [order(O, { fundingAttempt: again })], schedule: [tickOf] }),
      journal({ swaps: [order(O, { state: "abandoned", fundingAttempt: dead })] }),
    );
    expect(m.swaps[0]).toMatchObject({ state: "committed", fundingAttempt: again });
    expect(m.schedule.map((x) => x.id)).toContain(tickOf.id);
    const n = merge(journal({ swaps: [order(O, { state: "abandoned", fundingAttempt: dead })] }), journal({ swaps: [order(O, { fundingAttempt: again })] }));
    expect(n.swaps[0]).toMatchObject({ state: "committed", fundingAttempt: again });
  });

  describe("an orphan no copy's step names (a journal an older build merged)", () => {
    const X0 = "0x" + "a0".repeat(32);
    const X1 = "0x" + "a1".repeat(32);
    const dev = withTrancheState(withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X0 }), 0, "settled", T0 + 1600);
    const older = withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X0 });
    const x0 = order(X0, { state: "completed", fundedTx: "0x" + "01".repeat(32), jobId: "j0", campaign: { id: CAMPAIGN, index: 0 } });
    const own = { provider: "chainflip", request: { amount: (10n * ETH).toString(), destination: "bc1qorphandestination0000000000000000000" } };

    it("a funded one: its own size, funded, its provider and destination; no piece planned beside it", () => {
      const x1 = order(X1, { ...own, state: "funded", fundedTx: "0x" + "02".repeat(32), campaign: { id: CAMPAIGN, index: 1 } });
      const m = merge(journal({ campaigns: [dev], swaps: [x0, x1] }), journal({ campaigns: [older], swaps: [x0] }));
      const c = m.campaigns![0];
      expect(c.tranches.find((t) => t.orderId === X1)).toMatchObject({
        index: 1,
        state: "funded",
        amount: (10n * ETH).toString(),
        provider: "chainflip",
        destination: own.request.destination,
      });
      expect(c.tranches.filter((t) => t.state === "planned")).toEqual([]);
      expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: TAKEN_UP_DETAIL } });
      expect(mergedProblems(m)).toEqual([]);
    });

    it("a handed-over one: executing, with its job and its hand-over time", () => {
      const x1 = order(X1, {
        ...own,
        state: "executing",
        fundedTx: "0x" + "02".repeat(32),
        jobId: "j1",
        handedOverAt: T0 + 3000,
        campaign: { id: CAMPAIGN, index: 1 },
      });
      const m = merge(journal({ campaigns: [dev], swaps: [x0, x1] }), journal({ campaigns: [older], swaps: [x0] }));
      expect(m.campaigns![0].tranches.find((t) => t.orderId === X1)).toMatchObject({ state: "executing", jobId: "j1", handedOverAt: T0 + 3000 });
    });

    it("an open one with nothing funded is given up, and no step names it", () => {
      const x1 = order(X1, { ...own, campaign: { id: CAMPAIGN, index: 1 } });
      const m = merge(journal({ campaigns: [dev], swaps: [x0, x1] }), journal({ campaigns: [older], swaps: [x0] }));
      expect(m.swaps.find((o) => o.orderId === X1)?.state).toBe("abandoned");
      expect(m.campaigns![0].tranches.some((t) => t.orderId === X1)).toBe(false);
    });
  });

  describe("a campaign both copies finished stays finished", () => {
    let done = withTrancheState(withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: X }), 0, "settled", T0 + 2000);
    for (const i of [1, 2])
      done = withTrancheState(withTrancheState(done, i, "committed", T0 + 3000 + i, { orderId: "0x" + `0${i}`.repeat(32) }), i, "settled", T0 + 4000 + i);
    const at = (c: Campaign, last: number) => withCampaignState(withTrancheState(c, 2, "settled", last), "completed", last + 1);
    const swaps = [X, "0x" + "01".repeat(32), "0x" + "02".repeat(32)].map((id, index) =>
      order(id, { state: "completed", jobId: "j", campaign: { id: CAMPAIGN, index } }),
    );

    it("each read the last step settled at its own time: completed, no pause, no tick", () => {
      const a = at(
        { ...done, tranches: done.tranches.map((t) => (t.index === 2 ? { ...t, state: "executing" as const, history: t.history.slice(0, -1) } : t)) },
        T0 + 9000,
      );
      const b = at(
        { ...done, tranches: done.tranches.map((t) => (t.index === 2 ? { ...t, state: "executing" as const, history: t.history.slice(0, -1) } : t)) },
        T0 + 9400,
      );
      const m = merge(journal({ campaigns: [a], swaps }), journal({ campaigns: [b], swaps }));
      expect(m.campaigns![0].state).toBe("completed");
      expect(m.campaigns![0].pause).toBeUndefined();
      expect(m.schedule.some((x) => x.orderId === CAMPAIGN)).toBe(false);
    });

    it("one copy completed, the other winding down with nothing open: completed", () => {
      const a = withCampaignState(done, "completed", T0 + 9000);
      const b = withCampaignState(withTrancheState(done, 2, "settled", T0 + 8800, {}, "read again"), "winding-down", T0 + 8900, "cancelled by you", {
        decidedAt: T0 + 8900,
      });
      expect(merge(journal({ campaigns: [a], swaps }), journal({ campaigns: [b], swaps })).campaigns![0].state).toBe("completed");
    });
  });

  describe("operation records", () => {
    it("this device's open record over the backup's Failed or Cancelled (concluded from less: a Send it never saw sent)", () => {
      const id = "send:1";
      expect(merge(journal({ operations: [rec(id, "SUBMITTED")] }), journal({ operations: [rec(id, "FAILED")] })).operations![0].state).toBe("SUBMITTED");
      expect(merge(journal({ operations: [rec(id, "SUBMITTED")] }), journal({ operations: [rec(id, "CANCELLED")] })).operations![0].state).toBe("SUBMITTED");
      expect(
        merge(journal({ operations: [rec(id, "SUBMITTED")] }), journal({ operations: [rec(id, "REFUNDED")] })).operations![0].state,
        "a success it did not see",
      ).toBe("REFUNDED");
      expect(
        merge(journal({ operations: [rec(id, "FAILED")] }), journal({ operations: [rec(id, "COMPLETED")] })).operations![0].state,
        "a Failed here concluded from less (read interrupted) never stands over the payment's completion",
      ).toBe("COMPLETED");
      expect(
        merge(journal({ operations: [rec(id, "REFUNDED")] }), journal({ operations: [rec(id, "COMPLETED")] })).operations![0].state,
        "the device's own success stays",
      ).toBe("REFUNDED");
    });

    it("an order's record follows the copy its state came from — never the other's ended one over it", () => {
      const O = "0x" + "1c".repeat(32);
      const id = `swap:${O}`;
      const d = order(O, {
        state: "executing",
        history: [
          { state: "PROVIDER_EXECUTING", at: 5 },
          { state: "DESTINATION_SUBMITTED", at: 9 },
        ],
      });
      const b = order(O, { state: "executing", history: [{ state: "PROVIDER_EXECUTING", at: 5 }] });
      expect(
        merge(journal({ swaps: [d], operations: [rec(id, "MONITORING")] }), journal({ swaps: [b], operations: [rec(id, "FAILED")] })).operations![0].state,
      ).toBe("MONITORING");
    });

    it("an abandon that stands keeps its Cancelled record, whichever copy is the device's", () => {
      const O = "0x" + "1d".repeat(32);
      const id = `swap:${O}`;
      const gone = journal({ swaps: [order(O, { state: "abandoned" })], operations: [rec(id, "CANCELLED")] });
      const open = journal({ swaps: [order(O)], operations: [rec(id, "AWAITING_FUNDING")] });
      expect(merge(gone, open).operations![0].state).toBe("CANCELLED");
      expect(merge(open, gone).operations![0].state).toBe("CANCELLED");
    });
  });

  it("the runner takes a refund-only job's order up returning", async () => {
    const disk = memoryStorage();
    configure(defaultConfig({ storage: () => disk, kdfLog2N: 12 }));
    const s = new WalletSession(disk, KDF);
    await s.create("pw", new Uint8Array(32).fill(79));
    s.acknowledgePhrase();
    const lone = order("0x" + "e1".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
    s.update((j) => {
      j.campaigns = [campaign()];
      j.swaps = [lone];
    });
    await tick(s, [], NOW, { job: async () => ({ id: "job-r", state: "refund-only" }) as never });
    expect(s.journal().campaigns![0].tranches[0]).toMatchObject({ state: "refunding", orderId: lone.orderId, jobId: "job-r" });
    s.lock();
  });

  describe("the step a diverged merge keeps", () => {
    const common = campaign();

    it("the copy whose step history holds the other's wins, even when its step ranks lower (planned again after a give-up)", () => {
      const W = "0x" + "d1".repeat(32);
      const older = withTrancheState(common, 1, "committed", T0 + 2000, { orderId: W });
      const later = withCampaignState(withTrancheState(older, 1, "planned", T0 + 3000, { orderId: undefined }, "the route changed"), "paused", T0 + 3100, "x");
      const otherSide = withCampaignState(older, "reassessing", T0 + 2500, "y");
      const m = merge(
        journal({ campaigns: [later], swaps: [order(W, { state: "abandoned", campaign: { id: CAMPAIGN, index: 1 } })] }),
        journal({ campaigns: [otherSide], swaps: [order(W, { state: "abandoned", campaign: { id: CAMPAIGN, index: 1 } })] }),
      );
      expect(m.campaigns![0].tranches[1].orderId, "never the abandoned order's step").toBeUndefined();
    });

    it("of two steps naming one order, the further along stays — wherever it sits", () => {
      const Z = "0x" + "d2".repeat(32);
      let twice = withTrancheState(campaign(), 1, "committed", T0 + 2000, { orderId: Z });
      twice = withTrancheState(twice, 2, "executing", T0 + 3000, { orderId: Z, jobId: "jz" });
      const swaps = [order(Z, { state: "executing", jobId: "jz", campaign: { id: CAMPAIGN, index: 2 } })];
      const m = merge(journal({ campaigns: [twice], swaps }), journal({ campaigns: [twice], swaps }));
      expect(m.campaigns![0].tranches.filter((t) => t.orderId === Z).map((t) => t.state)).toEqual(["executing"]);
      expect(m.swaps[0].campaign?.index, "its order's step index follows").toBe(m.campaigns![0].tranches.find((t) => t.orderId === Z)!.index);
      expect(mergedProblems(m), "every step at its own position").toEqual([]);
    });
  });
});

describe("the critique of 12e1 (YS), pass 3's mutants: what each rule decides", () => {
  const common = withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X, provider: "thorchain" });

  it("a step given up with nothing funded stays given up: no step comes back, nothing changes", () => {
    let b = withCampaignState(common, "winding-down", T0 + 6000, "cancelled by you", { decidedAt: T0 + 6000 });
    for (const i of [0, 1, 2]) b = withTrancheState(b, i, "skipped", T0 + 6000 + i, {}, "given up");
    const gone = journal({ campaigns: [b], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] });
    const m = merge(gone, journal({ campaigns: [common], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 0 } })] }));
    expect(m.campaigns![0]).toEqual(b);
    expect(m.swaps[0].state).toBe("abandoned");
    // the steps given up naming the order given up are no problem (the oracle counts only a live step naming one)
    expect(mergedProblems(m)).toEqual([]);
  });

  it("a step one copy closed unfunded (its order expired there) while the other funded it comes back, the campaign paused with the take-up's words", () => {
    // B (descends): step 0 expired before its funding was seen — skipped; A funded it before its deadline (no step entry on A's side yet)
    const b = withTrancheState(common, 0, "skipped", T0 + 9000, {}, "the order expired before it was funded");
    const m = merge(
      journal({ campaigns: [common], swaps: [order(X, { state: "funded", fundedTx: "0x" + "71".repeat(32), campaign: { id: CAMPAIGN, index: 0 } })] }),
      journal({ campaigns: [b], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] }),
    );
    const c = m.campaigns![0];
    expect(c.tranches[0]).toMatchObject({ orderId: X, state: "committed" });
    expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: TAKEN_UP_DETAIL } });
    expect(mergedProblems(m)).toEqual([]);
  });

  describe("a campaign ended on a copy, nothing left to run", () => {
    // step 0 settled on both; A then pressed Return the rest (steps 1–2 skipped, cancelled); B, diverged, read step 0 again later
    let a = withTrancheState(common, 0, "settled", T0 + 2000);
    a = withCampaignState(a, "winding-down", T0 + 3000, "cancelled by you", { decidedAt: T0 + 3000 });
    for (const i of [1, 2]) a = withTrancheState(a, i, "skipped", T0 + 3000, {}, "cancelled before it started");
    a = withCampaignState(a, "cancelled", T0 + 3100);
    const b = withCampaignState(withTrancheState(common, 0, "settled", T0 + 2000), "paused", T0 + 3500, "a note of B's");
    const swaps = [order(X, { state: "completed", jobId: "j", campaign: { id: CAMPAIGN, index: 0 } })];

    it("cancelled before the order was swapped in full: it stays cancelled", () => {
      const m = merge(journal({ campaigns: [a], swaps }), journal({ campaigns: [{ ...b, tranches: a.tranches }], swaps }));
      expect(m.campaigns![0].state).toBe("cancelled");
    });

    it("cancelled once every step had settled (swapped in full): completed", () => {
      let full = a;
      for (const i of [1, 2])
        full = {
          ...full,
          tranches: full.tranches.map((t) => (t.index === i ? { ...t, state: "settled" as const, orderId: "0x" + `${i}${i}`.repeat(32) } : t)),
        };
      const m = merge(journal({ campaigns: [full], swaps }), journal({ campaigns: [{ ...b, tranches: full.tranches }], swaps }));
      expect(m.campaigns![0].state).toBe("completed");
    });
  });

  it("both copies ran it, nothing live and nothing left, neither ended it: the base's own state, and the next tick completes it", () => {
    const done = (c: Campaign): Campaign => ({
      ...c,
      tranches: c.tranches.map((t) => (t.index === 0 ? t : { ...t, state: "skipped" as const, outcome: { kept: true } })),
    });
    const a = withCampaignState(withTrancheState(common, 0, "settled", T0 + 2000), "paused", T0 + 2100, "x", {
      pause: { reason: "user", detail: "Paused by you.", at: T0 + 2100 } as never,
    });
    const b = withCampaignState(
      withCampaignState(withTrancheState(common, 0, "settled", T0 + 2000), "reassessing", T0 + 2200, "resumed by you"),
      "running",
      T0 + 2300,
      "requoted",
    );
    const m = merge(journal({ campaigns: [done(a)] }), journal({ campaigns: [done(b)] }));
    const c = m.campaigns![0];
    expect(c.state).toBe("running");
    expect(nextAction(c, { now: NOW, pause: null, notesShaped: true }).kind).toBe("complete");
  });

  it("nothing live but something left to swap, the base not started (A → B → A, A shaping its notes): paused for a reconcile, never completed", () => {
    // B ran all three steps: 0 settled, 1 refunded in full, 2 settled; A, reopened, entered preparing-notes later than every event of B
    let b = withTrancheState(common, 0, "settled", T0 + 2000);
    b = withTrancheState(withTrancheState(b, 1, "committed", T0 + 3000, { orderId: "0x" + "b1".repeat(32) }), 1, "refunded", T0 + 4000, {
      outcome: { refunded: (10n * ETH).toString() },
    });
    b = withTrancheState(withTrancheState(b, 2, "committed", T0 + 5000, { orderId: "0x" + "b2".repeat(32) }), 2, "settled", T0 + 6000);
    b = withCampaignState(b, "paused", T0 + 6100, "part came back", { pause: { reason: "bounds", detail: "x", at: T0 + 6100 } as never });
    const a = withCampaignState(
      createCampaign({
        id: CAMPAIGN,
        now: T0,
        mode: "balanced",
        tier: "high-value",
        request: campaign().request,
        bounds: bounds(30n * ETH),
        plan,
        pieces: [10n * ETH, 10n * ETH, 10n * ETH],
        referenceRateE18: rateE18(24_000_000n, 800n * ETH),
      }),
      "preparing-notes",
      T0 + 9000,
      "shaping the notes for the pieces",
    );
    const m = merge(journal({ campaigns: [a] }), journal({ campaigns: [b] }));
    const c = m.campaigns![0];
    expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile" } });
    expect(exposure(c).remaining, "still to come").toBe(10n * ETH);
  });

  it("both copies ran it with only a ready step left: that step is live — paused for a reconcile", () => {
    const a = withCampaignState(
      withTrancheState(withTrancheState(common, 0, "settled", T0 + 2000), 1, "ready", T0 + 2500, { destination: "bc1qready" }),
      "paused",
      T0 + 2600,
      "x",
    );
    const b = withCampaignState(withTrancheState(common, 0, "settled", T0 + 2000), "rerouting", T0 + 2200, "y");
    const only = (c: Campaign): Campaign => ({ ...c, tranches: c.tranches.filter((t) => t.index < 2) });
    const m = merge(journal({ campaigns: [only(a)] }), journal({ campaigns: [only(b)] }));
    expect(m.campaigns![0]).toMatchObject({ state: "paused", pause: { reason: "reconcile" } });
  });

  it("the oracle sees a funded order named only by a step given up", () => {
    const c = campaign();
    const bad = journal({
      campaigns: [{ ...c, tranches: [{ ...c.tranches[0], state: "skipped", orderId: X }, c.tranches[1], c.tranches[2]] }],
      swaps: [funded(X)],
    });
    expect(mergedProblems(bad).some((x) => x.includes("named only by a step given up"))).toBe(true);
  });
});

describe("the critique of 12e1 (YT): the ended rule from either side, the take-up's plan, dead attempts that outlive their give-up", () => {
  const rec = (id: string, state: string): OperationRecord =>
    ({
      id,
      kind: "swap",
      state,
      createdAt: 1,
      updatedAt: 2,
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      fees: [],
      destination: { kind: "fresh", display: "x", chain: "bitcoin" },
      refs: { txHashes: [] },
      fundsClass: "unknown",
    }) as unknown as OperationRecord;
  const sentA = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 2500 };
  const ids = ["0x" + "f0".repeat(32), "0x" + "f1".repeat(32), "0x" + "f2".repeat(32)];
  /** steps 0 and 1 settled, step 2 executing */
  function settledTwo(): Campaign {
    let c = campaign();
    for (const i of [0, 1])
      c = withTrancheState(withTrancheState(c, i, "committed", T0 + 1000 + i * 100, { orderId: ids[i] }), i, "settled", T0 + 1050 + i * 100);
    return withTrancheState(withTrancheState(c, 2, "committed", T0 + 1300, { orderId: ids[2] }), 2, "executing", T0 + 1400, { jobId: "j2" });
  }
  const doneSwaps = ids.map((id, index) => order(id, { state: "completed", jobId: "j", campaign: { id: CAMPAIGN, index } }));

  it("the backup's copy completed, this device later paused by the user with every step settled: completed, no pause, no tick", () => {
    const a = withTrancheState(
      withCampaignState(settledTwo(), "paused", T0 + 9300, "paused by you", {
        pause: { reason: "user", detail: "Paused by you.", at: T0 + 9300 } as never,
        decidedAt: T0 + 9300,
      }),
      2,
      "settled",
      T0 + 9400,
    );
    const b = withCampaignState(withTrancheState(settledTwo(), 2, "settled", T0 + 9000), "completed", T0 + 9001);
    const m = merge(journal({ campaigns: [a], swaps: doneSwaps }), journal({ campaigns: [b], swaps: doneSwaps }));
    expect(m.campaigns![0].state).toBe("completed");
    expect(m.campaigns![0].pause).toBeUndefined();
    expect(m.schedule.some((x) => x.orderId === CAMPAIGN)).toBe(false);
  });

  it("the backup's copy returned the rest (cancelled), this device later paused: cancelled, never completed", () => {
    const common = withTrancheState(withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X }), 0, "settled", T0 + 2000);
    let b = withCampaignState(common, "winding-down", T0 + 3000, "cancelled by you", { decidedAt: T0 + 3000 });
    for (const i of [1, 2]) b = withTrancheState(b, i, "skipped", T0 + 3000, {}, "cancelled before it started");
    b = withCampaignState(b, "cancelled", T0 + 3100);
    const a = withCampaignState({ ...common, tranches: b.tranches }, "paused", T0 + 3500, "paused by you", {
      pause: { reason: "user", detail: "Paused by you.", at: T0 + 3500 } as never,
      decidedAt: T0 + 3500,
    });
    const swaps = [order(X, { state: "completed", jobId: "j", campaign: { id: CAMPAIGN, index: 0 } })];
    expect(merge(journal({ campaigns: [a], swaps }), journal({ campaigns: [b], swaps })).campaigns![0].state).toBe("cancelled");
  });

  describe("the runner's take-up and the plan around it", () => {
    async function session(swaps: StoredSwap[], c: Campaign): Promise<WalletSession> {
      const disk = memoryStorage();
      configure(defaultConfig({ storage: () => disk, kdfLog2N: 12 }));
      const s = new WalletSession(disk, KDF);
      await s.create("pw", new Uint8Array(32).fill(80));
      s.acknowledgePhrase();
      s.update((j) => {
        j.campaigns = [c];
        j.swaps = swaps;
      });
      return s;
    }

    it("a funded orphan larger than its step (the rest re-planned 5 + 5 here): the stale planned step goes — never 35 ETH of steps for 30", async () => {
      let c = campaign();
      for (const i of [0, 1])
        c = withTrancheState(withTrancheState(c, i, "committed", T0 + 1000 + i * 200, { orderId: ids[i] }), i, "settled", T0 + 1100 + i * 200);
      const piece = (index: number): Tranche => ({
        index,
        amount: (5n * ETH).toString(),
        state: "planned",
        attempt: 0,
        history: [{ state: "planned", at: T0 + 1400, note: "re-planned" }],
      });
      c = { ...c, tranches: [c.tranches[0], c.tranches[1], piece(2), piece(3)] };
      const s = await session([funded(ids[2], { campaign: { id: CAMPAIGN, index: 2 } })], c);
      await tick(s, []);
      const after = s.journal().campaigns![0];
      expect(after.tranches.find((t) => t.orderId === ids[2])).toMatchObject({ state: "funded", amount: (10n * ETH).toString() });
      expect(after.tranches.reduce((n, t) => n + BigInt(t.amount), 0n)).toBe(30n * ETH);
      expect(after.tranches.filter((t) => t.state === "planned")).toEqual([]);
      s.lock();
    });

    it("an orphan of the step's own size keeps the plan: the planned steps stay as they were", async () => {
      const s = await session([funded(X)], campaign());
      const before = s.journal().campaigns![0].tranches.slice(1);
      await tick(s, []);
      const after = s.journal().campaigns![0];
      expect(after.tranches[0]).toMatchObject({ state: "funded", orderId: X });
      expect(after.tranches.slice(1)).toEqual(before);
      s.lock();
    });

    it("an escrow holding dust only (below the floor a step's own refund is counted by) is read as empty: given up, the step committed afresh", async () => {
      const lone = order("0x" + "e3".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
      const s = await session([lone], campaign());
      const calls: string[] = [];
      await tick(s, calls, NOW, { escrowBalance: async () => 1n });
      expect(s.journal().swaps.find((x) => x.orderId === lone.orderId)?.state).toBe("abandoned");
      expect(calls).toContain("commit:0");
      s.lock();
    });

    it("an escrow holding part of the order (a refund less its fees) is money at its escrow: taken up as a step that failed — its pause says where the money waits, a Return the rest returns it", async () => {
      const lone = order("0x" + "e2".repeat(32), { campaign: { id: CAMPAIGN, index: 0 } });
      const s = await session([lone], campaign());
      const calls: string[] = [];
      // its job sits at a relayer this device does not ask: the step's reads fail, and it stays where it is (I3)
      const io = {
        escrowBalance: async () => (96n * ETH) / 10n,
        track: async () => Promise.reject(new Error("not readable here")),
        refund: async () => ({ id: "j-back", state: "refund-only" }) as never,
      };
      await tick(s, calls, NOW, io);
      expect(s.journal().swaps.find((x) => x.orderId === lone.orderId)?.state, "never given up").toBe("committed");
      expect(s.journal().campaigns![0].tranches[0]).toMatchObject({ state: "failed", orderId: lone.orderId });
      expect(calls).not.toContain("commit:0");
      await tick(s, calls, NOW + 1000, io);
      expect(s.journal().campaigns![0]).toMatchObject({ state: "paused", pause: { reason: "provider-error" } });
      cancelCampaign(CAMPAIGN, s, NOW + 2000);
      await tick(s, calls, NOW + 3000, io);
      expect(s.journal().campaigns![0].tranches[0], "returned through its own refund-only job").toMatchObject({ state: "refunding", jobId: "j-back" });
      s.lock();
    });
  });

  it("an order's record where its block's copy holds none: the other copy's comes across", () => {
    const O = "0x" + "3c".repeat(32);
    const id = `swap:${O}`;
    const d = order(O, {
      state: "executing",
      history: [
        { state: "PROVIDER_EXECUTING", at: 5 },
        { state: "DESTINATION_SUBMITTED", at: 9 },
      ],
    });
    const b = order(O, { state: "executing", history: [{ state: "PROVIDER_EXECUTING", at: 5 }] });
    expect(merge(journal({ swaps: [d] }), journal({ swaps: [b], operations: [rec(id, "MONITORING")] })).operations?.find((r) => r.id === id)?.state).toBe(
      "MONITORING",
    );
  });

  it("the copy that gave the step's order up (planned again), not the base, still wins its step over the base's committed one — both directions", () => {
    const W = "0x" + "d1".repeat(32);
    const older = withTrancheState(campaign(), 1, "committed", T0 + 2000, { orderId: W });
    const gaveUp = withCampaignState(withTrancheState(older, 1, "planned", T0 + 3000, { orderId: undefined }, "the route changed"), "paused", T0 + 3100, "x");
    const resumedLater = withCampaignState(older, "reassessing", T0 + 4000, "resumed by you");
    const gone = [order(W, { state: "abandoned", campaign: { id: CAMPAIGN, index: 1 } })];
    for (const [d, b] of [
      [gaveUp, resumedLater],
      [resumedLater, gaveUp],
    ] as const) {
      const m = merge(journal({ campaigns: [d], swaps: gone }), journal({ campaigns: [b], swaps: gone }));
      expect(m.campaigns![0].tranches[1].orderId, "never the abandoned order's step").toBeUndefined();
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("the campaign's history equal on both, one copy gave the step's order up and planned it again: that copy descends — both directions", () => {
    const committed = withTrancheState(campaign(), 0, "committed", T0 + 2000, { orderId: X });
    const plannedAgain = withTrancheState(committed, 0, "planned", T0 + 3000, { orderId: undefined }, "the route changed before this step was funded");
    const onA = journal({ campaigns: [committed], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 0 } })] });
    const onB = journal({ campaigns: [plannedAgain], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] });
    for (const [d, b] of [
      [onA, onB],
      [onB, onA],
    ] as const) {
      const m = merge(d, b);
      expect(m.swaps[0].state).toBe("abandoned");
      expect(m.campaigns![0].tranches[0]).toMatchObject({ state: "planned" });
      expect(m.campaigns![0].tranches[0].orderId).toBeUndefined();
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("an order given up with its funding read dead never comes back through a merge: never taken up, its step left given up — both directions", () => {
    const older = { ...withTrancheState(campaign(), 0, "committed", T0 + 2000, { orderId: X, provider: "thorchain" }), provider: "chainflip" };
    const gaveUp = withTrancheState(
      older,
      0,
      "planned",
      T0 + 3000,
      { orderId: undefined, provider: undefined },
      "the route changed to chainflip before this step was funded",
    );
    const dead = order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: sentA });
    const open = order(X, { campaign: { id: CAMPAIGN, index: 0 }, fundingAttempt: sentA });
    for (const [d, b] of [
      [journal({ campaigns: [gaveUp], swaps: [dead] }), journal({ campaigns: [older], swaps: [open] })],
      [journal({ campaigns: [older], swaps: [open] }), journal({ campaigns: [gaveUp], swaps: [dead] })],
    ] as const) {
      const m = merge(d, b);
      expect(m.swaps[0].state).toBe("abandoned");
      expect(
        m.campaigns![0].tranches.some((t) => t.orderId === X),
        "never a step for the order given up",
      ).toBe(false);
    }
    // a Return the rest that gave X up over its dead attempt: the step stays given up
    let b = withCampaignState(withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X }), "winding-down", T0 + 6000, "cancelled by you", {
      decidedAt: T0 + 6000,
    });
    for (const i of [1, 2]) b = withTrancheState(b, i, "skipped", T0 + 6000, {}, "cancelled before it started");
    b = withTrancheState(b, 0, "skipped", T0 + 6100, {}, "never funded: given up while the rest returned");
    const onB = journal({ campaigns: [b], swaps: [dead] });
    const onA = journal({ campaigns: [withTrancheState(campaign(), 0, "committed", T0 + 1500, { orderId: X })], swaps: [open] });
    for (const [d, k] of [
      [onA, onB],
      [onB, onA],
    ] as const) {
      const m = merge(d, k);
      expect(m.swaps[0].state).toBe("abandoned");
      expect(m.campaigns![0].tranches[0].state).toBe("skipped");
    }
  });

  it("a dead attempt cleared before the order was given up (Fund now, then Abandon) still counts dead: an older backup holding it in flight changes nothing", () => {
    const O = "0x" + "4d".repeat(32);
    const gaveUp = order(O, { state: "abandoned", deadAttempts: [fundingAttemptKey(sentA)] });
    const older = order(O, { fundingAttempt: sentA });
    for (const [d, b] of [
      [gaveUp, older],
      [older, gaveUp],
    ] as const) {
      const m = merge(journal({ swaps: [d] }), journal({ swaps: [b] }));
      expect(m.swaps[0].state).toBe("abandoned");
      expect(m.swaps[0].deadAttempts).toEqual([fundingAttemptKey(sentA)]);
      expect(m.swaps[0].fundingAttempt, "the given-up copy held none: none taken from the other").toBeUndefined();
    }
    // ... and an open order here never takes the dead attempt back from the backup
    const reopened = order(O, { deadAttempts: [fundingAttemptKey(sentA)] });
    expect(merge(journal({ swaps: [reopened] }), journal({ swaps: [older] })).swaps[0].fundingAttempt).toBeUndefined();
  });

  it("the oracle sees a live step naming an order given up", () => {
    const c = campaign();
    const bad = journal({
      campaigns: [{ ...c, tranches: [{ ...c.tranches[0], state: "committed", orderId: X }, c.tranches[1], c.tranches[2]] }],
      swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })],
    });
    expect(mergedProblems(bad).some((x) => x.includes("given up"))).toBe(true);
  });
});

describe("pass 4's mutants of 12e1: the funding sent, and the dead attempts a merge keeps", () => {
  const O = "0x" + "5e".repeat(32);
  // k1 read dead; k2 sent again over the same unspent notes (a new time, so a new attempt)
  const k1 = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 2500 };
  const k2 = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 + 9000 };
  const both = (a: StoredSwap, b: StoredSwap) =>
    [
      [a, b],
      [b, a],
    ] as const;

  it("a copy that read the funding dead and sent a new one keeps the new one, whichever copy's block is taken: never lost to the dead one", () => {
    // B: k1 in flight (its transaction known: mined, and reverted). A: k1 read dead and cleared (its key kept), then Fund now sent k2 — never
    // with k1's transaction, whose reverted receipt would read k2 dead and fund the order again
    const onA = order(O, { fundingAttempt: k2, deadAttempts: [fundingAttemptKey(k1)] });
    const onB = order(O, { fundingAttempt: { ...k1, txHash: "0x" + "66".repeat(32) } });
    for (const [d, b] of both(onA, onB)) {
      const m = merge(journal({ swaps: [d] }), journal({ swaps: [b] }));
      expect(m.swaps[0].fundingAttempt, "the funding on its way: the runner waits on it and sends no third").toEqual(k2);
      expect(m.swaps[0].deadAttempts).toEqual([fundingAttemptKey(k1)]);
    }
  });

  it("an open order whose attempt the other copy read dead and cleared holds none after the merge, both directions (no wait on a dead attempt again)", () => {
    const cleared = order(O, { deadAttempts: [fundingAttemptKey(k1)] });
    const inFlight = order(O, { fundingAttempt: k1 });
    for (const [d, b] of both(cleared, inFlight)) {
      const m = merge(journal({ swaps: [d] }), journal({ swaps: [b] }));
      expect(m.swaps[0].state).toBe("committed");
      expect(m.swaps[0].fundingAttempt).toBeUndefined();
    }
  });

  it("an order given up over its dead funding keeps its own attempt, whichever copy is the device's: an older backup changes nothing it says", () => {
    const gaveUp = order(O, { state: "abandoned", fundingAttempt: k1 });
    for (const [d, b] of both(gaveUp, order(O, { fundingAttempt: k1 }))) {
      const m = merge(journal({ swaps: [d] }), journal({ swaps: [b] }));
      expect(m.swaps[0]).toMatchObject({ state: "abandoned", fundingAttempt: k1 });
    }
  });

  it("the attempt's transaction comes from either copy: a copy taken before the send was journaled holds the attempt without it", () => {
    const sent = { ...k1, txHash: "0x" + "77".repeat(32) };
    for (const [d, b] of both(order(O, { fundingAttempt: k1 }), order(O, { fundingAttempt: sent })))
      expect(merge(journal({ swaps: [d] }), journal({ swaps: [b] })).swaps[0].fundingAttempt).toEqual(sent);
  });

  it("the dead attempts outlive a merge: merged first with a copy that never saw a funding, an older backup holding k1 in flight changes nothing", () => {
    // A cleared k1 (read dead) and its funding again was refused before anything was sent; C never saw a funding; B still holds k1 in flight
    const first = merge(journal({ swaps: [order(O)] }), journal({ swaps: [order(O, { deadAttempts: [fundingAttemptKey(k1)] })] }));
    const m = merge(first, journal({ swaps: [order(O, { fundingAttempt: k1 })] }));
    expect(m.swaps[0].fundingAttempt).toBeUndefined();
    expect(m.swaps[0].deadAttempts).toEqual([fundingAttemptKey(k1)]);
  });

  it("two attempts read dead in a row, each cleared to fund again (Fund now, the runner's Resume): both keys kept", () => {
    const first = deadAttemptCleared(order(O, { fundingAttempt: k1 }), k1);
    // strictly: the attempt cleared (patchSwap assigns it undefined) — left, the runner's Resume found it still sent and its window-close abandon refused
    expect(deadAttemptCleared(first, k2)).toStrictEqual({ fundingAttempt: undefined, deadAttempts: [fundingAttemptKey(k1), fundingAttemptKey(k2)] });
  });
});

describe("the critique of 12e1 (YU): one order per piece, a step planned again, B1 through a merge, a funding past the order's amount", () => {
  const Y = "0x" + "cd".repeat(32);
  const S = ["0x" + "a0".repeat(32), "0x" + "a1".repeat(32)];
  const sentX = { nullifiers: ["5", "6"] as [string, string], by: "relayer" as const, at: T0 + 2600 };
  const sum = (c: Campaign): bigint => c.tranches.reduce((n, t) => n + BigInt(t.amount), 0n);
  const facts = { now: NOW, pause: null, notesShaped: true };
  /** steps 0 and 1 settled, step 2 committed with X: the common point */
  function common(): Campaign {
    let c = campaign();
    for (const i of [0, 1])
      c = withTrancheState(withTrancheState(c, i, "committed", T0 + 1000 + i * 200, { orderId: S[i] }), i, "settled", T0 + 1100 + i * 200);
    return withTrancheState(c, 2, "committed", T0 + 1500, { orderId: X, provider: "thorchain" });
  }
  /** copy A: X's funding sent, its answer lost — the step still committed */
  const onA = (): JournalData => journal({ campaigns: [common()], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 2 }, fundingAttempt: sentX })] });
  /** copy B gave X up unfunded (its route changed) and planned step 2 again; `then` goes on from there */
  function onB(then: (c: Campaign) => Campaign, swaps: StoredSwap[] = []): JournalData {
    const again = withTrancheState(
      common(),
      2,
      "planned",
      T0 + 3000,
      { orderId: undefined, provider: undefined },
      "the route changed to chainflip before this step was funded",
    );
    return journal({ campaigns: [then(again)], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } }), ...swaps] });
  }
  const label = (t: Tranche): string => `${t.index}:${t.state}:${t.orderId === X ? "X" : t.orderId === Y ? "Y" : "-"}`;

  for (const [what, b] of [
    [
      "committed another order for the piece (Y, never funded): Y is given up",
      () =>
        onB(
          (c) => withTrancheState(c, 2, "committed", T0 + 3500, { orderId: Y, provider: "chainflip" }),
          [order(Y, { provider: "chainflip", campaign: { id: CAMPAIGN, index: 2 } })],
        ),
    ],
    [
      "left the piece ready (its commit failed before the service was asked)",
      () => onB((c) => withTrancheState(c, 2, "ready", T0 + 3500, { destination: "bc1qready" })),
    ],
    ["left the piece planned again", () => onB((c) => c)],
  ] as const) {
    it(`a funded order taken up leaves no step nothing funded beside it past the order's amount when the other copy ${what} — both directions`, () => {
      for (const [d, k] of [
        [onA(), b()],
        [b(), onA()],
      ] as const) {
        const m = merge(d, k);
        const c = m.campaigns![0];
        expect(c.tranches.map(label)).toEqual(["0:settled:-", "1:settled:-", "2:committed:X"]);
        expect(sum(c), "never 40 ETH of steps for a 30 ETH order").toBe(30n * ETH);
        expect(m.swaps.find((o) => o.orderId === X)).toMatchObject({ state: "committed", fundingAttempt: sentX });
        if (m.swaps.some((o) => o.orderId === Y))
          expect(m.swaps.find((o) => o.orderId === Y)?.state, "nothing left the private balance for Y").toBe("abandoned");
        expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: TAKEN_UP_DETAIL } });
        expect(mergedProblems(m)).toEqual([]);
        // after the Resume, the step the runner funds is X's — its funding sent, read before anything is sent again
        expect(nextAction({ ...c, state: "running" }, facts)).toEqual({ kind: "fund", index: 2 });
      }
    });
  }

  it("a sequential A → B: A gave step 2's order up and planned the piece again, B went on from A's backup and committed Y there — B whole, both directions", () => {
    const a = onB((c) => c);
    const b = onB(
      (c) => withTrancheState(c, 2, "committed", T0 + 3500, { orderId: Y, provider: "chainflip" }),
      [order(Y, { provider: "chainflip", campaign: { id: CAMPAIGN, index: 2 } })],
    );
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const c = merge(d, k).campaigns![0];
      expect(c, "never paused as if both copies ran it").toEqual(b.campaigns![0]);
      expect(nextAction(c, facts)).toEqual({ kind: "fund", index: 2 });
    }
  });

  it("a step nothing funded that goes for a taken-up order: its order stays as it is when closed already (a lapsed order is never re-labelled given up)", () => {
    const b = onB(
      (c) => withTrancheState(c, 2, "committed", T0 + 3500, { orderId: Y, provider: "chainflip" }),
      [order(Y, { state: "lapsed", provider: "chainflip", campaign: { id: CAMPAIGN, index: 2 } })],
    );
    const m = merge(onA(), b);
    expect(m.campaigns![0].tranches.map(label)).toEqual(["0:settled:-", "1:settled:-", "2:committed:X"]);
    expect(m.swaps.find((o) => o.orderId === Y)?.state).toBe("lapsed");
  });

  it("the other copy's order for the piece carries a funding too (both sent): both stay steps, each funded on chain (gap 51) — both directions", () => {
    const sentY = { nullifiers: ["7", "8"] as [string, string], by: "relayer" as const, at: T0 + 3600 };
    const b = onB(
      (c) => withTrancheState(c, 2, "committed", T0 + 3500, { orderId: Y, provider: "chainflip" }),
      [order(Y, { provider: "chainflip", campaign: { id: CAMPAIGN, index: 2 }, fundingAttempt: sentY })],
    );
    for (const [d, k] of [
      [onA(), b],
      [b, onA()],
    ] as const) {
      const m = merge(d, k);
      expect(m.campaigns![0].tranches.map(label)).toEqual(["0:settled:-", "1:settled:-", "2:committed:Y", "3:committed:X"]);
      expect(m.swaps.find((o) => o.orderId === Y)?.state).toBe("committed");
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("a re-size on the copy that went on is no second copy running it: B, restored from A's backup, re-sized and funded step 0 — B whole, both directions", () => {
    // A: step 0's order X lapsed before it was funded, given up and the step planned again; A is not used afterwards
    let a = withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: X, provider: "thorchain" });
    a = withTrancheState(
      a,
      0,
      "planned",
      T0 + 2000,
      { orderId: undefined, provider: undefined },
      "its order lapsed before it was funded: the step planned again",
    );
    // B: its first commit took a route with smaller pieces (every planned step rewritten), then step 0 committed and funded with Y
    const b = stepThrough(
      replan(
        a,
        Array.from({ length: 6 }, () => 5n * ETH),
        T0 + 5000,
      ),
      0,
      ["funded"],
      T0 + 5100,
      Y,
    );
    const swapsA = [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })];
    const swapsB = [...swapsA, funded(Y, { campaign: { id: CAMPAIGN, index: 0 } })];
    for (const [d, k] of [
      [journal({ campaigns: [a], swaps: swapsA }), journal({ campaigns: [b], swaps: swapsB })],
      [journal({ campaigns: [b], swaps: swapsB }), journal({ campaigns: [a], swaps: swapsA })],
    ] as const) {
      const c = merge(d, k).campaigns![0];
      expect(c, "never paused as if both copies ran it: the funded step signs at once").toEqual(b);
      expect(nextAction(c, facts)).toEqual({ kind: "sign", index: 0 });
    }
  });

  it("B1 through a merge: a returned amount is asked about again after the merge's pause — its Resume is never the word to swap it again", () => {
    // B: step 0 settled, step 1 refunded in full, step 2 settled; its runner asked B1. A: paused and resumed meanwhile — the copies diverged
    let b = stepThrough(campaign(), 0, ["funded", "signed", "executing", "settled"], T0 + 2000, S[0]);
    b = withTrancheState(stepThrough(b, 1, ["funded", "signed", "executing", "refunding"], T0 + 3000, S[1]), 1, "refunded", T0 + 3900, {
      outcome: { refunded: (10n * ETH).toString() },
    });
    b = stepThrough(b, 2, ["funded", "signed", "executing", "settled"], T0 + 4000, X);
    b = {
      ...withCampaignState(b, "paused", T0 + 5000, "part came back", {
        pause: { reason: "bounds", detail: "Part of this swap came back to your private balance.", at: T0 + 5000 },
      }),
      replanAskedAt: T0 + 5000,
    };
    const a = withCampaignState(withCampaignState(campaign(), "paused", T0 + 1500, "paused by you"), "reassessing", T0 + 1600);
    const c = merge(journal({ campaigns: [a] }), journal({ campaigns: [b] })).campaigns![0];
    expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: DIVERGED_DETAIL } });
    expect(c.replanAskedAt).toBeUndefined();
    // the user resumes the merge's pause: the 10 ETH is asked about before anything is planned, its fees not paid again unasked
    const resumed = withCampaignState(withCampaignState(c, "reassessing", NOW + 1), "running", NOW + 2);
    expect(nextAction(resumed, { ...facts, now: NOW + 3 })).toMatchObject({ kind: "pause", replan: true });
  });

  it("a step that comes back funded under a campaign the other copy completed: paused for a reconcile, never left completed with the funding followed by nothing — both directions", () => {
    // A funded X before its deadline (no step entry yet); B read X expired, skipped its step, planned the 10 ETH again as step 3, swapped it, completed
    const a = journal({
      campaigns: [common()],
      swaps: [order(X, { state: "funded", fundedTx: "0x" + "71".repeat(32), campaign: { id: CAMPAIGN, index: 2 } })],
    });
    let bc = withTrancheState(common(), 2, "skipped", T0 + 9000, {}, "the order expired before it was funded");
    bc = {
      ...bc,
      tranches: [...bc.tranches, { index: 3, amount: (10n * ETH).toString(), state: "planned", attempt: 0, history: [{ state: "planned", at: T0 + 9100 }] }],
    };
    bc = withCampaignState(stepThrough(bc, 3, ["funded", "signed", "executing", "settled"], T0 + 9200, Y), "completed", T0 + 9900);
    const b = journal({
      campaigns: [bc],
      swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } }), order(Y, { state: "completed", campaign: { id: CAMPAIGN, index: 3 } })],
    });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      const c = m.campaigns![0];
      expect(c.tranches[2]).toMatchObject({ orderId: X, state: "committed" });
      expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile" } });
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("a ready step at another index goes with the plan when the steps change: never a step nothing funded beside a taken-up order past the amount — both directions", () => {
    // a 40 ETH order in four pieces: steps 0 and 1 settled, step 2 committed with X on both copies; A sent X's funding (its answer lost); B gave X up
    // unfunded, committed Z for step 2 and swapped it, then left step 3 ready (its commit failed before the service was asked)
    const four = (): Campaign => {
      const c0 = createCampaign({
        id: CAMPAIGN,
        now: T0,
        mode: "balanced",
        tier: "high-value",
        request: { from: bounds(40n * ETH).assetIn, to: bounds(40n * ETH).assetOut, amount: (40n * ETH).toString(), preference: "balanced" } as never,
        bounds: bounds(40n * ETH),
        plan,
        pieces: [10n * ETH, 10n * ETH, 10n * ETH, 10n * ETH],
        referenceRateE18: rateE18(24_000_000n, 800n * ETH),
      });
      let x: Campaign = { ...withCampaignState(c0, "running", T0 + 1000), provider: "thorchain" };
      for (const i of [0, 1])
        x = withTrancheState(withTrancheState(x, i, "committed", T0 + 1000 + i * 200, { orderId: S[i] }), i, "settled", T0 + 1100 + i * 200);
      return withTrancheState(x, 2, "committed", T0 + 1500, { orderId: X, provider: "thorchain" });
    };
    const Z = "0x" + "d2".repeat(32);
    const a = journal({ campaigns: [four()], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 2 }, fundingAttempt: sentX })] });
    let bc = withTrancheState(four(), 2, "planned", T0 + 3000, { orderId: undefined, provider: undefined }, "the route changed before this step was funded");
    bc = withTrancheState(stepThrough(bc, 2, ["funded", "signed", "executing", "settled"], T0 + 3500, Z), 3, "ready", T0 + 5000, { destination: "bc1qready" });
    const b = journal({
      campaigns: [bc],
      swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } }), order(Z, { state: "completed", campaign: { id: CAMPAIGN, index: 2 } })],
    });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      const c = m.campaigns![0];
      expect(c.tranches.map((t) => `${t.index}:${t.state}:${t.orderId === X ? "X" : t.orderId === Z ? "Z" : "-"}`)).toEqual([
        "0:settled:-",
        "1:settled:-",
        "2:settled:Z",
        "3:committed:X",
      ]);
      expect(mergedProblems(m)).toEqual([]);
      expect(nextAction({ ...c, state: "running" }, facts)).toEqual({ kind: "fund", index: 3 });
    }
  });

  it("an order taken up after a funded piece of its own index: the step nothing funded goes instead, the latest first — never 40 ETH of steps for 30, both directions", () => {
    // step 0 settled, step 1 committed with X on both; A sent X's funding (its answer lost); B gave X up, committed and funded Z for step 1, then
    // committed Y for step 2 (not funded)
    const Z = "0x" + "d2".repeat(32);
    let base = withTrancheState(withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: S[0] }), 0, "settled", T0 + 1100);
    base = withTrancheState(base, 1, "committed", T0 + 1500, { orderId: X, provider: "thorchain" });
    const a = journal({ campaigns: [base], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: sentX })] });
    let bc = withTrancheState(base, 1, "planned", T0 + 3000, { orderId: undefined, provider: undefined }, "the route changed before this step was funded");
    bc = withTrancheState(stepThrough(bc, 1, ["funded"], T0 + 3500, Z), 2, "committed", T0 + 4000, { orderId: Y, provider: "thorchain" });
    const b = journal({
      campaigns: [bc],
      swaps: [
        order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 1 } }),
        funded(Z, { campaign: { id: CAMPAIGN, index: 1 } }),
        order(Y, { campaign: { id: CAMPAIGN, index: 2 } }),
      ],
    });
    const named = (t: Tranche): string => `${t.index}:${t.state}:${t.orderId === X ? "X" : t.orderId === Y ? "Y" : t.orderId === Z ? "Z" : "-"}`;
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      expect(m.campaigns![0].tranches.map(named)).toEqual(["0:settled:-", "1:funded:Z", "2:committed:X"]);
      expect(m.swaps.find((o) => o.orderId === Y)?.state, "nothing left the private balance for Y").toBe("abandoned");
      expect(m.swaps.find((o) => o.orderId === X)?.campaign?.index, "the order's step numbered by its position").toBe(2);
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("an order taken up over a re-sized piece keeps its own step — its size, its expected minimum, its history — and the step nothing funded goes, both directions", () => {
    // A: step 2 committed with X (10 ETH, its expected minimum), X's funding sent; B: X given up when the route changed to chainflip, whose pieces
    // are smaller — the rest re-planned 5 + 5 — and Y committed for 5
    const expected = { minOut: "123", rateE18: "456", etaSeconds: 600 };
    const ac: Campaign = { ...common(), tranches: common().tranches.map((t) => (t.index === 2 ? { ...t, expected } : t)) };
    const a = journal({ campaigns: [ac], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 2 }, fundingAttempt: sentX })] });
    let bc = withTrancheState(
      common(),
      2,
      "planned",
      T0 + 3000,
      { orderId: undefined, provider: undefined },
      "the route changed to chainflip before this step was funded",
    );
    bc = withTrancheState(replan(bc, [5n * ETH, 5n * ETH], T0 + 3100), 2, "committed", T0 + 3500, { orderId: Y, provider: "chainflip" });
    const b = journal({
      campaigns: [bc],
      swaps: [
        order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } }),
        order(Y, { provider: "chainflip", campaign: { id: CAMPAIGN, index: 2 } }),
      ],
    });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      const c = m.campaigns![0];
      expect(c.tranches.map(label)).toEqual(["0:settled:-", "1:settled:-", "2:committed:X"]);
      expect(c.tranches[2]).toMatchObject({ amount: (10n * ETH).toString(), expected, history: ac.tranches[2].history });
      expect(m.swaps.find((o) => o.orderId === Y)?.state).toBe("abandoned");
      expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: DIVERGED_DETAIL } });
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("a step given up twice on the newer copy, against the older copy's first commit: no step names the first order — both directions", () => {
    const X2 = "0x" + "e7".repeat(32);
    const older = withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: X, provider: "thorchain" });
    let newer = withTrancheState(older, 0, "planned", T0 + 2000, { orderId: undefined, provider: undefined }, "its tip went stale before it was funded");
    newer = withTrancheState(newer, 0, "committed", T0 + 3000, { orderId: X2, provider: "thorchain" });
    newer = withTrancheState(newer, 0, "planned", T0 + 4000, { orderId: undefined, provider: undefined }, "its window closed before it was funded");
    const a = journal({ campaigns: [older], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 0 } })] });
    const b = journal({
      campaigns: [newer],
      swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } }), order(X2, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })],
    });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      expect(m.campaigns![0], "the newer copy whole: both its give-ups stand").toEqual(newer);
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  for (const [what, before] of [
    [
      "committed step 0's order X, which B gave up when its window closed",
      (c: Campaign): Campaign => withTrancheState(c, 0, "committed", T0 + 1000, { orderId: X, provider: "thorchain" }),
    ],
    [
      "left step 0 ready (its commit failed before the service was asked)",
      (c: Campaign): Campaign => withTrancheState(c, 0, "ready", T0 + 1000, { destination: "bc1qready" }),
    ],
  ] as const) {
    it(`a re-size on the copy that went on: A ${what}; B re-sized the plan and funded step 0 — B whole, both directions`, () => {
      const a = before(campaign());
      const fresh: Tranche[] = Array.from({ length: 6 }, (_, index) => ({
        index,
        amount: (5n * ETH).toString(),
        state: "planned",
        attempt: 0,
        history: [{ state: "planned", at: T0 + 5000, note: "re-planned" }],
      }));
      const b = stepThrough({ ...a, tranches: fresh }, 0, ["funded"], T0 + 5100, Y);
      const swapsA = a.tranches[0].orderId ? [order(X, { campaign: { id: CAMPAIGN, index: 0 } })] : [];
      const swapsB = [
        ...(a.tranches[0].orderId ? [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 0 } })] : []),
        funded(Y, { campaign: { id: CAMPAIGN, index: 0 } }),
      ];
      for (const [d, k] of [
        [journal({ campaigns: [a], swaps: swapsA }), journal({ campaigns: [b], swaps: swapsB })],
        [journal({ campaigns: [b], swaps: swapsB }), journal({ campaigns: [a], swaps: swapsA })],
      ] as const) {
        const c = merge(d, k).campaigns![0];
        expect(c, "never paused as if both copies ran it").toEqual(b);
        expect(nextAction(c, facts)).toEqual({ kind: "sign", index: 0 });
      }
    });
  }

  it("B1 through a descendant merge whose steps changed: asked again after the merge's pause — both directions", () => {
    // the common point: step 0 settled, step 1 refunded in full, step 2 committed with X; A then sent X's funding (no step entry)
    let common3 = stepThrough(campaign(), 0, ["funded", "signed", "executing", "settled"], T0 + 2000, S[0]);
    common3 = withTrancheState(stepThrough(common3, 1, ["funded", "signed", "executing", "refunding"], T0 + 3000, S[1]), 1, "refunded", T0 + 3900, {
      outcome: { refunded: (10n * ETH).toString() },
    });
    common3 = withTrancheState(common3, 2, "committed", T0 + 4000, { orderId: X, provider: "thorchain" });
    // B read X expired before any funding was seen (its step skipped), and its runner asked about the 10 ETH that came back
    let bc = withTrancheState(common3, 2, "skipped", T0 + 6000, {}, "the order expired before it was funded");
    bc = {
      ...withCampaignState(bc, "paused", T0 + 7000, "part came back", {
        pause: { reason: "bounds", detail: "Part of this swap came back to your private balance.", at: T0 + 7000 },
      }),
      replanAskedAt: T0 + 7000,
    };
    const a = journal({ campaigns: [common3], swaps: [order(X, { state: "funded", fundedTx: "0x" + "72".repeat(32), campaign: { id: CAMPAIGN, index: 2 } })] });
    const b = journal({ campaigns: [bc], swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } })] });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const c = merge(d, k).campaigns![0];
      expect(c).toMatchObject({ state: "paused", pause: { reason: "reconcile", detail: TAKEN_UP_DETAIL } });
      expect(c.replanAskedAt).toBeUndefined();
      // the user resumes the merge's pause and X settles: the 10 ETH that came back is asked about before anything is planned again
      const after = withTrancheState(withCampaignState(withCampaignState(c, "reassessing", NOW + 1), "running", NOW + 2), 2, "settled", NOW + 3);
      expect(nextAction(after, { ...facts, now: NOW + 4 })).toMatchObject({ kind: "pause", replan: true });
    }
  });

  it("a step committed for a refund's re-plan stays beside a step that came back: the refunded amount is no part of the plan's sum — both directions", () => {
    let common3 = stepThrough(campaign(), 0, ["funded", "signed", "executing", "settled"], T0 + 2000, S[0]);
    common3 = withTrancheState(stepThrough(common3, 1, ["funded", "signed", "executing", "refunding"], T0 + 3000, S[1]), 1, "refunded", T0 + 3900, {
      outcome: { refunded: (10n * ETH).toString() },
    });
    common3 = withTrancheState(common3, 2, "committed", T0 + 4000, { orderId: X, provider: "thorchain" });
    // B read X expired (its step skipped), then planned the 10 ETH that came back again and committed Y for it, not funded yet; A funded X in time
    let bc = withTrancheState(common3, 2, "skipped", T0 + 6000, {}, "the order expired before it was funded");
    bc = {
      ...bc,
      tranches: [
        ...bc.tranches,
        { index: 3, amount: (10n * ETH).toString(), state: "planned", attempt: 0, history: [{ state: "planned", at: T0 + 8000, note: "re-planned" }] },
      ],
    };
    bc = withTrancheState(bc, 3, "committed", T0 + 8100, { orderId: Y, provider: "thorchain" });
    const a = journal({ campaigns: [common3], swaps: [order(X, { state: "funded", fundedTx: "0x" + "73".repeat(32), campaign: { id: CAMPAIGN, index: 2 } })] });
    const b = journal({
      campaigns: [bc],
      swaps: [order(X, { state: "abandoned", campaign: { id: CAMPAIGN, index: 2 } }), order(Y, { campaign: { id: CAMPAIGN, index: 3 } })],
    });
    for (const [d, k] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = merge(d, k);
      expect(m.campaigns![0].tranches.map(label)).toEqual(["0:settled:-", "1:refunded:-", "2:committed:X", "3:committed:Y"]);
      expect(m.swaps.find((o) => o.orderId === Y)?.state).toBe("committed");
      expect(mergedProblems(m)).toEqual([]);
    }
  });

  it("two steps nothing funded beside a taken-up order (a journal an earlier build wrote): the latest goes first, the next to fund stays", () => {
    const Y2 = "0x" + "c9".repeat(32);
    let bc = withTrancheState(withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: S[0] }), 0, "settled", T0 + 1100);
    bc = withTrancheState(withTrancheState(bc, 1, "committed", T0 + 3500, { orderId: Y, provider: "thorchain" }), 2, "committed", T0 + 3600, {
      orderId: Y2,
      provider: "thorchain",
    });
    const here = journal({ campaigns: [bc], swaps: [order(Y, { campaign: { id: CAMPAIGN, index: 1 } }), order(Y2, { campaign: { id: CAMPAIGN, index: 2 } })] });
    const there = journal({ campaigns: [bc], swaps: [order(X, { campaign: { id: CAMPAIGN, index: 1 }, fundingAttempt: sentX })] });
    const m = merge(here, there);
    expect(m.campaigns![0].tranches.map(label)).toEqual(["0:settled:-", "1:committed:Y", "2:committed:X"]);
    expect(m.swaps.find((o) => o.orderId === Y2)?.state).toBe("abandoned");
    expect(m.swaps.find((o) => o.orderId === Y)?.state).toBe("committed");
    expect(mergedProblems(m)).toEqual([]);
  });

  it("the oracle sees an open step under an ended campaign, and steps not yet funded taking the plan past the order's amount", () => {
    const done = withCampaignState(withTrancheState(campaign(), 0, "committed", T0 + 1000, { orderId: X }), "completed", T0 + 2000);
    expect(mergedProblems(journal({ campaigns: [done], swaps: [funded(X)] })).some((x) => x.includes("open under a campaign completed"))).toBe(true);
    const over: Campaign = {
      ...common(),
      tranches: [
        ...common().tranches,
        { index: 3, amount: (10n * ETH).toString(), state: "committed", attempt: 1, orderId: Y, history: [{ state: "committed", at: T0 + 4000 }] },
      ],
    };
    const swaps = [order(X, { campaign: { id: CAMPAIGN, index: 2 }, fundingAttempt: sentX }), order(Y, { campaign: { id: CAMPAIGN, index: 3 } })];
    expect(mergedProblems(journal({ campaigns: [over], swaps })).some((x) => x.includes("past the order's amount"))).toBe(true);
    // ... a step of the plan alone counts as not yet funded too
    for (const state of ["ready", "planned"] as const) {
      const c = withTrancheState(common(), 2, state, T0 + 3500, { orderId: undefined, provider: undefined });
      const layout: Campaign = {
        ...c,
        tranches: [
          ...c.tranches,
          { index: 3, amount: (10n * ETH).toString(), state: "committed", attempt: 1, orderId: X, history: [{ state: "committed", at: T0 + 1500 }] },
        ],
      };
      const held = [order(X, { campaign: { id: CAMPAIGN, index: 3 }, fundingAttempt: sentX })];
      expect(
        mergedProblems(journal({ campaigns: [layout], swaps: held })).some((x) => x.includes("past the order's amount")),
        state,
      ).toBe(true);
    }
  });

  describe("the runner never commits nor funds a step past the order's amount (a journal an earlier build merged: X taken up after its piece's Y)", () => {
    async function session(c: Campaign, swaps: StoredSwap[]): Promise<WalletSession> {
      const disk = memoryStorage();
      configure(defaultConfig({ storage: () => disk, kdfLog2N: 12 }));
      const s = new WalletSession(disk, KDF);
      await s.create("pw", new Uint8Array(32).fill(81));
      s.acknowledgePhrase();
      s.update((j) => {
        j.campaigns = [c];
        j.swaps = swaps;
      });
      return s;
    }
    function beside(): Campaign {
      const c = withTrancheState(common(), 2, "committed", T0 + 3500, { orderId: Y, provider: "thorchain" });
      return {
        ...c,
        tranches: [
          ...c.tranches,
          {
            index: 3,
            amount: (10n * ETH).toString(),
            state: "committed",
            attempt: 1,
            orderId: X,
            provider: "thorchain",
            history: [{ state: "committed", at: T0 + 1500 }],
          },
        ],
      };
    }
    const swaps = (): StoredSwap[] => [
      order(Y, { campaign: { id: CAMPAIGN, index: 2 } }),
      order(X, { campaign: { id: CAMPAIGN, index: 3 }, fundingAttempt: sentX }),
    ];

    it("a ready step to commit beside them is skipped before any order is committed: the other steps already hold the order's amount", async () => {
      const c = withTrancheState(common(), 2, "ready", T0 + 3500, { orderId: undefined, provider: undefined, destination: "bc1qready" });
      const s = await session(
        {
          ...c,
          tranches: [
            ...c.tranches,
            {
              index: 3,
              amount: (10n * ETH).toString(),
              state: "committed",
              attempt: 1,
              orderId: X,
              provider: "thorchain",
              history: [{ state: "committed", at: T0 + 1500 }],
            },
          ],
        },
        [order(X, { campaign: { id: CAMPAIGN, index: 3 }, fundingAttempt: sentX })],
      );
      const calls: string[] = [];
      await tick(s, calls, NOW);
      expect(calls, "no service order asked").not.toContain("commit:2");
      expect(s.journal().campaigns![0].tranches[2].state).toBe("skipped");
      s.lock();
    });

    it("the step that brings the plan to the order's amount exactly is committed: the commit's bound is the amount itself", async () => {
      const c = withTrancheState(common(), 2, "planned", T0 + 3500, { orderId: undefined, provider: undefined });
      const s = await session({ ...c, tranches: c.tranches.map((t) => ({ ...t, notBefore: undefined })) }, []);
      const calls: string[] = [];
      await tick(s, calls, NOW);
      expect(calls, "20 ETH settled and this step's 10: the 30 ETH approved").toContain("commit:2");
      s.lock();
    });

    it("the step that brings the steps to the order's amount exactly is funded: the bound is the amount itself", async () => {
      const s = await session(withTrancheState(common(), 2, "committed", T0 + 3500, { orderId: Y, provider: "thorchain" }), [
        order(Y, { campaign: { id: CAMPAIGN, index: 2 } }),
      ]);
      const calls: string[] = [];
      await tick(s, calls, NOW, { escrowBalance: async () => 0n });
      expect(calls, "20 ETH settled and this step's 10: the 30 ETH approved").toContain("fund");
      s.lock();
    });

    it("Y's escrow read empty: Y given up unfunded, its step skipped, nothing funded", async () => {
      const s = await session(beside(), swaps());
      const calls: string[] = [];
      await tick(s, calls, NOW, { escrowBalance: async () => 0n });
      expect(calls).not.toContain("fund");
      expect(s.journal().swaps.find((o) => o.orderId === Y)?.state).toBe("abandoned");
      expect(s.journal().campaigns![0].tranches[2].state).toBe("skipped");
      s.lock();
    });

    it("Y's escrow unreadable, or holding something: neither funded nor given up — read again at the next tick", async () => {
      for (const read of [null, 1n]) {
        const s = await session(beside(), swaps());
        const calls: string[] = [];
        await tick(s, calls, NOW, { escrowBalance: async () => read });
        expect(calls).not.toContain("fund");
        expect(s.journal().swaps.find((o) => o.orderId === Y)?.state).toBe("committed");
        expect(s.journal().campaigns![0].tranches[2].state).toBe("committed");
        s.lock();
      }
    });
  });
});

describe("the pieces this rests on", () => {
  it("a merge draws its resume points from the CSPRNG by default", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    try {
      mergeJournals(journal({ chainIndexes: { evm: 1 } }), journal({ chainIndexes: { evm: 40 } }));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the merge's ended campaign states are the campaigns' own", () => {
    expect([...CAMPAIGN_ENDED]).toEqual([...TERMINAL_STATES]);
  });
});
