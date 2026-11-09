// The twelfth review round (2026-11-06), slice 12a: an order's final state rests on what the chain says, never on a note or a word alone.
// A refund — a note the scan found, a relayer's "refunded" — counts only once the escrow's own balance is read empty (C12-1: a refund note is a
// vault deposit anyone holding the payload can make); a closed order is never reopened by a reading that did not settle, save a late refund
// held in its escrow, which plans its tick (C12-3); a closed order's re-sync keeps the reading that closed it (C12-8); a job naming no execution
// has the escrow's flag read (C12-6); a step refunded in another token ends not delivered as asked (C12-4); a refund paid at the destination
// decides first, and what the scan journaled of an undelivered step before its close is not counted as lost (C12-7); a late refund in a refund
// token is seen (VC12-N1);
// the execution is looked for from the deadline's span, never from the device's commit time (C12-9). The reviewers' probes (scratchpad
// review12/C, VC) became these cases.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/chain", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/chain")>()), clientsFor: vi.fn() }));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { StoredSwap } from "../src/wallet/journal";
import type { SwapJob } from "../src/relayer";
import { journalRefunds } from "../src/privateTx";
import type { RecoveredRefund } from "../src/refunds";
import { getOperation, resetOperationsMemory } from "../src/operations/store";
import { actionsFor } from "../src/operations/recovery";
import { swapRecordId, syncSwapRecord } from "../src/operations/swapRecords";
import {
  deriveState,
  escrowLeftOf,
  EXECUTION_SEARCH_SPAN_S,
  executionTxOf,
  journalStateOf,
  legsOf,
  refundTokenReads,
  trackOrder,
  type TrackDeps,
  type Tracked,
} from "../src/orderTracker";
import { ORDER_TRACK_MS, runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import { trancheStateOf, undeliveredWords } from "../src/wallet/campaignRunner";
import { protectedInFlight } from "../src/wallet/inFlight";
import { clientsFor, type Deployment } from "../src/chain";
import { exposure, notAsAsked, type Campaign, type Tranche } from "@privacy-wallet/protocol/wallet/campaign";
import { legsFrom } from "@privacy-wallet/protocol/wallet/settlement";
import { refundVaultsOf } from "../src/swapExecute";
import { WRAPPED_NATIVE_OF } from "@privacy-wallet/contracts/deployments";
import { refundTokensOf } from "../src/refundVaults";
import { refundNotesBack, SWAP_CLOSED_STATES } from "../src/orderStates";
import { CLOSED_STATES } from "../src/swapFunding";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  vi.mocked(clientsFor).mockReset();
  session.update((j) => {
    j.swaps = [];
    j.schedule = [];
    j.operations = [];
  });
  resetOperationsMemory();
});

const ORDER = "0x" + "ab".repeat(32);
const AMOUNT = 10n ** 18n;
const T0 = Date.parse("2026-11-04T12:00:00Z");
const DEADLINE_S = Math.floor(T0 / 1000) + 1800;
/** inside the execution window: the escrow can still execute, and nothing can have refunded it */
const NOW = T0 + 5 * 60_000;
/** the executor's watch long over */
const LATER = (DEADLINE_S + 7200) * 1000 + 86_400_000 * 2;
const ESCROW = "0x00000000000000000000000000000000000000e5" as `0x${string}`;
const VAULT = "0x" + "e7".padStart(40, "0");
const USDC_VAULT = "0x" + "c5".padStart(40, "0");
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const EXEC = ("0x" + "ee".repeat(32)) as `0x${string}`;

const put = (extra: Partial<StoredSwap> = {}): StoredSwap => {
  const s = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "thorchain",
    policy: "balanced",
    tier: "large-protected",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: AMOUNT.toString(),
      destination: "bc1q",
      slippageBps: 50,
    },
    params: { amount: AMOUNT.toString(), executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200, refundVault: VAULT },
    endpoint: ESCROW,
    approvedMin: "2970000",
    createdAt: T0,
    state: "executing",
    jobId: "job-1",
    relayerUrl: "http://relayer.test",
    handedOverAt: T0 + 60_000,
    fundedTx: "0x" + "fa".repeat(32),
    refundNoteData: "0x00",
    runner: { confirmedAt: T0 },
    ...extra,
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [...j.swaps.filter((x) => x.orderId !== s.orderId), s];
    j.schedule = [...j.schedule.filter((a) => a.id !== `order-tick:${ORDER}`), { id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt: NOW }];
  });
  return s;
};
const stored = () => session.journal().swaps.find((x) => x.orderId === ORDER)!;
const pending = () => session.journal().schedule.find((a) => a.id === `order-tick:${ORDER}` && !a.done);
const rec = () => getOperation(swapRecordId(ORDER));
const unused = async (): Promise<never> => {
  throw new Error("not used");
};
const io = (track: OrderIo["track"], o: Partial<OrderIo> = {}): OrderIo => ({
  fund: unused,
  escrowBalance: async () => AMOUNT,
  sign: unused,
  handOver: unused,
  job: async () => null,
  track,
  refund: unused,
  shieldStatus: async () => null,
  registerShield: unused,
  recoverShield: async () => 0,
  ...o,
});
const job = (state: SwapJob["state"], extra: Partial<SwapJob> = {}) => ({ id: "job-1", escrow: ESCROW, state, updatedAt: T0, ...extra }) as SwapJob;
/** the tracker with its readers */
const reader = (
  o: {
    job: SwapJob | null;
    balance: bigint | null;
    track?: unknown;
    executed?: boolean | null;
    executionTx?: `0x${string}` | null;
    tokenBalance?: bigint | null;
  },
  now = NOW,
) => {
  const readers: NonNullable<TrackDeps["readers"]> = {
    job: async () => o.job,
    balance: async () => o.balance,
    track: async () => (o.track ?? null) as never,
    ...(o.executed !== undefined ? { executed: async () => o.executed! } : {}),
    ...(o.executionTx !== undefined ? { executionTx: async () => o.executionTx! } : {}),
    ...(o.tokenBalance !== undefined ? { tokenBalance: async () => o.tokenBalance! } : {}),
  };
  return (st: StoredSwap) => trackOrder(st, { deployment: null, session, now, readers });
};
const dust = (kind: "refund" | "shield" = "refund", vault = VAULT) =>
  ({
    orderId: ORDER,
    kind,
    leafIndex: 4242,
    note: { vaultId: BigInt(vault), amount: 1n, ownerCommitment: 5n, noteSecret: 6n },
    commitment: 3n,
    noteData: "0x00",
    txHash: "0x" + "77".repeat(32),
    counter: 7,
  }) as unknown as RecoveredRefund;
/** C12-1's adversary above dust (the twelfth review round, XH's critique): a payload holder's note of half the order — what refundNotesBack counts,
 *  so the escrow's own guards decide */
const half = () => ({ ...dust(), leafIndex: 4299, note: { ...dust().note, amount: AMOUNT / 2n } }) as unknown as RecoveredRefund;

describe("C12-1: a refund counts only once the escrow is read empty", () => {
  it("a refund note inside the window, the escrow holding the whole order — a stranger's wei, or a forged half of it: left to the runner, never closed; the order stays executable and read", async () => {
    for (const note of [dust(), half()]) {
      session.update((x) => {
        x.operations = [];
      });
      resetOperationsMemory();
      put();
      journalRefunds([note]);
      expect(stored().state, "the scan closes nothing it cannot read").toBe("executing");
      const r = await runOrderTick(pending()!, {
        masterSeed: new Uint8Array(32).fill(7),
        deployment: null,
        io: io(reader({ job: job("executing"), balance: AMOUNT, executed: false })),
        now: () => NOW,
      });
      expect(r?.step).toBe("track");
      expect(stored().state).toBe("executing");
      expect(rec()?.state).not.toBe("REFUNDED");
      expect(pending(), "read again").toBeDefined();
    }
  });

  it("a Return funds' refund-only job with a forged note of half the order, the escrow full: never a refund (the escrow's own guard)", async () => {
    put({ state: "refund-only" });
    journalRefunds([half()]);
    const held = await reader({ job: job("refund-only"), balance: AMOUNT, executed: false })(stored());
    expect(held.tracked.state).not.toBe("REFUNDED");
    expect(stored().state).toBe("refund-only");
  });

  it("a relayer's bare 'refunded' with the escrow full: no refund, the journal's state kept; with the escrow read empty it is the refund", async () => {
    put();
    const full = await reader({ job: job("refunded"), balance: AMOUNT, executed: false })(stored());
    expect(full.tracked.state).not.toBe("REFUNDED");
    expect(full.tracked, "its reading: funded, waiting for its signature — never a refund the provider paid").toMatchObject({ state: "SOURCE_FINAL" });
    expect(full.tracked.detail).not.toMatch(/provider paid/);
    expect(full.tracked.state, "an order that never executed: no late refund (C12-1: it can still execute)").not.toBe("LATE_REFUND");
    expect(stored().state).toBe("executing");
    expect(journalStateOf(stored(), full.tracked, full.job)).toBeUndefined();
    syncSwapRecord(stored(), full.tracked, full.job, NOW, session);
    expect(actionsFor(rec()!), "no Return funds for an order that can still execute").not.toContain("start-refund");
    // past its window, the escrow still full: the relayer dropped it — it needs the user, never a late refund (the seventh critique, XG: read as
    // returning to the balance, it had never been offered back)
    const pastRefund = await reader({ job: job("refunded"), balance: AMOUNT, executed: false }, LATER)(stored());
    expect(pastRefund.tracked.state).toBe("DROPPED");
    expect(pastRefund.tracked.detail).toMatch(/escrow still holds it/);
    const empty = await reader({ job: job("refunded"), balance: 0n, executed: false })(stored());
    expect(empty.tracked.state).toBe("REFUNDED");
  });

  it("a refund reported with the escrow's balance unread: read again (REFUND_PENDING), never settled — and a forged 1-wei note is no report", async () => {
    put();
    journalRefunds([{ ...dust(), note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    const r = await reader({ job: job("executing"), balance: null, executed: false })(stored());
    expect(r.tracked.state).toBe("REFUND_PENDING");
    expect(r.tracked.detail).toMatch(/read again before it settles/);
    expect(stored().state).toBe("executing");
    // the same with a 1-wei note anyone holding the payload can make (the seventh critique, XG): no refund reported
    put();
    journalRefunds([dust()]);
    const forged = await reader({ job: job("executing"), balance: null, executed: false })(stored());
    expect(forged.tracked.state).not.toBe("REFUND_PENDING");
  });

  it("a Return funds' refund-only job with a forged note: the scan leaves it to its runner; it closes only on the escrow read empty", async () => {
    put({ state: "refund-only" });
    journalRefunds([dust()]);
    expect(stored().state).toBe("refund-only");
    expect(pending()?.dueAt, "its runner reads it now").toBeLessThanOrEqual(Date.now());
    const held = await reader({ job: job("refund-only"), balance: AMOUNT, executed: false })(stored());
    expect(held.tracked.state).not.toBe("REFUNDED");
    // the escrow emptied by the refund-only job: the forged note is no refund of it (XG) — its own note is waited for
    const back = await reader({ job: job("refund-only"), balance: 0n, executed: false })(stored());
    expect(back.tracked.state).toBe("REFUND_PENDING");
    expect(stored().state).toBe("refund-only");
    // ... its own note found: refunded
    journalRefunds([{ ...dust(), leafIndex: 4250, note: { ...dust().note, amount: AMOUNT - AMOUNT / 400n } } as RecoveredRefund]);
    const own = await reader({ job: job("refund-only"), balance: 0n, executed: false })(stored());
    expect(own.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });

  it("a 1-wei shield 'delivery' with the escrow still holding the order: never Completed; delivered with the escrow empty: Completed", async () => {
    const shield = {
      factory: "0x00000000000000000000000000000000000000f1",
      receiver: "0x00000000000000000000000000000000000000f2",
      params: {
        receiptId: "0x" + "12".repeat(32),
        asset: "0x0000000000000000000000000000000000000000",
        minAmount: "1000",
        shieldTip: "1",
        ownerCommitment: "5",
        noteSecret: "6",
        noteDataHash: "0x" + "34".repeat(32),
        fallbackRecipient: "0x00000000000000000000000000000000000000f3",
      },
      counter: 8,
      noteData: "0x" + "56".repeat(169),
    };
    put({ shield } as Partial<StoredSwap>);
    journalRefunds([dust("shield")]);
    expect(stored().shield?.leaves).toHaveLength(1);
    const forged = await reader({ job: job("executing"), balance: AMOUNT })(stored());
    expect(forged.tracked.state).not.toBe("COMPLETED");
    expect(stored().state).toBe("executing");
    const unread = await reader({ job: job("executing"), balance: null })(stored());
    expect(unread.tracked.state).toBe("DESTINATION_FINAL");
    const real = await reader({ job: job("completed"), balance: 0n })(stored());
    expect(real.tracked.state).toBe("COMPLETED");
    expect(stored().state).toBe("completed");
  });

  it("a hand-over whose answer was lost, a forged note (a stranger's wei, or half the order), the escrow full: the order goes on as funded — never the refund path's minute loop", async () => {
    for (const note of [dust(), half()]) {
      put({ state: "funded", jobId: undefined, handedOverAt: undefined, handOverAttempt: T0 + 60_000 } as Partial<StoredSwap>);
      journalRefunds([note]);
      expect(stored().state).toBe("funded");
      let flagAsked = 0;
      const r = await runOrderTick(pending()!, {
        masterSeed: new Uint8Array(32).fill(7),
        deployment: null,
        io: io(unused as never, { escrowExecuted: async () => (flagAsked++, null), job: async () => null }),
        now: () => NOW,
      }).catch((e: unknown) => ({ step: `threw: ${String((e as Error).message)}` }));
      expect(flagAsked, "the refund path is not taken: its flag is never asked").toBe(0);
      expect(String(r?.step)).not.toBe("settled");
      expect(stored().state).not.toBe("refunded");
    }
  });
});

describe("C12-3: a closed order is never reopened by a reading that did not settle", () => {
  it("journalStateOf: a closed order's unsettled reading changes nothing; a late refund held in the escrow reopens it", () => {
    expect(journalStateOf({ state: "completed" }, { state: "PROVIDER_EXECUTING" }, { state: "completed" })).toBeUndefined();
    expect(journalStateOf({ state: "completed" }, { state: "DESTINATION_SUBMITTED" }, { state: "completed" })).toBeUndefined();
    expect(journalStateOf({ state: "refunded" }, { state: "PROVIDER_EXECUTING" }, { state: "refunded" })).toBeUndefined();
    expect(journalStateOf({ state: "completed" }, { state: "LATE_REFUND" }, { state: "completed" }), "gap 91: Return funds is offered").toBe("executed");
    expect(journalStateOf({ state: "executed" }, { state: "PROVIDER_EXECUTING" }, { state: "completed" }), "an open order as before").toBe("executed");
  });

  it("a completed order re-read with the provider unread, or the balance unread: it stays completed, no tick, nothing in flight", async () => {
    put({ state: "completed", track: { state: "COMPLETED", label: "Completed", at: LATER } as StoredSwap["track"] });
    session.update((j) => {
      j.schedule = [];
    });
    await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: null }, LATER)(stored());
    expect(stored().state).toBe("completed");
    await reader({ job: job("completed", { executionTx: EXEC }), balance: null, track: { state: "completed" } }, LATER)(stored());
    expect(stored().state).toBe("completed");
    expect(pending()).toBeUndefined();
    expect(protectedInFlight()).toBe(0);
  });

  it("a PROVIDER_FAILED order whose escrow holds a late refund since: reopened for its Return funds, its tick planned", async () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"] });
    session.update((j) => {
      j.schedule = [];
    });
    const r = await reader({ job: job("completed", { executionTx: EXEC }), balance: AMOUNT / 2n, track: { state: "refunded" } }, LATER)(stored());
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(stored().state).toBe("executed");
    expect(pending(), "its runner reads it again").toBeDefined();
  });
});

describe("C12-8: a closed order re-synced with no reading keeps the reading that closed it", () => {
  const tick = async (at: number) => {
    const quiet: OrderIo = io(unused as never, { escrowBalance: async () => 0n });
    await runOrderTick(session.journal().schedule[0], { masterSeed: new Uint8Array(32).fill(4), deployment: null, io: quiet, now: () => at });
  };

  it("a provider failure closed by a Refresh stays RECOVERY_REQUIRED provider_failed at the runner's next tick", async () => {
    put({ state: "executed", executionTx: EXEC });
    session.update((j) => {
      j.schedule = [{ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt: LATER + 600_000 }];
    });
    const r = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "failed" } }, LATER)(stored());
    syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
    expect(stored().state).toBe("completed");
    await tick(LATER + 600_000);
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    expect(rec()?.reason?.code).toBe("provider_failed");
  });

  it("a refund paid at the destination closed by Activity's Refresh keeps its outcome at the runner's next tick", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "mayan", quote: { refundTarget: "destination" } } as Partial<StoredSwap>);
    session.update((j) => {
      j.schedule = [{ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt: LATER + 600_000 }];
    });
    const r = await reader(
      { job: job("executed", { executionTx: EXEC }), balance: 0n, track: { state: "refunded", refundedTo: "destination" } },
      LATER,
    )(stored());
    expect(r.tracked.state).toBe("REFUNDED_AT_DESTINATION");
    await tick(LATER + 600_000);
    expect(rec()?.state).toBe("COMPLETED");
    expect(rec()?.outcome).toBe("refunded-at-destination");
  });
});

describe("C12-6: a job that names no execution has the escrow's flag read", () => {
  it("an 'executed' job naming no transaction: the flag, then the escrow's Executed event, then the provider — never polled for good", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    let asked = "";
    const readers: NonNullable<TrackDeps["readers"]> = {
      job: async () => job("executed"),
      balance: async () => 0n,
      executed: async () => true,
      executionTx: async () => EXEC,
      track: async (_s, tx) => ((asked = tx), { state: "completed" }) as never,
    };
    const r = await trackOrder(stored(), { deployment: null, session, now: LATER, readers });
    expect(asked).toBe(EXEC);
    expect(r.tracked.state).toBe("DESTINATION_FINAL");
    expect(stored().executionTx).toBe(EXEC);
  });

  it("a job ended past the window (lapsed, expired, execute-failed) for an escrow its flag says executed: read as an executor that stopped watching — the provider asked, closed Completed on its word with the escrow empty, never lapsed nor polled for good", async () => {
    for (const ended of ["lapsed", "expired", "execute-failed"] as const) {
      put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
      const r = await reader({ job: job(ended), balance: 0n, executed: true, executionTx: EXEC, track: { state: "completed" } }, LATER)(stored());
      expect(r.job?.state, ended).toBe("completed");
      expect(r.tracked.state, ended).toBe("COMPLETED");
      expect(stored().state, ended).toBe("completed");
    }
  });

  it("a refund-failed job past the window, the escrow executed and holding the provider's refund: its failed re-shield, the refund named, Return funds offered — never Refunding (XP: a failed re-shield is never read as a completed job)", async () => {
    put({ state: "refund-failed", executionTx: undefined } as Partial<StoredSwap>);
    const r = await reader(
      { job: job("refund-failed"), balance: AMOUNT / 2n, executed: true, executionTx: EXEC, track: { state: "refunded" } },
      LATER,
    )(stored());
    expect(r.tracked.state).toBe("FAILED");
    expect(r.tracked.detail).toMatch(/The re-shield failed: 0\.5 ETH sits in the one-time escrow/);
    syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
    expect(actionsFor(rec()!)).toContain("start-refund");
  });

  it("a completed job naming no execution: the flag, the event, then the provider — closed Completed, never 'executed' for good; the event is looked for once", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    let searches = 0;
    const readers: NonNullable<TrackDeps["readers"]> = {
      job: async () => job("completed"),
      balance: async () => 0n,
      executed: async () => true,
      executionTx: async () => (searches++, EXEC),
      track: async () => ({ state: "completed" }) as never,
    };
    const r = await trackOrder(stored(), { deployment: null, session, now: LATER, readers });
    expect(r.tracked.state).toBe("COMPLETED");
    expect(stored().executionTx).toBe(EXEC);
    put({ ...stored(), state: "executed" } as Partial<StoredSwap>);
    await trackOrder(stored(), { deployment: null, session, now: LATER + 600_000, readers });
    expect(searches, "the event's transaction journaled: not searched again").toBe(1);
  });

  it("a lapsed job whose escrow's flag cannot be read, for an order whose funding was seen: never closed lapsed on the job alone — read again", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    await reader({ job: job("lapsed"), balance: 0n, executed: null }, LATER)(stored());
    expect(stored().state).toBe("executed");
    await reader({ job: job("lapsed"), balance: 0n, executed: true, executionTx: EXEC, track: { state: "completed" } }, LATER + 600_000)(stored());
    expect(stored().state, "the later reading closes it").toBe("completed");
  });

  it("a 'lapsed' job for an escrow its flag says never executed: lapsed as before", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    await reader({ job: job("lapsed"), balance: 0n, executed: false }, LATER)(stored());
    expect(stored().state).toBe("lapsed");
  });
});

describe("C12-4 and C12-7: what a step brought back, in another token or beside a destination outcome", () => {
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;

  it("a step refunded in USDC (a swap-first route): ended not delivered as asked, what came back recorded, never waiting 'refunding' for good", () => {
    const st = {
      ...put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 77, vault: USDC_VAULT, amount: "3400000000" }],
    } as StoredSwap;
    const tracked = deriveState(st, {
      now: LATER,
      job: job("refunded", { executionTx: EXEC }),
      escrowBalance: 0n,
      track: { state: "refunded", refundedTo: "escrow" } as never,
      refundFound: true,
      escrowExecuted: true,
    });
    expect(tracked.state).toBe("REFUNDED");
    const next = trancheStateOf(step, tracked, job("refunded"), st, "fast" as never, "solana", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome?.undelivered).toBe("refunded-other-token");
    expect(next?.patch.outcome?.returnedOther).toEqual([{ vault: USDC_VAULT, amount: "3400000000" }]);
    const c = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...step, ...next!.patch, state: next!.state }],
    } as unknown as Campaign;
    expect(exposure(c).inFlight, "out of flight: the next step can be released").toBe(0n);
    expect(exposure(c).returnedOther, "came back in another token").toBe(AMOUNT);
    expect(exposure(c).notDelivered, "never 'did not come back'").toBe(0n);
  });

  it("on a route that refunds in no other token, a note in another vault is no refund of the step: it keeps returning until its own note", () => {
    const st = { ...put({ provider: "thorchain" } as Partial<StoredSwap>), refunds: [{ leafIndex: 77, vault: USDC_VAULT, amount: "1" }] } as StoredSwap;
    const tracked = deriveState(st, {
      now: LATER,
      job: job("refunded", { executionTx: EXEC }),
      escrowBalance: 0n,
      track: { state: "refunded", refundedTo: "escrow" } as never,
      refundFound: true,
      escrowExecuted: true,
    });
    const next = trancheStateOf(step, tracked, job("refunded"), st, "fast" as never, "bitcoin", LATER, {});
    expect(next?.state).toBe("refunding");
  });

  it("a partial fill whose rest came back in USDC (a swap-first route): settled for what it delivered, the rest recorded as come back in another token — never 'partial' at every pass, never 'not delivered'", () => {
    const st = {
      ...put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 78, vault: USDC_VAULT, amount: "1000000" }],
    } as StoredSwap;
    const tracked = { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…", deliveredUnits: "500000000" } as never;
    const t = { ...step, expected: { rateE18: (10n ** 9n).toString() } } as unknown as Tranche; // 1 SOL unit per 1e9 wei: 0.5 ETH delivered
    const next = trancheStateOf(t, tracked, job("refunded"), st, "fast" as never, "solana", LATER, {});
    expect(next?.state).toBe("settled");
    expect(next?.patch.outcome?.returnedOther).toEqual([{ vault: USDC_VAULT, amount: "1000000" }]);
    const c = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...t, ...next!.patch, state: next!.state }],
    } as unknown as Campaign;
    const e = exposure(c);
    expect(e.completed, "the delivered part").toBe(BigInt(next!.patch.amount!));
    expect(e.returnedOther, "the rest, back in another token").toBe(AMOUNT - BigInt(next!.patch.amount!));
    expect(e.notDelivered).toBe(0n);
  });

  it("a refund paid at the destination with a leftover re-shielded: Refunded at the destination, naming the leftover", () => {
    const st = {
      ...put({ provider: "mayan", quote: { refundTarget: "destination" } } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 79, vault: VAULT, amount: (AMOUNT / 50n).toString() }],
    } as StoredSwap;
    const tracked = deriveState(st, {
      now: LATER,
      job: job("refunded", { executionTx: EXEC }),
      escrowBalance: 0n,
      track: { state: "refunded", refundedTo: "destination" } as never,
      refundFound: true,
      escrowExecuted: true,
    });
    expect(tracked.state).toBe("REFUNDED_AT_DESTINATION");
    expect(tracked.detail).toMatch(/re-shielded into your private balance/);
    const next = trancheStateOf(step, tracked, job("refunded"), st, "fast" as never, "solana", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome?.refunded).toBe((AMOUNT / 50n).toString());
    const c = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...step, ...next!.patch, state: next!.state }],
    } as unknown as Campaign;
    expect(exposure(c).notDelivered, "only what did not come back").toBe(AMOUNT - AMOUNT / 50n);
    expect(exposure(c).ended, "the leftover is no part of what ended").toBe(AMOUNT - AMOUNT / 50n);
    expect(exposure(c).remaining, "the leftover is planned again").toBe(AMOUNT / 50n);
  });
});

describe("VC12-N1: a late refund paid to the escrow in a refund token is seen", () => {
  it("the executor's watch over, the order's asset back to nothing, USDC held at its floor: a late refund to return", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "mayan", refundTokens: [USDC], refundFloors: { [USDC]: "1000000" } } as Partial<StoredSwap>);
    const held = await reader(
      { job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "refunded" }, tokenBalance: 3_400_000_000n },
      LATER,
    )(stored());
    expect(held.tracked.state).toBe("LATE_REFUND");
    const below = await reader(
      { job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "refunded" }, tokenBalance: 999_999n },
      LATER,
    )(stored());
    expect(below.tracked.state).not.toBe("LATE_REFUND");
  });
});

describe("C12-9: the execution is looked for from public facts only", () => {
  const BLOCK0 = 100_000n;
  const T0S = BigInt(Math.floor(T0 / 1000));
  const endpoint = (at: bigint, asked: bigint[]) => ({
    getBlockNumber: async () => BLOCK0 + 2_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (
      asked.push(blockNumber),
      { number: blockNumber, timestamp: T0S + (blockNumber - BLOCK0) * 12n }
    ),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 50_000n) throw new Error("block range too large");
      return at >= fromBlock && at <= toBlock ? [{ transactionHash: EXEC, blockNumber: at }] : [];
    },
  });
  const deployment = { chainId: 1, rpcUrl: "http://rpc1.test", rpcUrls: ["http://rpc1.test", "http://rpc2.test"], fromBlock: 0n } as unknown as Deployment;
  // the longest delay window any policy allows (72 h: best and high privacy) and an hour, written out (XU's critique: derived from the constant, any
  // span had passed)
  const spanBlocks = BigInt(72 * 3600 + 3600) / 12n;
  const deadlineBlock = BLOCK0 + 150n;

  it("an execution inside the deadline's span is found; one before the span, or after the deadline, is not this order's", async () => {
    expect(EXECUTION_SEARCH_SPAN_S, "72 h and an hour").toBe(72 * 3600 + 3600);
    const both = (at: bigint) => vi.mocked(clientsFor).mockReturnValue([endpoint(at, []), endpoint(at, [])] as never);
    both(deadlineBlock - spanBlocks + 10n);
    expect(await executionTxOf(deployment, ESCROW, DEADLINE_S)).toBe(EXEC);
    both(deadlineBlock - spanBlocks - 30n);
    expect(await executionTxOf(deployment, ESCROW, DEADLINE_S)).toBeNull();
    both(deadlineBlock);
    expect(await executionTxOf(deployment, ESCROW, DEADLINE_S), "the deadline's own block").toBe(EXEC);
    both(deadlineBlock + 1n);
    expect(await executionTxOf(deployment, ESCROW, DEADLINE_S)).toBeNull();
  });
});

describe("the fix's critique: what a closed order, a forged note and a late refund leave behind", () => {
  const T0S = BigInt(Math.floor(T0 / 1000));
  const quiet = (): OrderIo => io(unused as never, { escrowBalance: async () => 0n });

  it("close, then a read that cannot settle, then the closed order's tick: the provider failure stays recorded so, and the read answers it", async () => {
    put({ state: "executed", executionTx: EXEC });
    session.update((j) => {
      j.schedule = [{ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt: LATER + 600_000 }];
    });
    const closing = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "failed" } }, LATER)(stored());
    syncSwapRecord(stored(), closing.tracked, closing.job, LATER, session);
    expect(stored().state).toBe("completed");
    // Swap.tsx's poll, the provider down: the reading cannot settle
    const poll = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: null }, LATER + 15_000)(stored());
    expect(poll.tracked, "answered as the reading that closed it — its label, its steps, and what this read is").toMatchObject({
      state: "PROVIDER_FAILED",
      label: "Needs attention",
      steps: [true, true, false, false],
      detail: "The order closed at its last reading; this read settled nothing new, so that reading stands.",
    });
    expect(stored().track?.state, "its closing reading kept").toBe("PROVIDER_FAILED");
    syncSwapRecord(stored(), poll.tracked, poll.job, LATER + 15_000, session);
    await runOrderTick(session.journal().schedule[0], { masterSeed: new Uint8Array(32).fill(4), deployment: null, io: quiet(), now: () => LATER + 600_000 });
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    expect(rec()?.reason?.code).toBe("provider_failed");
  });

  it("a live reading that does not close it never moves a closed order's record", () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"] });
    syncSwapRecord(stored(), null, null, LATER, session);
    const live = deriveState(stored(), {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      escrowBalance: 0n,
      track: null,
      refundFound: false,
      providerUnread: true,
    });
    expect(live.state).toBe("PROVIDER_EXECUTING");
    syncSwapRecord(stored(), live, job("completed"), LATER + 1, session);
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
  });

  it("a late refund never reopens an order whose record is terminal: the order stays closed, no tick", async () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "COMPLETED", label: "Completed", at: LATER } as StoredSwap["track"] });
    session.update((j) => {
      j.schedule = [];
    });
    const done = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "completed" } }, LATER)(stored());
    syncSwapRecord(stored(), done.tracked, done.job, LATER, session);
    expect(rec()?.state).toBe("COMPLETED");
    await reader({ job: job("completed", { executionTx: EXEC }), balance: AMOUNT / 2n, track: { state: "completed" } }, LATER + 600_000)(stored());
    expect(stored().state).toBe("completed");
    expect(pending()).toBeUndefined();
  });

  it("a provider failure's record becomes a refund only on what came back being more than dust", () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"] });
    syncSwapRecord(stored(), null, null, LATER, session);
    journalRefunds([dust()]);
    expect(rec()?.state, "a 1-wei note: still the provider failure").toBe("RECOVERY_REQUIRED");
    journalRefunds([{ ...dust(), leafIndex: 4243, note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(rec()?.state).toBe("REFUNDED");
  });

  it("a forged note (a stranger's wei, or half the order) with the escrow full leaves the settlement unsettled and Start refund offered", async () => {
    for (const note of [dust(), half()]) {
      session.update((x) => {
        x.operations = [];
      });
      resetOperationsMemory();
      put({ state: "execute-failed", executionTx: undefined } as Partial<StoredSwap>);
      journalRefunds([note]);
      const r = await reader({ job: job("execute-failed"), balance: AMOUNT, executed: false }, LATER)(stored());
      expect(r.tracked.state).not.toBe("REFUNDED");
      syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
      expect(rec()?.settlement).not.toBe("COMPLETED");
      expect(actionsFor(rec()!)).toContain("start-refund");
    }
  });

  it("a refund token's floor is the call's own (keyed by the token's lower case): at the floor it is held, one unit below it is not, a 1-unit transfer never", async () => {
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    for (const [held, want] of [
      [1_000_000n, true],
      [999_999n, false],
      [1n, false],
    ] as const) {
      const r = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "refunded" }, tokenBalance: held }, LATER)(stored());
      expect(r.tracked.state === "LATE_REFUND", String(held)).toBe(want);
    }
    const r = await reader(
      { job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "refunded" }, tokenBalance: 3_400_000_000n },
      LATER,
    )(stored());
    syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
    expect(rec()?.settlement).toBe("REFUND_AVAILABLE");
    expect(actionsFor(rec()!)).toContain("start-refund");
  });

  it("an ETH order's late refund in wrapped ETH (Across refunds an unfilled ETH deposit so) is seen at the order's own floor", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "across" } as Partial<StoredSwap>);
    const readers: NonNullable<TrackDeps["readers"]> = {
      job: async () => job("completed", { executionTx: EXEC }),
      balance: async () => 0n,
      track: async () => ({ state: "refunded" }) as never,
      tokenBalance: async () => AMOUNT / 10n,
    };
    const r = await trackOrder(stored(), { deployment: { chainId: 1 } as unknown as Deployment, session, now: LATER, readers });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(r.tracked.detail, "named in its own units").toContain("0.1 WETH");
    // below the order's 1 % floor, wrapped ETH dust — anyone can send it — is no late refund
    put({ state: "executed", executionTx: EXEC, provider: "across" } as Partial<StoredSwap>);
    const dust = await trackOrder(stored(), {
      deployment: { chainId: 1 } as unknown as Deployment,
      session,
      now: LATER,
      readers: { ...readers, tokenBalance: async () => AMOUNT / 1000n },
    });
    expect(dust.tracked.state).not.toBe("LATE_REFUND");
  });

  it("an order no funding is journaled for, its refund found: the escrow's balance is read, and an empty one closes it refunded", async () => {
    put({ state: "committed", fundedTx: undefined, jobId: undefined, handedOverAt: undefined } as Partial<StoredSwap>);
    session.update((j) => {
      const x = j.swaps.find((y) => y.orderId === ORDER)!;
      x.refunds = [{ leafIndex: 9, vault: VAULT, amount: (AMOUNT - AMOUNT / 100n).toString() }];
    });
    const client = { getBalance: async () => 0n, readContract: async () => false };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    const deployment = {
      chainId: 31337,
      rpcUrl: "http://rpc1.test",
      rpcUrls: ["http://rpc1.test", "http://rpc2.test"],
      fromBlock: 0n,
    } as unknown as Deployment;
    const r = await trackOrder(stored(), { deployment, session, now: LATER });
    expect(r.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });

  it("C12-9 through the tracker: two orders that differ only in their commit time ask the endpoints for the same blocks", async () => {
    const BLOCK0 = 100_000n;
    const asked: bigint[][] = [];
    const endpoint = (list: bigint[]) => ({
      getBlockNumber: async () => BLOCK0 + 2_000n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (
        list.push(blockNumber),
        { number: blockNumber, timestamp: T0S + (blockNumber - BLOCK0) * 12n }
      ),
      getLogs: async () => [{ transactionHash: EXEC, blockNumber: BLOCK0 + 100n }],
      getBalance: async () => 0n,
      readContract: async () => true,
    });
    const deployment = { chainId: 31337, rpcUrl: "http://rpc1.test", rpcUrls: ["http://rpc1.test"], fromBlock: 0n } as unknown as Deployment;
    for (const createdAt of [T0, T0 - 6 * 3600_000]) {
      const list: bigint[] = [];
      asked.push(list);
      vi.mocked(clientsFor).mockReturnValue([endpoint(list)] as never);
      put({ state: "executed", executionTx: undefined, createdAt } as Partial<StoredSwap>);
      await trackOrder(stored(), {
        deployment,
        session,
        now: LATER,
        readers: { job: async () => job("executed"), balance: async () => 0n, track: async () => ({ state: "pending" }) as never },
      });
    }
    expect(asked[0].length).toBeGreaterThan(0);
    expect(asked[1]).toEqual(asked[0]);
  });

  it("a relayer's 'refunded' with the provider's partial in another token and the escrow full: never closed — read as its job and balance say", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "lifi" } as Partial<StoredSwap>);
    const r = await reader(
      { job: job("refunded", { executionTx: EXEC }), balance: AMOUNT, executed: true, track: { state: "partial", deliveredAsset: "USDT" } },
      LATER,
    )(stored());
    expect(r.tracked.state).not.toBe("PARTIAL");
    expect(stored().state).toBe("executed");
  });
});

describe("the mutants' gaps: the legs of a forged leaf or an unread balance, a note in another vault, what a step's rest became and its words", () => {
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;
  const campaignOf = (t: Tranche) =>
    ({ request: { amount: AMOUNT.toString() }, bounds: { maxExternalExposure: AMOUNT.toString() }, tranches: [t] }) as unknown as Campaign;

  it("a same-chain order's shield leaf is its delivery in the settlement's legs only with the escrow read at dust at most", () => {
    const shield = {
      factory: "0x00000000000000000000000000000000000000f1",
      receiver: "0x00000000000000000000000000000000000000f2",
      params: {},
      counter: 8,
      noteData: "0x00",
      leaves: [{ leafIndex: 4242, vault: VAULT, amount: "1" }],
    };
    const st = put({ state: "executed", executionTx: EXEC, shield } as unknown as Partial<StoredSwap>);
    const legs = (escrowBalance: bigint | null) =>
      legsOf(st, { now: LATER, job: job("executed", { executionTx: EXEC }), escrowBalance, track: null, refundFound: false });
    expect(legs(null), "the escrow unread: the last settlement stands").toBeNull();
    expect(legs(AMOUNT), "the escrow still holds the order: the leaf is set aside, and the provider was not read").toBeNull();
    expect(legs(0n)?.provider).toBe("delivered");
  });

  it("the legs: a refund reported counts as done only with the escrow's balance read at dust at most", () => {
    const base = { fundingSent: true, job: null, jobUnread: false, track: null, amount: AMOUNT, executeDeadline: DEADLINE_S, now: Math.floor(LATER / 1000) };
    expect(legsFrom({ ...base, refundFound: true, escrowBalance: null }), "a note, the balance unread: the last settlement stands").toBeNull();
    expect(legsFrom({ ...base, job: { state: "refunded" }, escrowBalance: null }), "the relayer's word, the balance unread").toBeNull();
    expect(legsFrom({ ...base, refundFound: true, escrowBalance: AMOUNT })?.refund, "the escrow still holds the order").not.toBe("done");
    expect(legsFrom({ ...base, refundFound: true, escrowBalance: AMOUNT / 1000n })?.refund, "dust left behind").toBe("done");
    // a refunded job after an execution, a refund held, no refund time given (the API's reconcile gave none): inside the executor's watch, never yet the user's
    expect(legsFrom({ ...base, job: { state: "refunded", executionTx: EXEC }, escrowBalance: AMOUNT / 2n })).toMatchObject({
      refund: "pending",
      refundable: false,
    });
  });

  it("a provider failure's record is never made a refund by a note in another vault, whatever its amount: the order's own refund vault decides", () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"] });
    syncSwapRecord(stored(), null, null, LATER, session);
    const foreign = dust("refund", USDC_VAULT);
    journalRefunds([{ ...foreign, leafIndex: 4245, note: { ...foreign.note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(stored().refunds?.[0]?.vault.toLowerCase()).toBe(USDC_VAULT);
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    expect(rec()?.reason?.code).toBe("provider_failed");
  });

  it("a partial fill whose delivered amount is untold and whose rest came back in USDC: ended, delivered in part — counted neither as come back nor as gone", () => {
    const st = {
      ...put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 78, vault: USDC_VAULT, amount: "1000000" }],
    } as StoredSwap;
    const tracked = { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…" } as never;
    const next = trancheStateOf(step, tracked, job("refunded"), st, "fast" as never, "solana", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome).toMatchObject({
      undelivered: "refunded-other-token",
      deliveredInPart: true,
      returnedOther: [{ vault: USDC_VAULT, amount: "1000000" }],
    });
    const e = exposure(campaignOf({ ...step, ...next!.patch, state: next!.state } as Tranche));
    expect(e).toMatchObject({ partlyBack: AMOUNT, returnedOther: 0n, notDelivered: 0n, ended: AMOUNT, inFlight: 0n });
    expect(notAsAsked(e)).toBe(AMOUNT);
  });

  it("a step that failed at its provider with part of it back: what came back is recorded, and only the rest counts as not delivered", () => {
    const st = {
      ...put({ provider: "thorchain" } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 80, vault: VAULT, amount: (AMOUNT / 4n).toString() }],
    } as StoredSwap;
    const tracked = { state: "PROVIDER_FAILED", label: "Needs attention", steps: [true, true, false, false], detail: "…" } as never;
    const next = trancheStateOf(step, tracked, job("completed"), st, "fast" as never, "bitcoin", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome).toMatchObject({ undelivered: "lost", refunded: (AMOUNT / 4n).toString() });
    expect(exposure(campaignOf({ ...step, ...next!.patch, state: next!.state } as Tranche))).toMatchObject({
      notDelivered: AMOUNT - AMOUNT / 4n,
      remaining: AMOUNT / 4n,
    });
  });

  it("the runner's pause words say what came back: the rest of a refund paid at the destination, a step delivered in part", () => {
    expect(undeliveredWords(0, "refunded-at-destination")).toContain("nothing came back to your private balance");
    expect(undeliveredWords(0, "refunded-at-destination", true)).toContain("what else came back returned to your private balance");
    expect(undeliveredWords(1, "refunded-other-token")).toMatch(/^Step 2 came back to your private balance in another token than the order's/);
    expect(undeliveredWords(1, "refunded-other-token", false, true)).toMatch(
      /^Step 2 was delivered in part, and the rest came back to your private balance in another token/,
    );
    // ... and a step that failed with part of it back (the second critique)
    expect(undeliveredWords(2, "lost")).toMatch(/^Step 3 failed at its provider, and nothing came back/);
    expect(undeliveredWords(2, "lost", true)).toMatch(/^Step 3 failed at its provider; what came back of it returned to your private balance/);
  });
});

describe("the second critique (XB): a journaled event transaction, the runner's close, refunds in a refund token's vault, the reads through the chain", () => {
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;
  const DAI_VAULT = "0x" + "da".padStart(40, "0");
  const campaignOf = (t: Tranche) =>
    ({ request: { amount: AMOUNT.toString() }, bounds: { maxExternalExposure: AMOUNT.toString() }, tranches: [t] }) as unknown as Campaign;
  const refunded = {
    now: LATER,
    job: job("refunded", { executionTx: EXEC }),
    escrowBalance: 0n,
    track: { state: "refunded", refundedTo: "escrow" } as never,
    refundFound: true,
    escrowExecuted: true,
  };

  it("a late refund returned through Return funds: the refund-only read takes the event's transaction away with its mark, the next read looks for it again, and the order closes refunded", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    let searches = 0;
    const run = (j: SwapJob, balance: bigint, now: number) =>
      trackOrder(stored(), {
        deployment: null,
        session,
        now,
        readers: {
          job: async () => j,
          balance: async () => balance,
          executed: async () => true,
          executionTx: async () => (searches++, EXEC),
          track: async () => ({ state: "refunded" }) as never,
        },
      });
    const late = await run(job("completed"), AMOUNT / 2n, LATER);
    expect(late.tracked.state).toBe("LATE_REFUND");
    expect(stored()).toMatchObject({ executionTx: EXEC, executionFromEvent: true });
    // the user's Return funds: its refund-only job, read at once (Detail's refresh), names no execution — the journal's goes, its mark with it
    await run(job("refund-only"), AMOUNT / 2n, LATER + 1000);
    expect(stored().executionTx).toBeUndefined();
    expect(stored().executionFromEvent).toBeUndefined();
    // the refund lands: the event is looked for again, the provider asked, and the order closes refunded — never "looked for again" for good
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 9, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    const back = await run(job("refunded"), 0n, LATER + 600_000);
    expect(searches, "searched again once its transaction was taken away").toBe(2);
    expect(back.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });

  it("the runner closes on the tracker's word: a lapsed job with the escrow's flag unread, for an order whose funding was seen, stays open — its tick planned, read again", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    const track: OrderIo["track"] = (st) =>
      trackOrder(st, {
        deployment: null,
        session,
        now: LATER,
        readers: { job: async () => job("lapsed"), balance: async () => 0n, executed: async () => null, track: async () => null as never },
      });
    const r = await runOrderTick(pending()!, { masterSeed: new Uint8Array(32).fill(4), deployment: null, io: io(track), now: () => LATER });
    expect(r?.step).toBe("track");
    expect(stored().state, "never closed lapsed on the job alone").toBe("executed");
    expect(pending(), "its next tick planned").toBeDefined();
  });

  it("step 1b reads an order journaled executed as one, whatever its escrow holds: the tracker asked, never the hand-over's pause", async () => {
    put({ state: "executed", executionTx: EXEC, jobId: undefined, handedOverAt: undefined } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 9, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    let tracked = 0;
    const track: OrderIo["track"] = async (st) => (
      tracked++,
      reader({ job: null, balance: AMOUNT / 4n, executed: true, track: { state: "pending" } }, LATER)(st)
    );
    const r = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment: null,
      io: io(track, { escrowBalance: async () => AMOUNT / 4n }),
      now: () => LATER,
    });
    expect(tracked, "read as executed").toBe(1);
    expect(r?.step).not.toBe("paused");
    expect(stored().paused?.code).not.toBe("handover_unknown");
  });

  it("an unfunded order whose job lapsed past the window, its escrow never deployed (its flag reads nothing): closed lapsed as before", async () => {
    put({ state: "committed", executionTx: undefined, fundedTx: undefined, handedOverAt: undefined } as Partial<StoredSwap>);
    const client = {
      getBalance: async () => 0n,
      // an escrow with no code answers no data
      readContract: async () => {
        throw new Error('The contract function "executed" returned no data ("0x").');
      },
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    const deployment = {
      chainId: 31337,
      rpcUrl: "http://rpc1.test",
      rpcUrls: ["http://rpc1.test", "http://rpc2.test"],
      fromBlock: 0n,
    } as unknown as Deployment;
    await trackOrder(stored(), { deployment, session, now: LATER, readers: { job: async () => job("lapsed") } });
    expect(stored().state).toBe("lapsed");
  });

  it("late refunds in refund tokens through the chain: each refund token's balance read at the escrow, USDC at its floor a late refund; an ERC-20 order's escrow is never read in wrapped ETH", async () => {
    const asked: string[] = [];
    const balances: Record<string, bigint> = { [USDC.toLowerCase()]: 1_000_000n };
    const client = {
      getBalance: async () => 0n,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === "executed") return true;
        asked.push(address.toLowerCase());
        return balances[address.toLowerCase()] ?? 0n;
      },
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    const deployment = { chainId: 1, rpcUrl: "http://rpc1.test", rpcUrls: ["http://rpc1.test", "http://rpc2.test"], fromBlock: 0n } as unknown as Deployment;
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    const readers: NonNullable<TrackDeps["readers"]> = {
      job: async () => job("completed", { executionTx: EXEC }),
      balance: async () => 0n,
      track: async () => ({ state: "refunded" }) as never,
    };
    const r = await trackOrder(stored(), { deployment, session, now: LATER, readers });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(asked, "USDC, and wrapped ETH for an ETH order").toContain(USDC.toLowerCase());
    // a USDC order: wrapped ETH sent to its escrow is never read, nor counted (its 1 % floor is in USDC's units)
    asked.length = 0;
    balances[USDC.toLowerCase()] = 0n;
    balances[WRAPPED_NATIVE_OF[1].toLowerCase()] = 10n ** 9n; // 1 gwei of wrapped ETH sent to the escrow: 1 % of the USDC order's units
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "across",
      request: {
        from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
        to: { chain: "base", asset: USDC, decimals: 6, symbol: "USDC" },
        amount: "100000000000",
        destination: "0x" + "11".repeat(20),
        slippageBps: 50,
      },
      params: { amount: "100000000000", executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200, refundVault: VAULT },
      refundTokens: undefined,
      refundFloors: undefined,
    } as unknown as Partial<StoredSwap>);
    const usdcOrder = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { ...readers, track: async () => ({ state: "completed" }) as never },
    });
    expect(
      asked.filter((a) => a !== USDC.toLowerCase()),
      "no wrapped ETH read",
    ).toEqual([]);
    expect(usdcOrder.tracked.state).not.toBe("LATE_REFUND");
  });

  it("a step delivered in another token with part of it back in its own vault: what came back recorded, only the rest not delivered, and the rest planned again", () => {
    const st = {
      ...put({ provider: "lifi" } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 81, vault: VAULT, amount: (AMOUNT / 50n).toString() }],
    } as StoredSwap;
    const tracked = { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…", otherToken: true, deliveredAsset: "USDC.e" } as never;
    const next = trancheStateOf(step, tracked, job("completed"), st, "fast" as never, "base", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome).toMatchObject({ undelivered: "other-token", refunded: (AMOUNT / 50n).toString() });
    expect(exposure(campaignOf({ ...step, ...next!.patch, state: next!.state } as Tranche))).toMatchObject({
      notDelivered: AMOUNT - AMOUNT / 50n,
      ended: AMOUNT - AMOUNT / 50n,
      remaining: AMOUNT / 50n,
    });
  });

  it("a refund in another token is a note in a refund token's vault at its floor: a 1-unit note in any other vault, or one below the floor, ends no step", () => {
    const base = put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>);
    const stateWith = (refunds: StoredSwap["refunds"]) => {
      const st = { ...base, refunds } as StoredSwap;
      return trancheStateOf(step, deriveState(st, refunded), job("refunded"), st, "fast" as never, "solana", LATER, {});
    };
    expect(stateWith([{ leafIndex: 77, vault: DAI_VAULT, amount: "1" }])?.state, "another vault's 1-unit note").toBe("refunding");
    expect(stateWith([{ leafIndex: 78, vault: USDC_VAULT, amount: "999999" }])?.state, "below the floor").toBe("refunding");
    const at = stateWith([{ leafIndex: 79, vault: USDC_VAULT, amount: "1000000" }]);
    expect(at?.state).toBe("undelivered");
    expect(at?.patch.outcome?.undelivered).toBe("refunded-other-token");
  });

  it("a provider failure whose refund came back in its refund token at the floor becomes a refund; below the floor, or in another vault, it stays the failure", () => {
    put({
      state: "completed",
      executionTx: EXEC,
      refundTokens: [USDC],
      refundVaults: { [USDC_VAULT]: "1000000" },
      track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"],
    } as Partial<StoredSwap>);
    syncSwapRecord(stored(), null, null, LATER, session);
    const note = (vault: string, amount: bigint, leafIndex: number) => {
      const d = dust("refund", vault);
      return { ...d, leafIndex, note: { ...d.note, amount } } as RecoveredRefund;
    };
    journalRefunds([note(DAI_VAULT, AMOUNT, 4248), note(USDC_VAULT, 999_999n, 4249)]);
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    journalRefunds([note(USDC_VAULT, 1_000_000n, 4250)]);
    expect(rec()?.state).toBe("REFUNDED");
  });

  it("a completed order read as its destination transaction sent: answered Completed, every step done — never the live reading's label or steps", async () => {
    put({ state: "completed", executionTx: EXEC, track: { state: "COMPLETED", label: "Completed", at: LATER } as StoredSwap["track"] });
    const r = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "destination-submitted" } }, LATER + 15_000)(stored());
    expect(r.tracked).toMatchObject({ state: "COMPLETED", label: "Completed", steps: [true, true, true, true] });
  });

  it("refundVaultsOf: each refund token's vault, by the vault's lower case, with that token's floor; no deployment, none", () => {
    const d = {
      erc20Vaults: [
        { symbol: "USDC", decimals: 6, token: USDC, vault: "0x00000000000000000000000000000000000000C5" },
        { symbol: "DAI", decimals: 18, token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", vault: "0x00000000000000000000000000000000000000DA" },
      ],
    } as unknown as Deployment;
    expect(refundVaultsOf(d, [USDC.toLowerCase()], { [USDC.toLowerCase()]: "5" })).toEqual({ "0x00000000000000000000000000000000000000c5": "5" });
    expect(refundVaultsOf(d, [USDC])).toEqual({ "0x00000000000000000000000000000000000000c5": "1" });
    expect(refundVaultsOf(null, [USDC])).toEqual({});
  });
});

describe("the fourth critique (XD): a closing reading kept, the executor's watch, a refund token held beside a note, a closed old journal, the runner's branches", () => {
  const ETH_VAULT_D = VAULT;
  const deployment = {
    chainId: 1,
    ethVault: ETH_VAULT_D,
    erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  } as unknown as Deployment;

  it("the scan finds the note of an order already closed refunded on its reading — a partial fill's —: that reading stays, its delivered amount with it", async () => {
    put({ state: "executed", executionTx: EXEC });
    const r = await reader(
      { job: job("refunded", { executionTx: EXEC }), balance: 0n, executed: true, track: { state: "partial", deliveredAmount: "4000000" } },
      LATER,
    )(stored());
    expect(stored().state).toBe("refunded");
    const closingTrack = stored().track;
    journalRefunds([{ ...dust(), leafIndex: 4260, note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(stored().track, "the reading that closed it, untouched").toEqual(closingTrack);
    expect(r.tracked.state).toBe("PARTIAL");
  });

  it("a refunded job after an execution, a refund held inside the executor's watch: the executor's to re-shield — never a late refund, nor Return funds", async () => {
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 96, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    const insideWatch = (DEADLINE_S + 7200 + 3600) * 1000; // an hour past its refund time
    const r = await reader(
      { job: job("refunded", { executionTx: EXEC }), balance: (AMOUNT * 3n) / 10n, executed: true, track: { state: "partial" } },
      insideWatch,
    )(stored());
    expect(r.tracked.state).toBe("REFUND_PENDING");
    expect(r.tracked.detail).toMatch(/its executor re-shields it/);
    syncSwapRecord(stored(), r.tracked, r.job, insideWatch, session);
    expect(rec()?.settlement).not.toBe("REFUND_AVAILABLE");
    expect(actionsFor(rec()!)).not.toContain("start-refund");
  });

  it("a refund token held at its floor beside a note of the order's own asset: a late refund to return — never Refunded; read for a refunded job too", async () => {
    let tokenReads = 0;
    for (const j of ["completed", "refunded"] as const) {
      // a record of its own for each job (the fifth critique: the second job had read the first one's)
      session.update((x) => {
        x.operations = [];
      });
      resetOperationsMemory();
      put({
        state: "executed",
        executionTx: EXEC,
        provider: "mayan",
        refundTokens: [USDC],
        refundFloors: { [USDC.toLowerCase()]: "1000000" },
      } as Partial<StoredSwap>);
      session.update((x) => {
        x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 97, vault: VAULT, amount: (AMOUNT / 50n).toString() }];
      });
      const r = await trackOrder(stored(), {
        deployment: null,
        session,
        now: LATER,
        readers: {
          job: async () => job(j, { executionTx: EXEC }),
          balance: async () => 0n,
          executed: async () => true,
          track: async () => ({ state: "refunded" }) as never,
          tokenBalance: async () => (tokenReads++, 3_400_000_000n),
        },
      });
      expect(r.tracked.state, j).toBe("LATE_REFUND");
      expect(r.tracked.settlement, j).toBe("REFUND_AVAILABLE");
      syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
      expect(rec()?.settlement, j).toBe("REFUND_AVAILABLE");
      expect(actionsFor(rec()!), j).toContain("start-refund");
    }
    expect(tokenReads, "the refund token read for both jobs").toBe(2);
  });

  it("an order closed as a provider failure before the hand-over kept its refund vaults: the scan derives them, and its refund in USDC makes it a refund", async () => {
    put({
      state: "completed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
      track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"],
    } as Partial<StoredSwap>);
    syncSwapRecord(stored(), null, null, LATER, session);
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    const usdc = dust("refund", USDC_VAULT);
    journalRefunds([{ ...usdc, leafIndex: 4261, note: { ...usdc.note, amount: 1_980_000_000n } } as RecoveredRefund], deployment);
    expect(stored().refundVaults).toEqual({ [USDC_VAULT]: "1000000" });
    expect(rec()?.state).toBe("REFUNDED");
  });

  it("the order runner derives a closed order's refund vaults too, before it re-syncs its record", async () => {
    put({
      state: "completed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    await runOrderTick(pending()!, { masterSeed: new Uint8Array(32).fill(4), deployment, io: io(unused as never), now: () => LATER });
    expect(stored().refundVaults).toEqual({ [USDC_VAULT]: "1000000" });
  });

  it("step 1b's refunded close journals the reading it closes on", async () => {
    put({
      state: "funded",
      jobId: undefined,
      handedOverAt: undefined,
      track: { state: "SOURCE_FINAL", label: "Preparing", at: T0 } as StoredSwap["track"],
    } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 98, vault: VAULT, amount: (AMOUNT - AMOUNT / 100n).toString() }];
    });
    const r = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment: null,
      io: io(unused as never, { escrowBalance: async () => 0n, escrowExecuted: async () => false }),
      now: () => LATER,
    });
    expect(r?.step).toBe("settled");
    expect(stored()).toMatchObject({ state: "refunded", track: { state: "REFUNDED", label: "Refunded" } });
  });

  it("a funding whose answer was lost, landed and executed elsewhere, its rest refunded: read as executed — the tracker asked, never the reconcile pause", async () => {
    put({
      state: "committed",
      fundedTx: undefined,
      jobId: undefined,
      handedOverAt: undefined,
      fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 },
    } as unknown as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 99, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    let tracked = 0;
    const r = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment: null,
      io: io(async (st) => (tracked++, reader({ job: null, balance: 0n, executed: true, executionTx: EXEC, track: { state: "completed" } }, LATER)(st)), {
        escrowBalance: async () => 0n,
        fundingFate: async () => "landed",
        job: async () => null,
        escrowExecuted: async () => true,
      }),
      now: () => LATER,
    });
    expect(tracked).toBe(1);
    expect(r?.step).not.toBe("paused");
    expect(stored().paused?.code).not.toBe("reconcile");
  });

  it("a late refund held in two refund tokens, one this wallet cannot name: neither named, never a part as the whole", async () => {
    const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    const client = {
      getBalance: async () => 0n,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) =>
        functionName === "executed"
          ? true
          : address.toLowerCase() === USDC.toLowerCase()
            ? 3_400_000_000n
            : address.toLowerCase() === DAI.toLowerCase()
              ? 10n ** 21n
              : 0n,
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC, DAI],
      refundFloors: { [USDC.toLowerCase()]: "1000000", [DAI.toLowerCase()]: "1" },
    } as Partial<StoredSwap>);
    const r = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { job: async () => job("completed", { executionTx: EXEC }), balance: async () => 0n, track: async () => ({ state: "refunded" }) as never },
    });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(r.tracked.detail).toContain("a refund in the route's refund token");
    expect(r.tracked.detail).not.toContain("USDC");
  });

  it("a refunded job of an order that never executed: no refund token read — its tokens are no provider's refund", async () => {
    let tokenReads = 0;
    put({
      state: "executing",
      executionTx: undefined,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("refunded"),
        balance: async () => 0n,
        executed: async () => false,
        tokenBalance: async () => (tokenReads++, 3_400_000_000n),
      },
    });
    expect(tokenReads).toBe(0);
  });

  it("an ERC-20 order whose route refunds in ETH (a refund token of address(0)): the escrow's ETH read as a balance, and wrapped ETH too, at that token's floor", async () => {
    const asked: string[] = [];
    let eth = 5n * 10n ** 17n;
    let weth = 0n;
    const client = {
      getBalance: async () => (asked.push("eth"), eth),
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === "executed") return true;
        asked.push(address.toLowerCase());
        return address.toLowerCase() === WRAPPED_NATIVE_OF[1].toLowerCase() ? weth : 0n;
      },
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    const zero = "0x0000000000000000000000000000000000000000";
    const usdcOrder = {
      state: "executed",
      executionTx: EXEC,
      provider: "lifi",
      request: {
        from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
        to: { chain: "arbitrum", asset: "native", decimals: 18, symbol: "ETH" },
        amount: "10000000000",
        destination: "0x" + "11".repeat(20),
        slippageBps: 50,
      },
      params: { amount: "10000000000", executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200, refundVault: USDC_VAULT },
      refundTokens: [zero],
      refundFloors: { [zero]: (3n * 10n ** 16n).toString() },
    } as unknown as Partial<StoredSwap>;
    const deployment = {
      chainId: 1,
      rpcUrl: "http://rpc1.test",
      rpcUrls: ["http://rpc1.test", "http://rpc2.test"],
      fromBlock: 0n,
      erc20Vaults: [],
    } as unknown as Deployment;
    const readers: NonNullable<TrackDeps["readers"]> = {
      job: async () => job("completed", { executionTx: EXEC }),
      balance: async () => 0n,
      track: async () => ({ state: "refunded" }) as never,
    };
    put(usdcOrder);
    const inEth = await trackOrder(stored(), { deployment, session, now: LATER, readers });
    expect(inEth.tracked.state).toBe("LATE_REFUND");
    expect(inEth.tracked.detail).toContain("0.5 ETH");
    expect(asked, "its ETH read as the escrow's balance, and its wrapped ETH asked").toEqual(
      expect.arrayContaining(["eth", WRAPPED_NATIVE_OF[1].toLowerCase()]),
    );
    // ... its refund in wrapped ETH instead, at the ETH refund token's floor
    eth = 0n;
    weth = 5n * 10n ** 17n;
    put(usdcOrder);
    const inWeth = await trackOrder(stored(), { deployment, session, now: LATER, readers });
    expect(inWeth.tracked.state).toBe("LATE_REFUND");
    expect(inWeth.tracked.detail).toContain("0.5 WETH");
    // below that floor: none
    weth = 10n ** 16n;
    put(usdcOrder);
    expect((await trackOrder(stored(), { deployment, session, now: LATER, readers })).tracked.state).not.toBe("LATE_REFUND");
  });

  it("an abandoned order the scan closes refunded journals the reading it closes on, and answers it", async () => {
    put({ state: "abandoned", track: { state: "CANCELLED", label: "Not started", at: LATER } as StoredSwap["track"] });
    journalRefunds([{ ...dust(), leafIndex: 4262, note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(stored()).toMatchObject({ state: "refunded", track: { state: "REFUNDED", label: "Refunded" } });
    const r = await reader({ job: null, balance: null }, LATER + 15_000)(stored());
    expect(r.tracked).toMatchObject({ state: "REFUNDED", label: "Refunded" });
  });

  it("a closed order's closing answer keeps its settlement: a Refresh that reads its destination transaction sent never downgrades the record's", async () => {
    put({ state: "executed", executionTx: EXEC });
    const closing = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "completed" } }, LATER)(stored());
    syncSwapRecord(stored(), closing.tracked, closing.job, LATER, session);
    expect(stored().state).toBe("completed");
    expect(rec()?.settlement).toBe("COMPLETED");
    const refresh = await reader(
      { job: job("completed", { executionTx: EXEC }), balance: 0n, track: { state: "destination-submitted" } },
      LATER + 15_000,
    )(stored());
    expect(refresh.tracked.settlement).toBe("COMPLETED");
    syncSwapRecord(stored(), refresh.tracked, refresh.job, LATER + 15_000, session);
    expect(rec()?.settlement).toBe("COMPLETED");
  });
});

describe("the third critique (XC): a WETH refund of an ERC-20 order, an own-vault note of dust, a refund behind a lost answer, a refunded job's late refund, closes that wrote no reading", () => {
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;
  const ETH_VAULT = "0x" + "e7".padStart(40, "0"); // the fixture's order vault is the pool's ETH vault (VAULT)
  const USDC_ORDER_VAULT = USDC_VAULT;
  const refunded = {
    now: LATER,
    job: job("refunded", { executionTx: EXEC }),
    escrowBalance: 0n,
    track: { state: "refunded", refundedTo: "escrow" } as never,
    refundFound: true,
    escrowExecuted: true,
  };
  const deployment = {
    chainId: 1,
    ethVault: ETH_VAULT,
    erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  } as unknown as Deployment;

  it("an ERC-20 order's refund token WETH re-shields as ETH: the native vault is its refund vault, and the step comes back in another token; a provider failure's record becomes a refund", () => {
    const weth = WRAPPED_NATIVE_OF[1];
    expect(refundVaultsOf(deployment, [weth], { [weth.toLowerCase()]: (10n ** 16n).toString() })).toEqual({ [ETH_VAULT]: (10n ** 16n).toString() });
    // ... and ETH itself (a LI.FI source swap into ETH names it so)
    expect(refundVaultsOf(deployment, ["0x0000000000000000000000000000000000000000"], { "0x0000000000000000000000000000000000000000": "7" })).toEqual({
      [ETH_VAULT]: "7",
    });
    const usdcOrder = {
      provider: "across",
      request: {
        from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
        to: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" },
        amount: "20000000000",
        destination: "0x" + "11".repeat(20),
        slippageBps: 50,
      },
      params: { amount: "20000000000", executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200, refundVault: USDC_ORDER_VAULT },
      refundTokens: [weth],
      refundFloors: { [weth.toLowerCase()]: (10n ** 16n).toString() },
      refundVaults: refundVaultsOf(deployment, [weth], { [weth.toLowerCase()]: (10n ** 16n).toString() }),
    } as unknown as Partial<StoredSwap>;
    const st = { ...put(usdcOrder), refunds: [{ leafIndex: 90, vault: ETH_VAULT, amount: (59n * 10n ** 17n).toString() }] } as StoredSwap;
    const usdcStep = { ...step, amount: "20000000000", provider: "across" } as unknown as Tranche;
    const next = trancheStateOf(usdcStep, deriveState(st, refunded), job("refunded"), st, "fast" as never, "base", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome).toMatchObject({
      undelivered: "refunded-other-token",
      returnedOther: [{ vault: ETH_VAULT, amount: (59n * 10n ** 17n).toString() }],
    });
    // the same order closed as a provider failure, its WETH refund back as ETH at the floor: a refund
    put({
      ...usdcOrder,
      state: "completed",
      executionTx: EXEC,
      track: { state: "PROVIDER_FAILED", label: "Needs attention", at: LATER } as StoredSwap["track"],
    });
    syncSwapRecord(stored(), null, null, LATER, session);
    const d = dust("refund", ETH_VAULT);
    journalRefunds([{ ...d, leafIndex: 4251, note: { ...d.note, amount: 59n * 10n ** 17n } } as RecoveredRefund]);
    expect(rec()?.state).toBe("REFUNDED");
  });

  it("an own-vault note of dust beside a refund in USDC at its floor: still came back in USDC — the dust no part of what came back (XF), never 'a returned step's fees'", () => {
    const st = {
      ...put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>),
      refunds: [
        { leafIndex: 91, vault: USDC_VAULT, amount: "19800000000" },
        { leafIndex: 92, vault: VAULT, amount: "1" },
      ],
    } as StoredSwap;
    const next = trancheStateOf(step, deriveState(st, refunded), job("refunded"), st, "fast" as never, "solana", LATER, {});
    expect(next?.state).toBe("undelivered");
    expect(next?.patch.outcome).toMatchObject({ undelivered: "refunded-other-token" });
    // ... the dust below 1 % of the step: nothing back of it (the sixth critique, XF: recorded, it had read "what else came back" and left a remainder)
    expect(next?.patch.outcome?.refunded).toBeUndefined();
    const c = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...step, ...next!.patch, state: next!.state }],
    } as unknown as Campaign;
    expect(exposure(c)).toMatchObject({ returnedOther: AMOUNT, returnCosts: 0n, notDelivered: 0n, remaining: 0n, kept: 0n });
    // ... delivered in part, how much untold: the same
    const partly = trancheStateOf(
      step,
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…" } as never,
      job("refunded"),
      st,
      "fast" as never,
      "solana",
      LATER,
      {},
    );
    expect(partly?.patch.outcome).toMatchObject({ undelivered: "refunded-other-token", deliveredInPart: true });
    expect(partly?.patch.outcome?.refunded).toBeUndefined();
    // ... delivered in part for a known amount: settled for what it delivered, the rest back in USDC — never the step's whole amount less the dust
    const known = trancheStateOf(
      { ...step, expected: { rateE18: (10n ** 9n).toString() } } as unknown as Tranche,
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…", deliveredUnits: "500000000" } as never,
      job("refunded"),
      st,
      "fast" as never,
      "solana",
      LATER,
      {},
    );
    expect(known?.state).toBe("settled");
    expect(known?.patch.amount, "the delivered half").toBe((AMOUNT / 2n).toString());
    expect(known?.patch.outcome?.returnedOther).toEqual([{ vault: USDC_VAULT, amount: "19800000000" }]);
  });

  it("an order journaled before the hand-over kept its refund tokens' vaults: the runner derives them once, from the deployment", async () => {
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    expect(stored().refundVaults).toBeUndefined();
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment,
      io: io(async (st) => reader({ job: job("executing", { executionTx: EXEC }), balance: 0n, track: { state: "pending" } }, LATER)(st)),
      now: () => LATER,
    });
    expect(stored().refundVaults).toEqual({ [USDC_VAULT]: "1000000" });
  });

  it("a funding whose answer was lost, landed, and refunded since by someone else: closed refunded, on its reading — never 'a funding was sent and is not confirmed yet' for good", async () => {
    put({
      state: "committed",
      fundedTx: undefined,
      jobId: undefined,
      handedOverAt: undefined,
      fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 },
      track: { state: "SOURCE_FINAL", label: "Preparing", at: T0 } as StoredSwap["track"],
    } as unknown as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 93, vault: VAULT, amount: (AMOUNT - AMOUNT / 100n).toString() }];
    });
    const r = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment: null,
      io: io(unused as never, { escrowBalance: async () => 0n, fundingFate: async () => "landed", job: async () => null, escrowExecuted: async () => false }),
      now: () => LATER,
    });
    expect(r?.step).toBe("settled");
    expect(stored()).toMatchObject({ state: "refunded" });
    expect(stored().track?.state, "the reading it closed on").toBe("REFUNDED");
    expect(rec()?.state).toBe("REFUNDED");
    // ... a stranger's wei its only note (the seventh critique, XG): no refund of it — never closed refunded on it
    session.update((j) => {
      j.operations = [];
    });
    resetOperationsMemory();
    put({
      state: "committed",
      fundedTx: undefined,
      jobId: undefined,
      handedOverAt: undefined,
      fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 },
      track: { state: "SOURCE_FINAL", label: "Preparing", at: T0 } as StoredSwap["track"],
    } as unknown as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 95, vault: VAULT, amount: "1" }];
    });
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(4),
      deployment: null,
      io: io(unused as never, { escrowBalance: async () => 0n, fundingFate: async () => "landed", job: async () => null, escrowExecuted: async () => false }),
      now: () => LATER,
    }).catch(() => null);
    expect(stored().state).not.toBe("refunded");
  });

  it("a partial fill's record, a stranger's wei its only note and its executor still watching: never settled as 'the rest came back'; its rest's own note: settled", () => {
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const partial = { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…", deliveredUnits: "1500000" } as Tracked;
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 96, vault: VAULT, amount: "1" }];
    });
    syncSwapRecord(stored(), partial, job("executed", { executionTx: EXEC }), LATER, session);
    expect(rec()?.state, "a stranger's wei").not.toBe("COMPLETED");
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 97, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    syncSwapRecord(stored(), partial, job("executed", { executionTx: EXEC }), LATER, session);
    expect(rec()).toMatchObject({ state: "COMPLETED", outcome: "partial" });
  });

  it("a refunded job after an execution, a second refund held in the escrow since: a late refund to return — never the funding's words", async () => {
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 94, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    const r = await reader(
      { job: job("refunded", { executionTx: EXEC }), balance: (AMOUNT * 3n) / 10n, executed: true, track: { state: "partial" } },
      LATER,
    )(stored());
    expect(r.tracked.state).toBe("LATE_REFUND");
    syncSwapRecord(stored(), r.tracked, r.job, LATER, session);
    expect(actionsFor(rec()!)).toContain("start-refund");
    expect(rec()?.settlement, "the escrow's refund available — never the funding's legs").toBe("REFUND_AVAILABLE");
  });

  it("a late refund held in a refund token is named in its own units", async () => {
    const client = {
      getBalance: async () => 0n,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) =>
        functionName === "executed" ? true : address.toLowerCase() === USDC.toLowerCase() ? 3_400_000_000n : 0n,
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    const r = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { job: async () => job("completed", { executionTx: EXEC }), balance: async () => 0n, track: async () => ({ state: "refunded" }) as never },
    });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(r.tracked.detail).toContain("3400 USDC");
  });

  it("a close that wrote no reading — the scan's refund of a lapsed order — journals the reading it closes on; a closed order whose last reading closes nothing is answered as read", async () => {
    put({ state: "lapsed", track: { state: "REFUND_PENDING", label: "Refunding", at: LATER } as StoredSwap["track"] });
    journalRefunds([{ ...dust(), leafIndex: 4252, note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(stored()).toMatchObject({ state: "refunded", track: { state: "REFUNDED", label: "Refunded" } });
    // a closed order whose journaled reading is an open one (from before this change): the live reading, never "the reading that closed it"
    put({ state: "refunded", track: { state: "SOURCE_FINAL", label: "Preparing", at: LATER } as StoredSwap["track"] });
    const r = await reader({ job: null, balance: null }, LATER + 15_000)(stored());
    expect(r.tracked.label).not.toBe("Preparing");
    expect(r.tracked.detail).not.toContain("closed at its last reading");
  });

  it("the event's mark goes when a job's transaction replaces the event's: the event is looked for again, the provider asked about it, and the order closes refunded", async () => {
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    let searches = 0;
    const asked: string[] = [];
    const run = (j: SwapJob, balance: bigint, now: number) =>
      trackOrder(stored(), {
        deployment: null,
        session,
        now,
        readers: {
          job: async () => j,
          balance: async () => balance,
          executed: async () => true,
          executionTx: async () => (searches++, EXEC),
          track: async (_s, tx) => (asked.push(tx), { state: "refunded" }) as never,
        },
      });
    await run(job("completed"), AMOUNT / 2n, LATER);
    expect(stored()).toMatchObject({ executionTx: EXEC, executionFromEvent: true });
    // the relayer's job names its own reverted call (K4): journaled, the mark gone
    const EXEC2 = ("0x" + "e2".repeat(32)) as `0x${string}`;
    await run(job("completed", { executionTx: EXEC2 }), AMOUNT / 2n, LATER + 1000);
    expect(stored().executionTx).toBe(EXEC2);
    expect(stored().executionFromEvent).toBeUndefined();
    // the refund lands, the job naming none: the event is looked for again and the provider asked about the execution itself
    session.update((j) => {
      j.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 95, vault: VAULT, amount: (AMOUNT / 2n).toString() }];
    });
    const back = await run(job("refunded"), 0n, LATER + 600_000);
    expect(searches).toBe(2);
    expect(asked.at(-1)).toBe(EXEC);
    expect(back.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });
});

describe("the sixth critique (XF): wrapped ETH beside an ETH refund token, a reverted execution's hash, dust nothing back, a lapsed order's reading, either signal alone, the floors", () => {
  const ZERO_T = "0x0000000000000000000000000000000000000000";
  const WETH1 = WRAPPED_NATIVE_OF[1];
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;
  const deployment = {
    chainId: 1,
    rpcUrl: "http://rpc1.test",
    rpcUrls: ["http://rpc1.test", "http://rpc2.test"],
    fromBlock: 0n,
    ethVault: VAULT,
    erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  } as unknown as Deployment;
  /** a 10,000 USDC LI.FI order whose route swaps into ETH before it bridges: its refund token address(0) at 0.03 ETH */
  const usdcOrder = (extra: Partial<StoredSwap> = {}) =>
    ({
      state: "executed",
      executionTx: EXEC,
      provider: "lifi",
      request: {
        from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
        to: { chain: "arbitrum", asset: "native", decimals: 18, symbol: "ETH" },
        amount: "10000000000",
        destination: "0x" + "11".repeat(20),
        slippageBps: 50,
      },
      params: { amount: "10000000000", executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200, refundVault: USDC_VAULT },
      refundTokens: [ZERO_T],
      refundFloors: { [ZERO_T]: (3n * 10n ** 16n).toString() },
      ...extra,
    }) as unknown as Partial<StoredSwap>;

  it("refundTokensOf: wrapped ETH beside address(0) for an ERC-20 order, at that token's floor, once — never for an ETH order, without that floor or a chain", () => {
    const floors = { [ZERO_T]: "30000000000000000" };
    expect(refundTokensOf(1, USDC, [ZERO_T], floors)).toEqual({
      refundTokens: [ZERO_T, WETH1],
      refundFloors: { [ZERO_T]: "30000000000000000", [WETH1.toLowerCase()]: "30000000000000000" },
    });
    expect(refundTokensOf(1, USDC, [ZERO_T, WETH1], { ...floors, [WETH1.toLowerCase()]: "5" }), "listed already: as given").toEqual({
      refundTokens: [ZERO_T, WETH1],
      refundFloors: { ...floors, [WETH1.toLowerCase()]: "5" },
    });
    expect(refundTokensOf(1, "native", [USDC], { [USDC.toLowerCase()]: "1" }).refundTokens).toEqual([USDC]);
    // an ETH order's wrapped ETH is its own (refund() unwraps it): never listed, whatever its tokens say
    expect(refundTokensOf(1, "native", [ZERO_T], floors).refundTokens).toEqual([ZERO_T]);
    expect(refundTokensOf(1, ZERO_T, [ZERO_T], floors).refundTokens).toEqual([ZERO_T]);
    expect(refundTokensOf(1, USDC, [USDC_VAULT], { [USDC_VAULT]: "1" }).refundTokens, "no ETH refund token").toEqual([USDC_VAULT]);
    expect(refundTokensOf(1, USDC, [ZERO_T], {}).refundTokens, "no floor for ETH: none the relayer would take for WETH").toEqual([ZERO_T]);
    expect(refundTokensOf(undefined, USDC, [ZERO_T], floors).refundTokens).toEqual([ZERO_T]);
    expect(refundTokensOf(1, USDC, undefined, undefined)).toEqual({ refundTokens: undefined, refundFloors: undefined });
  });

  it("a journal listing wrapped ETH beside address(0) (the hand-over's): its WETH read once, at that floor, and named", async () => {
    const asked: string[] = [];
    const client = {
      getBalance: async () => (asked.push("eth"), 0n),
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === "executed") return true;
        asked.push(address.toLowerCase());
        return address.toLowerCase() === WETH1.toLowerCase() ? 5n * 10n ** 17n : 0n;
      },
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    const floor = (3n * 10n ** 16n).toString();
    put(usdcOrder({ refundTokens: [ZERO_T, WETH1], refundFloors: { [ZERO_T]: floor, [WETH1.toLowerCase()]: floor } }));
    const r = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { job: async () => job("completed", { executionTx: EXEC }), balance: async () => 0n, track: async () => ({ state: "refunded" }) as never },
    });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(r.tracked.detail).toContain("0.5 WETH");
    expect(asked.filter((a) => a === WETH1.toLowerCase()).length, "read once, at each of its two endpoints").toBe(2);
  });

  it("an ERC-20 order whose route's refund token is wrapped ETH itself (the Across leg into WETH): a late refund in it named in WETH", async () => {
    const client = {
      getBalance: async () => 0n,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) =>
        functionName === "executed" ? true : address.toLowerCase() === WETH1.toLowerCase() ? 5n * 10n ** 17n : 0n,
    };
    vi.mocked(clientsFor).mockReturnValue([client, client] as never);
    put(usdcOrder({ provider: "across", refundTokens: [WETH1], refundFloors: { [WETH1.toLowerCase()]: (10n ** 16n).toString() } }));
    const r = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { job: async () => job("completed", { executionTx: EXEC }), balance: async () => 0n, track: async () => ({ state: "refunded" }) as never },
    });
    expect(r.tracked.state).toBe("LATE_REFUND");
    expect(r.tracked.detail).toContain("0.5 WETH");
  });

  it("an ERC-20 order whose route refunds in ETH, delivered: ETH below that token's floor sent to the escrow is no late refund — the order stays completed", async () => {
    for (const wei of [10n ** 16n, 10n ** 8n]) {
      const client = {
        getBalance: async () => wei,
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "executed" ? true : 0n),
      };
      vi.mocked(clientsFor).mockReturnValue([client, client] as never);
      put(usdcOrder({ state: "completed" }));
      const r = await trackOrder(stored(), {
        deployment,
        session,
        now: LATER,
        readers: { job: async () => job("completed", { executionTx: EXEC }), balance: async () => 0n, track: async () => ({ state: "completed" }) as never },
      });
      expect(r.tracked.state, String(wei)).not.toBe("LATE_REFUND");
      expect(stored().state, String(wei)).toBe("completed");
    }
  });

  it("a refunded job naming a reverted execution's transaction, the escrow's flag false: no refund token read — the order closes refunded as one that never executed", async () => {
    let tokenReads = 0;
    put({
      state: "executing",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 98, vault: VAULT, amount: AMOUNT.toString() }];
    });
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("refunded", { executionTx: EXEC }),
        balance: async () => 0n,
        executed: async () => false,
        track: async () => ({ state: "unknown" }) as never,
        tokenBalance: async () => (tokenReads++, 40_000_000n),
      },
    });
    expect(tokenReads).toBe(0);
    expect(r.tracked.state).toBe("REFUNDED");
    expect(r.tracked.settlement).not.toBe("REFUND_AVAILABLE");
    // the legs: the reverted hash is no execution — a refund token held beside it is never a late refund to return
    const facts = { now: LATER, job: job("refunded", { executionTx: EXEC }), escrowBalance: 0n, track: null, refundFound: true, escrowExecuted: false };
    expect(legsOf(stored(), facts as never)).toMatchObject({ executed: false, refund: "done" });
    expect(legsOf(stored(), { ...facts, refundTokensHeld: true } as never)).toMatchObject({ executed: false, refundable: false });
  });

  it("the refund tokens of a refunded job read on either signal of its execution alone: its job's transaction with the flag unread, or the flag with no transaction", async () => {
    let tokenReads = 0;
    const tokenBalance = async () => (tokenReads++, 3_400_000_000n);
    const order = {
      state: "executed",
      executionTx: undefined,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>;
    // the job names its transaction; the endpoints did not agree on the escrow's flag (null)
    put({ ...order, executionTx: EXEC });
    const first = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("refunded", { executionTx: EXEC }),
        balance: async () => 0n,
        executed: async () => null,
        track: async () => ({ state: "refunded" }) as never,
        tokenBalance,
      },
    });
    expect(tokenReads).toBe(1);
    expect(first.tracked.state).toBe("LATE_REFUND");
    syncSwapRecord(stored(), first.tracked, first.job, LATER, session);
    expect(actionsFor(rec()!)).toContain("start-refund");
    // the job names none; the flag says executed; its event not found
    session.update((x) => {
      x.operations = [];
    });
    resetOperationsMemory();
    put(order);
    const second = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("refunded"),
        balance: async () => 0n,
        executed: async () => true,
        executionTx: async () => null,
        track: async () => ({ state: "refunded" }) as never,
        tokenBalance,
      },
    });
    expect(tokenReads).toBe(2);
    expect(second.tracked.state).toBe("LATE_REFUND");
  });

  it("a refunded job after an execution, a refund token held inside the executor's watch: the executor's to re-shield — never Return funds", async () => {
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "mayan",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    const insideWatch = (DEADLINE_S + 7200 + 3600) * 1000; // an hour past its refund time
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: insideWatch,
      readers: {
        job: async () => job("refunded", { executionTx: EXEC }),
        balance: async () => 0n,
        executed: async () => true,
        track: async () => ({ state: "refunded" }) as never,
        tokenBalance: async () => 3_400_000_000n,
      },
    });
    expect(r.tracked.state).toBe("REFUND_PENDING");
    expect(r.tracked.detail).toMatch(/its executor re-shields it/);
    syncSwapRecord(stored(), r.tracked, r.job, insideWatch, session);
    expect(actionsFor(rec()!)).not.toContain("start-refund");
  });

  it("a stranger's dust in the order's own vault is nothing back of the step: refunded at its destination, its whole value not delivered; refunded, it waits for its own note; a partial's rest in another token leaves nothing to plan", () => {
    const dustNote = { leafIndex: 93, vault: VAULT, amount: "1" };
    const atDest = { ...put({ provider: "mayan" } as Partial<StoredSwap>), refunds: [dustNote] } as StoredSwap;
    const tracked = deriveState(atDest, {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      escrowBalance: 0n,
      track: { state: "refunded", refundedTo: "destination" } as never,
      refundFound: true,
      escrowExecuted: true,
      refundTokensHeld: false,
    });
    expect(tracked.state).toBe("REFUNDED_AT_DESTINATION");
    expect(tracked.detail, "never 'what else came back'").toContain("Nothing is left in the escrow.");
    // ... and what did come back is said: more than dust in the order's vault, or a refund token's note at its floor
    for (const refunds of [[{ leafIndex: 94, vault: VAULT, amount: (AMOUNT / 50n).toString() }], [{ leafIndex: 95, vault: USDC_VAULT, amount: "1000000" }]]) {
      const back = { ...atDest, refunds, refundVaults: { [USDC_VAULT]: "1000000" } } as StoredSwap;
      const said = deriveState(back, {
        now: LATER,
        job: job("completed", { executionTx: EXEC }),
        escrowBalance: 0n,
        track: { state: "refunded", refundedTo: "destination" } as never,
        refundFound: true,
        escrowExecuted: true,
      });
      expect(said.detail, refunds[0].vault).toContain("What else came back to the escrow was re-shielded into your private balance.");
    }
    // ... a refund token's note below its floor: none
    const below = { ...atDest, refunds: [{ leafIndex: 96, vault: USDC_VAULT, amount: "999999" }], refundVaults: { [USDC_VAULT]: "1000000" } } as StoredSwap;
    expect(
      deriveState(below, {
        now: LATER,
        job: job("completed", { executionTx: EXEC }),
        escrowBalance: 0n,
        track: { state: "refunded", refundedTo: "destination" } as never,
        refundFound: true,
        escrowExecuted: true,
        refundTokensHeld: false,
      }).detail,
    ).toContain("Nothing is left in the escrow.");
    const und = trancheStateOf(step, tracked, job("completed"), atDest, "fast" as never, "solana", LATER, {});
    expect(und?.state).toBe("undelivered");
    expect(und?.patch.outcome?.refunded, "the dust: nothing back of the step").toBeUndefined();
    const books = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...step, ...und!.patch, state: und!.state }],
    } as unknown as Campaign;
    expect(exposure(books)).toMatchObject({ notDelivered: AMOUNT, kept: 0n, remaining: 0n });
    // refunded, only the dust found: still returning, waiting for its own note
    const only = trancheStateOf(
      step,
      { state: "REFUNDED", label: "Refunded", steps: [true, true, false, false], detail: "…" } as never,
      job("refunded"),
      atDest,
      "fast" as never,
      "solana",
      LATER,
      {},
    );
    expect(only?.state).toBe("refunding");
    // delivered in part for a known amount, its rest back in USDC, 1 wei in the order's vault: settled for the delivery, nothing recorded back
    const st = {
      ...put({ provider: "mayan", refundTokens: [USDC], refundVaults: { [USDC_VAULT]: "1000000" } } as Partial<StoredSwap>),
      refunds: [{ leafIndex: 91, vault: USDC_VAULT, amount: "19800000000" }, dustNote],
    } as StoredSwap;
    const known = trancheStateOf(
      { ...step, expected: { rateE18: (10n ** 9n).toString() } } as unknown as Tranche,
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "…", deliveredUnits: "500000000" } as never,
      job("refunded"),
      st,
      "fast" as never,
      "solana",
      LATER,
      {},
    );
    expect(known?.state).toBe("settled");
    expect(known?.patch.outcome?.refunded).toBe("0");
    const c = {
      request: { amount: AMOUNT.toString() },
      bounds: { maxExternalExposure: AMOUNT.toString() },
      tranches: [{ ...step, ...known!.patch, state: known!.state }],
    } as unknown as Campaign;
    expect(exposure(c).remaining, "nothing left to plan: no replan's question for a stranger's wei").toBe(0n);
  });

  it("the journal's closed states: one list for the tracker and the records (orderStates.ts) and for the funding's (swapFunding.ts)", () => {
    expect([...SWAP_CLOSED_STATES]).toEqual(CLOSED_STATES);
  });

  it("a relayer's 'refunded' over an escrow holding the order: inside its window funded, in words that say so; past it DROPPED — the window's words, Return funds offered, deployAndRefund's time named until it comes (XH)", async () => {
    put();
    const inside = await reader({ job: job("refunded"), balance: AMOUNT, executed: false })(stored());
    expect(inside.tracked.state).toBe("SOURCE_FINAL");
    expect(inside.tracked.detail).toMatch(/its return is offered once its execution window closes/);
    const pastWindow = (DEADLINE_S + 60) * 1000; // before its refund time
    const early = await reader({ job: job("refunded"), balance: AMOUNT, executed: false }, pastWindow)(stored());
    expect(early.tracked.state).toBe("DROPPED");
    expect(early.tracked.detail).toMatch(/deployAndRefund after /);
    syncSwapRecord(stored(), early.tracked, early.job, pastWindow, session);
    expect(rec()).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "execution_window_closed" } });
    expect(actionsFor(rec()!)).toContain("start-refund");
    const late = await reader({ job: job("refunded"), balance: AMOUNT, executed: false }, LATER)(stored());
    expect(late.tracked.detail).not.toMatch(/deployAndRefund after/);
  });

  it("a refund paid at the destination, a refund token held in the escrow since, past the watch: a late refund to return; the escrow unread, no word on what is left in it (XH)", async () => {
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "lifi",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("completed", { executionTx: EXEC }),
        balance: async () => 0n,
        track: async () => ({ state: "refunded", refundedTo: "destination" }) as never,
        tokenBalance: async () => 25_000_000n,
      },
    });
    expect(r.tracked.state).toBe("LATE_REFUND");
    const facts = {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      track: { state: "refunded", refundedTo: "destination" } as never,
      refundFound: false,
      escrowExecuted: true,
    };
    const unread = deriveState({ ...stored(), refunds: [] } as StoredSwap, { ...facts, escrowBalance: null });
    expect(unread.state).toBe("REFUNDED_AT_DESTINATION");
    expect(unread.detail).not.toMatch(/Nothing is left in the escrow/);
    expect(deriveState({ ...stored(), refunds: [] } as StoredSwap, { ...facts, escrowBalance: 0n, refundTokensHeld: false }).detail).toMatch(
      /Nothing is left in the escrow/,
    );
    // ... and only once its refund tokens were read too (XI's critique)
    expect(deriveState({ ...stored(), refunds: [] } as StoredSwap, { ...facts, escrowBalance: 0n }).detail).not.toMatch(/Nothing is left in the escrow/);
  });

  it("a funded order not yet handed over, a stranger's wei its only note: the hand-over's hold taken as for no note; a handed-over one read at its own pace (XH)", async () => {
    put({ state: "funded", jobId: undefined, handedOverAt: undefined } as Partial<StoredSwap>);
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 91, vault: VAULT, amount: "1" }];
    });
    let held = false;
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(unused as never, {
        sign: async () => {
          held = session.holds().some((h) => JSON.stringify(h).includes("hand-over"));
          throw new Error("stopped at the sign");
        },
      }),
      now: () => NOW,
    }).catch(() => null);
    expect(held, "the hand-over's hold, through the sign").toBe(true);
    put();
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ leafIndex: 92, vault: VAULT, amount: "1" }];
    });
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(reader({ job: job("executing"), balance: AMOUNT, executed: false })),
      now: () => NOW,
    });
    expect(pending()?.dueAt, "read at its own pace, never the late refund's").toBe(NOW + ORDER_TRACK_MS);
  });

  it("a lapsed order read while its relayer does not answer: answered with its own refund pending — never 'Executing'", async () => {
    put({ state: "lapsed", track: { state: "REFUND_PENDING", label: "Refunding", at: LATER - 60_000 } as StoredSwap["track"] });
    const r = await reader({ job: null, balance: AMOUNT }, LATER)(stored());
    expect(r.tracked).toMatchObject({ state: "REFUND_PENDING", label: "Refunding", steps: [true, true, false, false] });
    expect(stored().state).toBe("lapsed");
    // ... and one whose relayer now answers it executing, the provider's destination sent (a reading that settles nothing): its own reading, its steps too
    const r2 = await reader({ job: job("executing", { executionTx: EXEC }), balance: AMOUNT, track: { state: "destination-submitted" } }, LATER)(stored());
    expect(r2.tracked).toMatchObject({ state: "REFUND_PENDING", label: "Refunding", steps: [true, true, false, false] });
    expect(stored().state).toBe("lapsed");
  });
});

describe("the seventh critique (XG): a refund note counts above dust only, everywhere; a relayer's 'refunded' over a full escrow is a dropped order", () => {
  const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "mayan", orderId: ORDER } as unknown as Tranche;
  const oneWei = { leafIndex: 94, vault: VAULT, amount: "1" };

  it("refundNotesBack: the order's own vault above dust together, or a refund token's note at its floor; a journal that names no vault, every other one", () => {
    const base = { params: { amount: AMOUNT.toString(), refundVault: VAULT }, refundVaults: { [USDC_VAULT]: "1000000" } } as unknown as StoredSwap;
    expect(refundNotesBack({ ...base, refunds: [] })).toBe(false);
    expect(refundNotesBack({ ...base, refunds: [oneWei] }), "a stranger's wei").toBe(false);
    expect(refundNotesBack({ ...base, refunds: [{ ...oneWei, amount: (AMOUNT / 100n).toString() }] }), "1 % of the order").toBe(true);
    expect(
      refundNotesBack({ ...base, refunds: Array.from({ length: 50 }, (_, i) => ({ ...oneWei, leafIndex: i, amount: (AMOUNT / 5000n).toString() })) }),
      "together",
    ).toBe(true);
    expect(refundNotesBack({ ...base, refunds: [{ leafIndex: 1, vault: USDC_VAULT, amount: "1000000" }] }), "a refund token's note at its floor").toBe(true);
    expect(refundNotesBack({ ...base, refunds: [{ leafIndex: 1, vault: USDC_VAULT, amount: "999999" }] }), "below its floor").toBe(false);
    expect(refundNotesBack({ ...base, refunds: [{ leafIndex: 1, vault: "0x" + "99".repeat(20), amount: AMOUNT.toString() }] }), "another vault's note").toBe(
      false,
    );
    const unnamed = { params: { amount: AMOUNT.toString() }, refundVaults: { [USDC_VAULT]: "1000000" } } as unknown as StoredSwap;
    expect(refundNotesBack({ ...unnamed, refunds: [{ ...oneWei, amount: (AMOUNT / 2n).toString() }] }), "no vault named: its notes counted").toBe(true);
    expect(refundNotesBack({ ...unnamed, refunds: [oneWei] })).toBe(false);
  });

  it("a delivered step's order with a stranger's wei in its own vault: Completed, never Partial — the step settles, nothing in flight", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "mayan" } as Partial<StoredSwap>);
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [oneWei];
    });
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("completed", { executionTx: EXEC }),
        balance: async () => 0n,
        executed: async () => true,
        track: async () => ({ state: "completed" }) as never,
      },
    });
    expect(r.tracked.state).toBe("COMPLETED");
    expect(stored().state).toBe("completed");
    const next = trancheStateOf(step, r.tracked, r.job, stored(), "fast" as never, "solana", LATER, {});
    expect(next?.state).not.toBe("partial");
    expect(next?.patch.outcome?.refunded).toBeUndefined();
    // ... and its legs: delivered, never a refund done on the stranger's wei
    expect(
      legsOf(stored(), {
        now: LATER,
        job: job("completed", { executionTx: EXEC }),
        escrowBalance: 0n,
        track: { state: "completed" },
        refundFound: false,
      } as never),
    ).toMatchObject({
      executed: true,
      provider: "delivered",
    });
  });

  it("an executed order whose provider's refund is on its way, a stranger's wei found: still Refunding — never closed Refunded, its late refund offered back when it lands", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "mayan" } as Partial<StoredSwap>);
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [oneWei];
    });
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: NOW,
      readers: {
        job: async () => job("executed", { executionTx: EXEC }),
        balance: async () => 0n,
        track: async () => ({ state: "refunded", refundedTo: "escrow" }) as never,
      },
    });
    expect(r.tracked.state).toBe("REFUND_PENDING");
    expect(stored().state).not.toBe("refunded");
  });

  it("a partial fill whose rest the relayer says it refunded, a stranger's wei its only note: journaled as with no note (refunded) — the wei changes nothing", () => {
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [oneWei];
    });
    expect(journalStateOf(stored(), { state: "PARTIAL" }, job("refunded"))).toBe("refunded");
    // ... its rest's own note found: completed (B11-1's rule)
    session.update((x) => {
      x.swaps.find((y) => y.orderId === ORDER)!.refunds = [{ ...oneWei, amount: (AMOUNT / 2n).toString() }];
    });
    expect(journalStateOf(stored(), { state: "PARTIAL" }, job("refunded"))).toBe("completed");
  });

  it("the scan closes a lapsed order refunded only on more than dust", () => {
    put({ state: "lapsed" });
    journalRefunds([dust()]);
    expect(stored().state, "a stranger's wei").toBe("lapsed");
    journalRefunds([{ ...dust(), leafIndex: 4251, note: { ...dust().note, amount: AMOUNT / 2n } } as RecoveredRefund]);
    expect(stored().state).toBe("refunded");
  });

  it("a relayer's bare 'refunded' over an escrow holding the order, past its window: needs attention, refundable — Return funds offered, a campaign's step failed for the user", async () => {
    put();
    const r = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(reader({ job: job("refunded"), balance: AMOUNT, executed: false }, LATER)),
      now: () => LATER,
    });
    expect(r?.step).toBe("track");
    expect(stored().state, "never closed on the relayer's word").toBe("executing");
    expect(stored().track?.state).toBe("DROPPED");
    expect(rec()?.settlement).toBe("REFUND_AVAILABLE");
    expect(actionsFor(rec()!)).toContain("start-refund");
    // the legs: refundable as an order no executor took
    expect(
      legsFrom({
        fundingSent: true,
        refundFound: false,
        job: { state: "refunded" },
        jobUnread: false,
        escrowBalance: AMOUNT,
        amount: AMOUNT,
        executeDeadline: DEADLINE_S,
        now: DEADLINE_S + 60,
      } as never),
    ).toMatchObject({
      funded: true,
      executed: false,
      refundable: true,
    });
    expect(
      legsFrom({
        fundingSent: true,
        refundFound: false,
        job: { state: "refunded" },
        jobUnread: false,
        escrowBalance: AMOUNT,
        amount: AMOUNT,
        executeDeadline: DEADLINE_S,
        now: DEADLINE_S - 60,
      } as never)?.refundable,
      "inside its window: never",
    ).toBe(false);
    // a campaign's step: failed, its own refund after the user's Resume — never "refunding" for good
    const tracked = await reader({ job: job("refunded"), balance: AMOUNT, executed: false }, LATER)(stored());
    expect(tracked.tracked.settlement).toBe("REFUND_AVAILABLE");
    expect(trancheStateOf(step, tracked.tracked, tracked.job, stored(), "fast" as never, "solana", LATER, {})?.state).toBe("failed");
  });
});

describe("the ninth critique (XI): a refund token not read is not empty; what the escrow still holds before a 'refunded' is taken; a stranger's wei at every site", () => {
  const facts = {
    now: LATER,
    job: job("completed", { executionTx: EXEC }),
    track: { state: "refunded", refundedTo: "destination" } as never,
    refundFound: false,
    escrowExecuted: true,
  };
  const withUsdc = { provider: "lifi", refundTokens: [USDC], refundFloors: { [USDC.toLowerCase()]: "1000000" } } as Partial<StoredSwap>;

  it("a refund at the destination with a refund token not read: read again, never closed — then the token held is a late refund to return (T6)", async () => {
    put({ ...withUsdc, state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    let usdc: bigint | null = null;
    const read = () =>
      trackOrder(stored(), {
        deployment: null,
        session,
        now: LATER,
        readers: {
          job: async () => job("completed", { executionTx: EXEC }),
          balance: async () => 0n,
          track: async () => ({ state: "refunded", refundedTo: "destination" }) as never,
          tokenBalance: async () => usdc,
        },
      });
    const unread = await read();
    // ... in a reading that never says the funds return to the balance (XJ's critique)
    expect(unread.tracked.state).toBe("PROVIDER_EXECUTING");
    expect(unread.tracked.label, "never 'Refunding' on the order card (XK)").toBe("Executing");
    expect(stored().track?.label, "nor in Activity").not.toBe("Refunding");
    expect(unread.tracked.detail).toMatch(/refund tokens could not be read this time/);
    expect(SWAP_CLOSED_STATES, "never closed on it").not.toContain(stored().state);
    syncSwapRecord(stored(), unread.tracked, unread.job, LATER, session);
    expect(rec()!.state, "never 'returning to your balance' for a refund paid out at the destination").not.toBe("REFUNDING");
    usdc = 25_000_000n;
    const held = await read();
    expect(held.tracked.state).toBe("LATE_REFUND");
    syncSwapRecord(stored(), held.tracked, held.job, LATER, session);
    expect(actionsFor(rec()!), "Return funds offered").toContain("start-refund");
  });

  it("'Nothing is left in the escrow' only once its refund tokens were read and none held, the escrow read at dust; a token not read keeps the last settlement (T6, Wm4)", () => {
    const s = { ...put(withUsdc), refunds: [] } as StoredSwap;
    expect(deriveState(s, { ...facts, escrowBalance: 0n, refundTokensHeld: false }).detail).toMatch(/Nothing is left in the escrow\./);
    expect(deriveState(s, { ...facts, escrowBalance: 0n }).detail, "its refund tokens not read").not.toMatch(/Nothing is left/);
    expect(deriveState(s, { ...facts, escrowBalance: AMOUNT / 2n, refundTokensHeld: false }).detail, "more than dust in the escrow").not.toMatch(
      /Nothing is left/,
    );
    expect(deriveState(s, { ...facts, escrowBalance: 0n, refundTokensHeld: null }).state, "one not read").toBe("PROVIDER_EXECUTING");
    expect(legsOf(s, { ...facts, escrowBalance: 0n, refundTokensHeld: null }), "the last settlement kept").toBeNull();
    expect(legsOf(s, { ...facts, escrowBalance: 0n, refundTokensHeld: false })).not.toBeNull();
  });

  it("a refund at the destination read while its job is still executed: its refund tokens not asked, nothing said of what is left (Wm4)", async () => {
    put({ ...withUsdc, state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    let tokenReads = 0;
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("executed", { executionTx: EXEC }),
        balance: async () => 0n,
        track: async () => ({ state: "refunded", refundedTo: "destination" }) as never,
        tokenBalance: async () => (tokenReads++, 25_000_000n),
      },
    });
    expect(tokenReads, "not asked while the executor watches").toBe(0);
    expect(r.tracked.state).toBe("REFUNDED_AT_DESTINATION");
    expect(r.tracked.detail).not.toMatch(/Nothing is left/);
  });

  it("a refund reported with a refund token not read: read again, never Refunded (T6)", () => {
    const s = put({ ...withUsdc, state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const read = (refundTokensHeld: boolean | null) =>
      deriveState(s, {
        now: LATER,
        job: job("refunded", { executionTx: EXEC }),
        escrowBalance: 0n,
        track: null,
        refundFound: false,
        escrowExecuted: true,
        refundTokensHeld,
      });
    expect(read(null)).toMatchObject({ state: "REFUND_PENDING" });
    expect(read(null).detail).toMatch(/^A refund is reported; the escrow's refund tokens could not be read this time/);
    expect(read(false).state, "every one read, none held").not.toBe("REFUND_PENDING");
  });

  it("a delivery found while the escrow's balance is not read: said as found, never as delivered (Wm7)", () => {
    const s = {
      ...put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>),
      shield: { leaves: [{ leafIndex: 1, amount: "2970000" }] },
    } as unknown as StoredSwap;
    const r = deriveState(s, { now: NOW, job: job("executed", { executionTx: EXEC }), escrowBalance: null, track: null, refundFound: false });
    expect(r.state).toBe("DESTINATION_FINAL");
    expect(r.detail).toMatch(/^A delivery to your protected balance was found; the escrow's balance could not be read this time/);
  });

  it("escrowLeftOf: the order's asset above dust, or a refund token held at its rule; null when any of it is not read — the tracker's own tokens (T2)", async () => {
    const s = put(withUsdc);
    const WETH = WRAPPED_NATIVE_OF[1];
    const reads =
      (asset: bigint | null, usdc: bigint | null, weth: bigint | null = 0n) =>
      async (token: `0x${string}` | null) =>
        token === null ? asset : token.toLowerCase() === USDC.toLowerCase() ? usdc : token.toLowerCase() === WETH.toLowerCase() ? weth : 0n;
    expect(await escrowLeftOf(s, 1, reads(0n, 0n)), "nothing").toBe(false);
    expect(await escrowLeftOf(s, 1, reads(1n, 1n, 1n)), "a stranger's wei of each").toBe(false);
    expect(await escrowLeftOf(s, 1, reads(AMOUNT / 100n, 0n)), "1 % of the order").toBe("asset");
    expect(await escrowLeftOf(s, 1, reads(0n, 1_000_000n)), "a refund token at its floor").toBe("token");
    expect(await escrowLeftOf(s, 1, reads(AMOUNT / 100n, 1_000_000n)), "both: the order's own first").toBe("asset");
    expect(await escrowLeftOf(s, 1, reads(0n, 999_999n)), "below its floor").toBe(false);
    expect(await escrowLeftOf(s, 1, reads(0n, 0n, AMOUNT / 100n)), "an ETH order's wrapped ETH at its 1 %: its own, refund() re-shields it").toBe("asset");
    expect(
      refundTokenReads(1, s).map((x) => x.own),
      "the wrapped ETH the order's own",
    ).toEqual([false, true]);
    expect(await escrowLeftOf(s, 1, reads(0n, 0n, AMOUNT / 1000n)), "below it").toBe(false);
    expect(await escrowLeftOf(s, 1, reads(null, 0n)), "the asset not read").toBeNull();
    expect(await escrowLeftOf(s, 1, reads(0n, null)), "a token not read").toBeNull();
    expect(
      await escrowLeftOf(s, 1, async () => {
        throw new Error("down");
      }),
      "a read that throws",
    ).toBeNull();
    expect(
      refundTokenReads(1, s).map((x) => x.token.toLowerCase()),
      "the tracker's own tokens",
    ).toEqual([USDC.toLowerCase(), WETH.toLowerCase()]);
  });

  it("a stranger's wei is no refund at the flag's, the pool scan's or the hold's site: no flag read for an executing order; a refunded job's own note looked for; the hold kept through a funding tick (H6, H3, H4)", async () => {
    const wei = [{ leafIndex: 98, vault: VAULT, amount: "1" }];
    // H6: an executing order beside a stranger's wei: its escrow's flag is never read for it
    put({ refunds: wei } as Partial<StoredSwap>);
    let flagReads = 0;
    await trackOrder(stored(), {
      deployment: null,
      session,
      now: NOW,
      readers: {
        job: async () => job("executing", { executionTx: EXEC }),
        balance: async () => 0n,
        track: async () => null,
        executed: async () => (flagReads++, false),
      },
    });
    expect(flagReads, "no flag read").toBe(0);
    // H3: a refunded job whose only note is a stranger's wei, the order still open: its own note is looked for in the pool at once
    put({ refunds: wei } as Partial<StoredSwap>);
    session.update((j) => {
      j.schedule = j.schedule.filter((a) => a.kind !== "discovery");
    });
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(reader({ job: job("refunded"), balance: null })),
      now: () => NOW,
    });
    expect(SWAP_CLOSED_STATES).not.toContain(stored().state);
    expect(
      session.journal().schedule.some((a) => a.kind === "discovery" && !a.done),
      "the pool scanned for its own note",
    ).toBe(true);
    // H4: before its hand-over, its funding tick ends with the hand-over's hold still taken
    put({ state: "committed", fundedTx: undefined, jobId: undefined, handedOverAt: undefined, refunds: wei } as Partial<StoredSwap>);
    const funding = await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(unused as never, { escrowBalance: async () => 0n, fund: (async () => undefined) as never }),
      now: () => NOW,
    });
    expect(funding?.step).toBe("funded");
    expect(
      session.holds().map((h) => h.reason),
      "held to the hand-over",
    ).toContain("hand-over");
    // ... and released by a tick that throws (the review round of 2026-11-02)
    await runOrderTick(pending()!, {
      masterSeed: new Uint8Array(32).fill(7),
      deployment: null,
      io: io(unused as never, {
        escrowBalance: async () => {
          throw new Error("stop");
        },
      }),
      now: () => NOW,
    }).catch(() => null);
    expect(session.holds().map((h) => h.reason)).not.toContain("hand-over");
  });
});

describe("the tenth critique (XJ): a completed job's readings wait for a refund token not read; a late refund in the order's asset decides its legs", () => {
  const withUsdc = { provider: "lifi", refundTokens: [USDC], refundFloors: { [USDC.toLowerCase()]: "1000000" } } as Partial<StoredSwap>;

  it("a completed job with a refund token not read: neither a provider failure, Completed nor Partial closes the order — read again, its tick kept; with the token held, a late refund to return", async () => {
    for (const track of [
      { state: "refunded" },
      { state: "completed" },
      { state: "partial", deliveredAmount: "500000000" },
      { state: "partial", deliveredAsset: "USDT" },
    ]) {
      session.update((j) => {
        j.operations = [];
      });
      resetOperationsMemory();
      put({ ...withUsdc, state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
      let usdc: bigint | null = null;
      const tracker: OrderIo["track"] = (st) =>
        trackOrder(st, {
          deployment: null,
          session,
          now: LATER,
          readers: {
            job: async () => job("completed", { executionTx: EXEC }),
            balance: async () => 0n,
            track: async () => track as never,
            tokenBalance: async () => usdc,
          },
        });
      const first = await runOrderTick(pending()!, { masterSeed: new Uint8Array(32).fill(7), deployment: null, io: io(tracker), now: () => LATER });
      expect(first?.step, track.state).toBe("track");
      expect(SWAP_CLOSED_STATES, track.state).not.toContain(stored().state);
      expect(stored().track?.state, track.state).toBe("PROVIDER_EXECUTING");
      expect(pending(), `${track.state}: its tick kept`).toBeTruthy();
      usdc = 25_000_000n;
      await runOrderTick(pending()!, { masterSeed: new Uint8Array(32).fill(7), deployment: null, io: io(tracker), now: () => LATER });
      expect(stored().track?.state, track.state).toBe("LATE_REFUND");
      expect(actionsFor(rec()!), `${track.state}: Return funds offered`).toContain("start-refund");
    }
  });

  it("a late refund held in the order's own asset while a refund token is not read: its legs decided, Return funds offered at once; a refunded job's too", () => {
    const s = put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const facts = {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      escrowBalance: AMOUNT / 2n,
      track: { state: "partial" } as never,
      refundFound: false,
      escrowExecuted: true,
      refundTokensHeld: null,
    };
    const late = deriveState(s, facts);
    expect(late.state).toBe("LATE_REFUND");
    expect(late.settlement, "its legs decided by the asset").toBe("REFUND_AVAILABLE");
    expect(legsOf(s, { ...facts, escrowBalance: 0n }), "the asset at dust: the token decides, and it was not read").toBeNull();
    expect(deriveState(s, { ...facts, job: job("refunded", { executionTx: EXEC }) }).state, "a refunded job's late refund in the asset").toBe("LATE_REFUND");
  });
});

describe("the eleventh critique (XK): the waiting readings' steps", () => {
  it("a completed job read again — its balance or a refund token not read — marks the destination sent only on the provider's word", () => {
    const s = put({ state: "executed", executionTx: EXEC, refundTokens: [USDC], refundFloors: { [USDC.toLowerCase()]: "1000000" } } as Partial<StoredSwap>);
    const base = { now: LATER, job: job("completed", { executionTx: EXEC }), refundFound: false, escrowExecuted: true };
    const cases: [string, boolean][] = [
      ["failed", false],
      ["refunded", false],
      ["executing", false],
      ["completed", true],
      ["destination-submitted", true],
      ["destination-final", true],
      ["partial", true],
    ];
    for (const [state, sent] of cases) {
      const tokens = deriveState(s, { ...base, track: { state } as never, escrowBalance: 0n, refundTokensHeld: null });
      expect([tokens.state, tokens.steps], state).toEqual(["PROVIDER_EXECUTING", [true, true, sent, false]]);
      const balance = deriveState(s, { ...base, track: { state } as never, escrowBalance: null });
      expect([balance.state, balance.steps], `${state}, its balance not read`).toEqual(["PROVIDER_EXECUTING", [true, true, sent, false]]);
    }
  });

  it("a completed job's delivery in another token after its late refund: one held in the order's asset is returned first, never closed Partial (XK)", () => {
    const s = put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const facts = {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      track: { state: "partial", deliveredAsset: "USDT" } as never,
      refundFound: false,
      escrowExecuted: true,
      refundTokensHeld: false,
    };
    expect(deriveState(s, { ...facts, escrowBalance: AMOUNT / 2n }).state, "a late refund in the asset").toBe("LATE_REFUND");
    expect(deriveState(s, { ...facts, escrowBalance: 0n }).state, "nothing back: the other token's delivery").toBe("PARTIAL");
  });
});

describe("the twelfth critique (XL) and after: a failed re-shield's words and its other-token delivery; the other-token Partial on an unread balance", () => {
  it("an executed order's failed re-shield with a refund token held: its tokens read, what sits in the escrow named — never closed Completed over it, never '0 ETH' (XN)", async () => {
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "lifi",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as Partial<StoredSwap>);
    let tokenReads = 0;
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: {
        job: async () => job("refund-failed", { executionTx: EXEC }),
        balance: async () => 0n,
        track: async () => ({ state: "completed" }) as never,
        tokenBalance: async () => (tokenReads++, 25_000_000n),
      },
    });
    expect(tokenReads, "its refund tokens read").toBeGreaterThan(0);
    expect(r.tracked.state, "a failed re-shield over a refund token held").toBe("FAILED");
    expect(r.tracked.detail).toMatch(/a refund in the route's refund token sits in the one-time escrow/);
    expect(r.tracked.detail, "the escrow's own call for it (XO)").toMatch(/anyone can call refundToken on the escrow for the refund token it holds after/);
    expect(r.tracked.detail).not.toMatch(/0 ETH/);
    expect(SWAP_CLOSED_STATES).not.toContain(stored().state);
  });

  it("a failed re-shield's other-token delivery is never closed Partial on the provider's word: read as its failed re-shield, closed once its refund note is found (XM, XP)", () => {
    const s = put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const other = { now: LATER, track: { state: "partial", deliveredAsset: "USDT" } as never, refundFound: false, escrowExecuted: true };
    for (const facts of [
      { escrowBalance: 0n, refundTokensHeld: true },
      { escrowBalance: null },
      { escrowBalance: AMOUNT / 2n },
      { escrowBalance: 0n, refundTokensHeld: false },
    ]) {
      const r = deriveState(s, { ...other, job: job("refund-failed", { executionTx: EXEC }), ...facts });
      expect(
        r.state,
        JSON.stringify(facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).toBe("FAILED");
    }
    // ... and its sentence offers what the card offers: its return, never "Confirm again" (a failed re-shield is never signed again; XP)
    expect(deriveState(s, { ...other, job: job("refund-failed", { executionTx: EXEC }), escrowBalance: 0n, refundTokensHeld: false }).detail).not.toMatch(
      /Confirm again/,
    );
    // ... the refund note found above dust: the partial delivery and its rest back
    const back = { ...s, refunds: [{ leafIndex: 9, vault: VAULT, amount: (AMOUNT / 2n).toString() }] } as StoredSwap;
    expect(deriveState(back, { ...other, job: job("refund-failed", { executionTx: EXEC }), escrowBalance: 0n, refundTokensHeld: false }).state).toBe("PARTIAL");
  });

  it("a failed re-shield naming no execution, its escrow's flag read executed: still a failed re-shield, never 'nothing comes back' nor a step lost (XP)", async () => {
    const step = { index: 0, state: "refunding", amount: AMOUNT.toString(), provider: "thorchain", orderId: ORDER } as unknown as Tranche;
    for (const track of ["refunded", "failed"]) {
      put({ state: "executing", executionTx: undefined } as Partial<StoredSwap>);
      let flagReads = 0;
      const r = await trackOrder(stored(), {
        deployment: null,
        session,
        now: LATER,
        readers: {
          job: async () => job("refund-failed"),
          balance: async () => 0n,
          track: async () => ({ state: track }) as never,
          executed: async () => (flagReads++, true),
          executionTx: async () => EXEC,
        },
      });
      expect(flagReads, `${track}: its flag read`).toBeGreaterThan(0);
      expect(r.tracked.state, track).toBe("FAILED");
      expect(SWAP_CLOSED_STATES, track).not.toContain(stored().state);
      const next = trancheStateOf(step, r.tracked, r.job, stored(), "fast" as never, "bitcoin", LATER, {});
      expect(next?.state, `${track}: never undelivered`).not.toBe("undelivered");
    }
  });

  it("an ended job (expired, a failed execution) its escrow's flag reads executed, before its executor's watch would have ended: read as executed — the provider's refund or failure over an escrow read empty awaited, never 'nothing more comes back' nor a step lost (XQ)", async () => {
    const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "thorchain", orderId: ORDER } as unknown as Tranche;
    // a minute past the window, its refund time two hours away; a minute past its refund time, inside the watch
    for (const now of [(DEADLINE_S + 60) * 1000, (DEADLINE_S + 7200 + 60) * 1000])
      for (const ended of ["expired", "execute-failed"] as const)
        for (const track of ["refunded", "failed"]) {
          put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
          const r = await reader({ job: job(ended), balance: 0n, executed: true, executionTx: EXEC, track: { state: track } }, now)(stored());
          const at = `${ended}, ${track}, ${now}`;
          expect(r.job?.state, at).toBe("executed");
          expect(["REFUND_PENDING", "DESTINATION_FAILED"], at).toContain(r.tracked.state);
          expect(SWAP_CLOSED_STATES, at).not.toContain(stored().state);
          const next = trancheStateOf(step, r.tracked, r.job, stored(), "fast" as never, "bitcoin", now, {});
          expect(next?.state, `${at}: never undelivered`).not.toBe("undelivered");
        }
    // ... and as a completed one once the watch would have ended: the provider's last word, the escrow read empty, settles it (C12-6)
    put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
    const late = await reader({ job: job("execute-failed"), balance: 0n, executed: true, executionTx: EXEC, track: { state: "failed" } }, LATER)(stored());
    expect(late.job?.state).toBe("completed");
    expect(late.tracked.state).toBe("PROVIDER_FAILED");
  });

  it("a failed execution's sentence offers it signed again or returned; a failed re-shield's, its return only (XQ)", () => {
    const s = put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const facts = { now: LATER, track: null, refundFound: false, refundTokensHeld: false };
    expect(deriveState(s, { ...facts, job: job("execute-failed"), escrowBalance: AMOUNT, escrowExecuted: false }).detail).toMatch(
      /^The execution failed: .* sits in the one-time escrow\. Confirm again with a fresh quote, or return it to your private balance; anyone can call deployAndRefund after /,
    );
    expect(deriveState(s, { ...facts, job: job("refund-failed", { executionTx: EXEC }), escrowBalance: AMOUNT / 2n, escrowExecuted: true }).detail).toMatch(
      /^The re-shield failed: .* sits in the one-time escrow\. Return it to your private balance; anyone can call deployAndRefund after /,
    );
  });

  it("a refund paid at the destination beside the order's own asset held, for a job that no longer re-shields: never closed at the destination — a late refund, or a failed re-shield's FAILED, its return offered; an executor still watching re-shields it itself (XQ)", () => {
    const step = { index: 0, state: "refunding", amount: AMOUNT.toString(), provider: "lifi", orderId: ORDER } as unknown as Tranche;
    const s = { ...put({ provider: "lifi", quote: { refundTarget: "destination" } } as Partial<StoredSwap>), refunds: [] } as StoredSwap;
    const facts = {
      now: LATER,
      escrowBalance: AMOUNT / 5n,
      track: { state: "refunded", refundedTo: "destination" } as never,
      refundFound: false,
      escrowExecuted: true,
      refundTokensHeld: false,
    };
    for (const [ended, reading] of [
      ["completed", "LATE_REFUND"],
      ["refunded", "LATE_REFUND"],
      ["refund-failed", "FAILED"],
    ] as const) {
      const tracked = deriveState(s, { ...facts, job: job(ended, { executionTx: EXEC }) });
      expect(tracked.state, ended).toBe(reading);
      expect(tracked.detail, ended).toMatch(/return it to your private balance/i);
      expect(trancheStateOf(step, tracked, job(ended), s, "fast" as never, "solana", LATER, {})?.state, ended).not.toBe("undelivered");
    }
    // ... the order's asset at dust, it closes at the destination as before; inside its watch, a refunded job's executor re-shields the leftover itself
    expect(deriveState(s, { ...facts, escrowBalance: 0n, job: job("completed", { executionTx: EXEC }) }).state).toBe("REFUNDED_AT_DESTINATION");
    expect(deriveState(s, { ...facts, now: (DEADLINE_S + 7200 + 60) * 1000, job: job("refunded", { executionTx: EXEC }) }).state).toBe(
      "REFUNDED_AT_DESTINATION",
    );
  });

  it("a refund paid at the destination says 'Nothing is left in the escrow.' only of an empty one: dust left there is said to be dust (XS, XU)", () => {
    const s = { ...put({ provider: "lifi", quote: { refundTarget: "destination" } } as Partial<StoredSwap>), refunds: [] } as StoredSwap;
    const facts = {
      now: LATER,
      track: { state: "refunded", refundedTo: "destination" } as never,
      refundFound: false,
      escrowExecuted: true,
      refundTokensHeld: false,
      job: job("completed", { executionTx: EXEC }),
    };
    const empty = deriveState(s, { ...facts, escrowBalance: 0n });
    expect(empty.state).toBe("REFUNDED_AT_DESTINATION");
    expect(empty.detail).toMatch(/not to the pool\. Nothing is left in the escrow\.$/);
    for (const left of [AMOUNT / 200n, 1n]) {
      const dust = deriveState(s, { ...facts, escrowBalance: left });
      expect(dust.state, String(left)).toBe("REFUNDED_AT_DESTINATION");
      expect(dust.detail, String(left)).toMatch(/not to the pool\. Nothing above dust is left in the escrow\.$/);
    }
  });

  it("a refund paid at the destination beside the order's own asset held, its relayer not answering this time: read again, never closed — the late refund offered once it answers; at dust it closes (XU)", async () => {
    put({ state: "executed", executionTx: EXEC, provider: "lifi", quote: { refundTarget: "destination" } } as Partial<StoredSwap>);
    const facts = { balance: AMOUNT / 5n, track: { state: "refunded", refundedTo: "destination" }, tokenBalance: 0n };
    const first = await reader({ ...facts, job: job("completed", { executionTx: EXEC }) }, LATER)(stored());
    expect(first.tracked.state).toBe("LATE_REFUND");
    const down = await reader({ ...facts, job: null }, LATER)(stored());
    expect(down.tracked.state, "read again").toBe("PROVIDER_EXECUTING");
    expect(SWAP_CLOSED_STATES, "never closed on it").not.toContain(stored().state);
    const back = await reader({ ...facts, job: job("completed", { executionTx: EXEC }) }, LATER)(stored());
    expect(back.tracked.state).toBe("LATE_REFUND");
    const atDust = await reader({ ...facts, balance: 0n, job: null }, LATER)(stored());
    expect(atDust.tracked.state, "nothing left: closed at the destination").toBe("REFUNDED_AT_DESTINATION");
  });

  it("an ended job its escrow's flag read executed, then not read: still read as executed — never back to its own words, its step never failed on one endpoint down (XU)", async () => {
    const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "thorchain", orderId: ORDER } as unknown as Tranche;
    const now = (DEADLINE_S + 60) * 1000;
    for (const ended of ["expired", "execute-failed"] as const) {
      put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
      const read: string[] = [];
      for (const flagRead of [true, null, true, null]) {
        const r = await reader(
          { job: job(ended), balance: 0n, executed: flagRead, executionTx: EXEC, track: { state: "destination-submitted" } },
          now,
        )(stored());
        read.push(`${r.job?.state} ${r.tracked.state}`);
        expect(trancheStateOf(step, r.tracked, r.job, stored(), "fast" as never, "bitcoin", now, {})?.state, `${ended}, ${flagRead}`).not.toBe("failed");
      }
      expect(new Set(read).size, `${ended}: ${read.join(", ")}`).toBe(1);
      expect(stored().state, ended).toBe("executed");
      // ... and a flag read true whose Executed event could not be found, then not read: still executed (XV: kept by the event's search alone, it was lost)
      put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
      const seen = await reader({ job: job(ended), balance: 0n, executed: true, executionTx: null, track: { state: "destination-submitted" } }, now)(stored());
      const unread = await reader(
        { job: job(ended), balance: 0n, executed: null, executionTx: null, track: { state: "destination-submitted" } },
        now,
      )(stored());
      expect([seen.job?.state, unread.job?.state], `${ended}: no event found`).toEqual(["executed", "executed"]);
      // ... but every endpoint reading it not executed is the chain's word over the journal's (a reorg can take an execution back): the job's own
      const back = await reader({ job: job(ended), balance: 0n, executed: false, executionTx: EXEC, track: { state: "destination-submitted" } }, now)(stored());
      expect(back.job?.state, `${ended}: read not executed`).toBe(ended);
      // ... and that read takes the mark away: a flag not read after it is no executed escrow either
      const after = await reader({ job: job(ended), balance: 0n, executed: null, executionTx: null, track: { state: "destination-submitted" } }, now)(stored());
      expect(after.job?.state, `${ended}: not read after the false read`).toBe(ended);
    }
  });

  it("on a read where the relayer did not answer, an escrow its flag says never executed has no refund token read: its refund in full stands, whatever was sent there since (XV)", async () => {
    put({
      state: "executing",
      executionTx: undefined,
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
      refunds: [{ leafIndex: 78, vault: VAULT, amount: AMOUNT.toString() }],
    } as Partial<StoredSwap>);
    let tokenReads = 0;
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: { job: async () => null, balance: async () => 0n, executed: async () => false, tokenBalance: async () => (tokenReads++, 25_000_000n) },
    });
    expect(tokenReads, "no token asked of an escrow that never executed").toBe(0);
    expect(r.tracked.state).toBe("REFUNDED");
  });

  it("the escrow's flag read true is kept over every read that cannot tell — two failed reads in a row, a read where the relayer did not answer — never only the next one (XW)", async () => {
    const step = { index: 0, state: "executing", amount: AMOUNT.toString(), provider: "thorchain", orderId: ORDER } as unknown as Tranche;
    const now = (DEADLINE_S + 60) * 1000;
    for (const ended of ["expired", "execute-failed"] as const) {
      for (const middle of ["flag not read", "relayer down"] as const) {
        put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
        const facts = { balance: 0n, executionTx: null, track: { state: "destination-submitted" } };
        const reads = [
          await reader({ ...facts, job: job(ended), executed: true }, now)(stored()),
          await reader({ ...facts, job: middle === "relayer down" ? null : job(ended), executed: null }, now)(stored()),
          await reader({ ...facts, job: job(ended), executed: null }, now)(stored()),
        ];
        for (const [i, r] of reads.entries()) {
          if (middle === "relayer down" && i === 1) continue; // its own reading: the executor did not answer
          const at = `${ended}, ${middle}, read ${i + 1}`;
          expect(r.job?.state, at).toBe("executed");
          expect(trancheStateOf(step, r.tracked, r.job, stored(), "fast" as never, "bitcoin", now, {})?.state, at).not.toBe(
            ended === "expired" ? "refunding" : "failed",
          );
        }
      }
    }
  });

  it("an order no executor was handed, delivered in another token: said Partial beside its own asset held or its balance not read — no relayer to wait for (stated; XW)", async () => {
    for (const balance of [AMOUNT / 5n, null]) {
      put({ state: "executed", executionTx: EXEC, jobId: undefined, relayerUrl: undefined } as Partial<StoredSwap>);
      const r = await reader({ job: null, balance, track: { state: "partial", deliveredAsset: "USDT" } }, LATER)(stored());
      expect(r.tracked.state, String(balance)).toBe("PARTIAL");
    }
  });

  it("a relayer's refunded job naming no execution, its escrow's flag read true (no event found) then not read: never Refunded in full — the execution looked for again, the order open (XW)", async () => {
    put({ state: "executed", executionTx: undefined, refunds: [{ leafIndex: 79, vault: VAULT, amount: (AMOUNT / 2n).toString() }] } as Partial<StoredSwap>);
    const first = await reader({ job: job("refunded"), balance: 0n, executionTx: null, executed: true }, LATER)(stored());
    expect(first.tracked.state).toBe("PROVIDER_EXECUTING");
    const second = await reader({ job: job("refunded"), balance: 0n, executionTx: null, executed: null }, LATER)(stored());
    expect(second.tracked.state, "never a refund in full").not.toBe("REFUNDED");
    expect(SWAP_CLOSED_STATES).not.toContain(stored().state);
  });

  it("a relayer's refunded job naming no execution past its watch, a refund token held: a late refund to return, on the read that found the flag true and on the next one that could not read it (XW)", async () => {
    put({ state: "executed", executionTx: undefined, refundTokens: [USDC], refundFloors: { [USDC.toLowerCase()]: "1000000" } } as Partial<StoredSwap>);
    const facts = { job: job("refunded"), balance: 0n, executionTx: null, tokenBalance: 25_000_000n };
    const first = await reader({ ...facts, executed: true }, LATER)(stored());
    expect(first.tracked.state).toBe("LATE_REFUND");
    const second = await reader({ ...facts, executed: null }, LATER)(stored());
    expect(second.tracked.state, "its token read on the flag's failed read").toBe("LATE_REFUND");
  });

  it("a failed re-shield naming no execution, its escrow's flag read true (no event found) then not read, a refund token held: FAILED on both reads, naming the token and refundToken — with or without a refund note (XX)", async () => {
    for (const refunds of [[], [{ leafIndex: 81, vault: VAULT, amount: (AMOUNT / 2n).toString() }]]) {
      put({
        state: "executed",
        executionTx: undefined,
        refundTokens: [USDC],
        refundFloors: { [USDC.toLowerCase()]: "1000000" },
        refunds,
      } as Partial<StoredSwap>);
      for (const executed of [true, null]) {
        const r = await reader({ job: job("refund-failed"), balance: 0n, executionTx: null, tokenBalance: 25_000_000n, executed }, LATER)(stored());
        const at = `${refunds.length ? "a note found" : "no note"}, flag ${executed}`;
        expect(r.tracked.state, at).toBe("FAILED");
        expect(r.tracked.detail, at).toMatch(
          /a refund in the route's refund token sits in the one-time escrow.*anyone can call refundToken on the escrow for the refund token it holds/,
        );
      }
    }
  });

  it("an escrow whose flag was never read true gets no mark from reads that cannot tell: an expired job or a failed execution keeps its own reading (XX)", async () => {
    for (const ended of ["expired", "execute-failed"] as const) {
      for (const middle of ["flag not read", "relayer down"] as const) {
        put({ state: "funded", executionTx: undefined } as Partial<StoredSwap>);
        const facts = { balance: AMOUNT, executionTx: null, executed: null };
        const reads = [
          await reader({ ...facts, job: job(ended) }, LATER)(stored()),
          await reader({ ...facts, job: middle === "relayer down" ? null : job(ended) }, LATER)(stored()),
          await reader({ ...facts, job: job(ended) }, LATER)(stored()),
        ];
        for (const [i, r] of reads.entries())
          if (!(middle === "relayer down" && i === 1)) expect(r.job?.state, `${ended}, ${middle}, read ${i + 1}`).toBe(ended);
        expect(stored().escrowExecutedSeen, `${ended}, ${middle}: no mark`).toBeUndefined();
      }
    }
  });

  it("on a read where the relayer did not answer, its escrow's flag read true before and not read now: its refund tokens read, a held one keeping the order open and its settlement unsettled (XW)", async () => {
    put({
      state: "executed",
      executionTx: undefined,
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
      refunds: [{ leafIndex: 80, vault: VAULT, amount: (AMOUNT / 2n).toString() }],
    } as Partial<StoredSwap>);
    await reader({ job: job("expired"), balance: 0n, executed: true, executionTx: null, tokenBalance: 25_000_000n }, LATER)(stored());
    let tokenReads = 0;
    const r = await trackOrder(stored(), {
      deployment: null,
      session,
      now: LATER,
      readers: { job: async () => null, balance: async () => 0n, executed: async () => null, tokenBalance: async () => (tokenReads++, 25_000_000n) },
    });
    expect(tokenReads, "its tokens read").toBeGreaterThan(0);
    expect(r.tracked.state).not.toBe("REFUNDED");
    expect(r.tracked.settlement).not.toBe("COMPLETED");
  });

  it("a failed re-shield of an ETH order whose refund came back in wrapped ETH names it, and deployAndRefund — never refundToken, which refuses the order's own (XU)", async () => {
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const deployment1 = {
      chainId: 1,
      rpcUrl: "http://rpc1.test",
      rpcUrls: ["http://rpc1.test", "http://rpc2.test"],
      fromBlock: 0n,
      ethVault: VAULT,
    } as unknown as Deployment;
    const r = await trackOrder(stored(), {
      deployment: deployment1,
      session,
      now: LATER,
      readers: {
        job: async () => job("refund-failed", { executionTx: EXEC }),
        balance: async () => 0n,
        executed: async () => true,
        track: async () => ({ state: "refunded" }) as never,
        tokenBalance: async (_s, token) => (token.toLowerCase() === WRAPPED_NATIVE_OF[1].toLowerCase() ? 5n * 10n ** 17n : 0n),
      },
    });
    expect(r.tracked.state).toBe("FAILED");
    expect(r.tracked.detail).toMatch(
      /The re-shield failed: 0\.5 WETH sits in the one-time escrow\. Return it to your private balance; anyone can call deployAndRefund after /,
    );
  });

  it("C12-6's substituted job reads executed until the executor's 24-hour watch past the refund time has ended, completed from that second (XU)", async () => {
    const refundAfter = DEADLINE_S + 7200;
    for (const [at, want] of [
      [refundAfter + 86_400 - 60, "executed"],
      [refundAfter + 86_400, "completed"],
    ] as const) {
      put({ state: "executed", executionTx: undefined } as Partial<StoredSwap>);
      const r = await reader({ job: job("expired"), balance: 0n, executed: true, executionTx: EXEC, track: { state: "completed" } }, at * 1000)(stored());
      expect(r.job?.state, String(at)).toBe(want);
    }
  });

  it("a refunded job's leftover is its executor's until the 24-hour watch past the refund time ends, the user's from that second — at the destination and in the escrow; inside it the closed record's settlement is the destination's (XU)", () => {
    const refundAfter = DEADLINE_S + 7200;
    const inside = (refundAfter + 86_400 - 60) * 1000;
    const past = (refundAfter + 86_400) * 1000;
    const facts = {
      escrowBalance: AMOUNT / 5n,
      refundFound: false,
      escrowExecuted: true,
      refundTokensHeld: false,
      job: job("refunded", { executionTx: EXEC }),
    };
    const dest = { ...put({ provider: "lifi", quote: { refundTarget: "destination" } } as Partial<StoredSwap>), refunds: [] } as StoredSwap;
    const destTrack = { state: "refunded", refundedTo: "destination" } as never;
    const closed = deriveState(dest, { ...facts, track: destTrack, now: inside });
    expect([closed.state, closed.settlement]).toEqual(["REFUNDED_AT_DESTINATION", "COMPLETED"]);
    const destPast = deriveState(dest, { ...facts, track: destTrack, now: past });
    expect([destPast.state, destPast.settlement]).toEqual(["LATE_REFUND", "REFUND_AVAILABLE"]);
    // ... its refund tokens not read this time: read again, its legs never settled on it (XV)
    const unread = deriveState(dest, { ...facts, refundTokensHeld: null, track: destTrack, now: inside });
    expect([unread.state, unread.settlement]).toEqual(["PROVIDER_EXECUTING", "REFUNDING"]);
    // ... a refund token held there instead, inside the watch: its executor's to re-shield, never closed — the legs say so too
    const token = deriveState(dest, { ...facts, escrowBalance: 0n, refundTokensHeld: true, refundTokensHeldAs: "25 USDC", track: destTrack, now: inside });
    expect([token.state, token.settlement]).toEqual(["REFUND_PENDING", "REFUNDING"]);
    const escrow = { ...put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>), refunds: [] } as StoredSwap;
    const escrowInside = deriveState(escrow, { ...facts, track: { state: "refunded" } as never, now: inside });
    expect([escrowInside.state, escrowInside.settlement]).toEqual(["REFUND_PENDING", "REFUNDING"]);
    const escrowPast = deriveState(escrow, { ...facts, track: { state: "refunded" } as never, now: past });
    expect([escrowPast.state, escrowPast.settlement]).toEqual(["LATE_REFUND", "REFUND_AVAILABLE"]);
  });

  it("on a read where the relayer did not answer, a refund token held keeps the order open — never Refunded, never closed at the destination, never an other-token Partial beside the order's asset held — and the late refund is offered once it answers; an order no executor was handed closes at the destination at once (XV)", async () => {
    const withToken = { refundTokens: [USDC], refundFloors: { [USDC.toLowerCase()]: "1000000" } } as Partial<StoredSwap>;
    // (a) half the order re-shielded (its note found), 25 USDC held since
    put({
      state: "executed",
      executionTx: EXEC,
      ...withToken,
      refunds: [{ leafIndex: 77, vault: VAULT, amount: (AMOUNT / 2n).toString() }],
    } as Partial<StoredSwap>);
    const a = await reader({ job: null, balance: 0n, track: { state: "refunded" }, tokenBalance: 25_000_000n }, LATER)(stored());
    expect(a.tracked.state, "(a) never Refunded").not.toBe("REFUNDED");
    expect(SWAP_CLOSED_STATES, "(a)").not.toContain(stored().state);
    // (b) a refund paid at the destination, the order's asset at nothing, 25 USDC held
    put({ state: "executed", executionTx: EXEC, provider: "lifi", quote: { refundTarget: "destination" }, ...withToken } as Partial<StoredSwap>);
    const dest = { state: "refunded", refundedTo: "destination" };
    const b = await reader({ job: null, balance: 0n, track: dest, tokenBalance: 25_000_000n }, LATER)(stored());
    expect(b.tracked.state, "(b) never closed").not.toBe("REFUNDED_AT_DESTINATION");
    expect(SWAP_CLOSED_STATES, "(b)").not.toContain(stored().state);
    const answered = await reader({ job: job("completed", { executionTx: EXEC }), balance: 0n, track: dest, tokenBalance: 25_000_000n }, LATER)(stored());
    expect(answered.tracked.state, "(b) answered").toBe("LATE_REFUND");
    // (c) a delivery in another token beside 0.2 ETH held
    put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const c = await reader({ job: null, balance: AMOUNT / 5n, track: { state: "partial", deliveredAsset: "USDT" }, tokenBalance: 0n }, LATER)(stored());
    expect(c.tracked.state, "(c) no Partial yet").not.toBe("PARTIAL");
    // ... no executor handed: closed at the destination at once (stated)
    put({
      state: "executed",
      executionTx: EXEC,
      provider: "lifi",
      quote: { refundTarget: "destination" },
      jobId: undefined,
      relayerUrl: undefined,
    } as Partial<StoredSwap>);
    const none = await reader({ job: null, balance: AMOUNT / 5n, track: dest }, LATER)(stored());
    expect(none.tracked.state, "no executor handed").toBe("REFUNDED_AT_DESTINATION");
  });

  it("a completed job's delivery in another token with its balance not read: read again, never closed Partial", () => {
    const s = put({ state: "executed", executionTx: EXEC } as Partial<StoredSwap>);
    const r = deriveState(s, {
      now: LATER,
      job: job("completed", { executionTx: EXEC }),
      track: { state: "partial", deliveredAsset: "USDT" } as never,
      refundFound: false,
      escrowExecuted: true,
      escrowBalance: null,
      refundTokensHeld: false,
    });
    expect(r.state).toBe("PROVIDER_EXECUTING");
  });
});
