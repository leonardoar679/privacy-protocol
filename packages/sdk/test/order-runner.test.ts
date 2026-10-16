// The order runner (spec v2.0 §7.6; the owner's one confirmation): against a scripted world — the escrow, the executor,
// the tracker, the hard quote's minimum — a confirmed order is funded, then signed and handed over in one tick while its
// minimum holds, then tracked to its end; one signature, one hand-over, one funding. A moved minimum waits as
// QUOTE_EXPIRED until the user accepts it or returns the funds; a funding whose outcome is unknown is reconciled from the
// escrow and never sent twice; a hand-over another tab made is found by orderId; a failure before anything was sent goes
// to the scheduler's backoff; "Delay for more privacy" funds no earlier than its drawn time; a campaign's tranche is
// never run here. The operation record follows every step. V6 Stage 12: a same-chain swap into the protected balance has
// its shield job asked while it is tracked (registered again when the executor forgot it), and its delivered note looked
// for once the executor reports a shield; the order completes on that note.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { ScheduledAction, StoredSwap } from "../src/wallet/journal";
import type { ShieldJob, SwapJob } from "../src/relayer";
import type { OrderState, Tracked } from "../src/orderTracker";
import type { Signed } from "../src/swapExecute";
import { MinimumMoved, ProviderCallUnverified } from "../src/providerCall";
import { OlderNotesUnavailable } from "../src/privateTx";
import { RelayerNotReady } from "../src/swapFunding";
import { FUNDING_MARGIN_MS, patchSwap, type FundingFate } from "../src/swapFunding";
import { actionsFor } from "../src/operations/recovery";
import { getOperation, resetOperationsMemory } from "../src/operations/store";
import { swapRecordId } from "../src/operations/swapRecords";
import type { Prepared } from "../src/swapService";
import {
  acceptNewMinimum,
  ACCEPTED_CALL_MARGIN_MS,
  DELAY_FOR_PRIVACY,
  resetOrderRunnerMemory,
  returnFunds,
  retryOrder,
  runOrderTick,
  type OrderIo,
} from "../src/wallet/orderRunner";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  session.update((j) => {
    j.swaps = [];
    j.schedule = [];
    j.operations = [];
  });
  resetOperationsMemory();
});

const ORDER = "0x" + "ab".repeat(32);
const AMOUNT = 10n ** 18n;
const T0 = Date.parse("2026-10-13T12:00:00Z");

function order(extra: Partial<StoredSwap> = {}): StoredSwap {
  const s: StoredSwap = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: AMOUNT.toString(),
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      slippageBps: 50,
    },
    params: { amount: AMOUNT.toString() },
    endpoint: "0x00000000000000000000000000000000000000e5",
    quote: { provider: "thorchain", toAmount: "3000000", toAmountMin: "2970000" },
    approvedMin: "2970000",
    createdAt: T0,
    state: "committed",
    refundNoteData: "0x00",
    runner: { confirmedAt: T0 },
    ...extra,
  } as StoredSwap;
  session.update((j) => {
    j.swaps = [...j.swaps.filter((x) => x.orderId !== s.orderId), s];
  });
  return s;
}
const action = (dueAt = T0): ScheduledAction => ({ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt });
const pending = () => session.journal().schedule.find((a) => a.id === `order-tick:${ORDER}`);
const stored = () => session.journal().swaps.find((x) => x.orderId === ORDER)!;
const record = () => getOperation(swapRecordId(ORDER));

/** The world the runner observes and moves: the escrow, the executor, the tracker and the hard quote's minimum. */
function world(
  o: {
    minOut?: bigint;
    simOk?: boolean;
    fund?: "ok" | "fails-before" | "fails-after" | "older-gone" | "relayer-not-ready" | "dropped";
    handOver?: "ok" | "lost";
  } = {},
) {
  const w = {
    escrow: 0n,
    /** the escrow's balance cannot be read */
    escrowUnread: false,
    job: null as SwapJob | null,
    funds: 0,
    signs: 0,
    handOvers: 0,
    refunds: 0,
    track: "PROVIDER_EXECUTING" as OrderState,
    minOut: o.minOut ?? 2_970_000n,
    simOk: o.simOk ?? true,
    fund: o.fund ?? "ok",
    handOver: o.handOver ?? "ok",
    shield: null as ShieldJob | null,
    shieldRegistrations: 0,
    shieldRecoveries: 0,
    /** what each signing was handed to reuse (null: a fresh quote) */
    reused: [] as (Prepared | null)[],
    /** a fresh call is valid this long */
    validSeconds: 600,
  };
  const io: OrderIo = {
    fund: async (st, onStatus) => {
      w.funds++;
      if (w.fund === "fails-before") throw new TypeError("fetch failed");
      if (w.fund === "older-gone") throw new OlderNotesUnavailable(st.runner?.maxTiming ?? 0);
      if (w.fund === "relayer-not-ready") throw new RelayerNotReady("the relayer does not run the swap service's orders");
      onStatus("Withdrawing privately: handing it to the relayer…");
      if (w.fund === "dropped") throw new Error("Timed out while waiting for the transaction to be confirmed"); // sent, never mined
      w.escrow = AMOUNT;
      if (w.fund === "fails-after") throw new TypeError("fetch failed");
      patchSwap(st.orderId, { fundedTx: "0xf00d", state: "funded" });
      return { txHash: "0xf00d" };
    },
    escrowBalance: async () => (w.escrowUnread ? null : w.escrow),
    sign: async (st, reuse) => {
      w.signs++;
      w.reused.push(reuse ?? null);
      const approved = BigInt(st.approvedMin ?? "0");
      // a fresh call guarantees the market's minimum now (carried in its calldata here); a reused one, the minimum it had
      const call: Prepared = reuse ?? {
        digest: `0x${w.signs.toString(16).padStart(64, "0")}`,
        provider: "0x00000000000000000000000000000000000000ee",
        value: "0",
        calldata: `0x${w.minOut.toString(16)}`,
        deadline: Math.floor(T0 / 1000) + w.validSeconds,
      };
      const minOut = BigInt(call.calldata);
      if (minOut < approved) return { moved: new MinimumMoved(minOut, approved), prepared: call };
      return { sim: w.simOk ? { ok: true, gas: 1n } : { ok: false, reason: "the provider call reverts" }, label: "signed" } as unknown as Signed;
    },
    handOver: async (st) => {
      w.handOvers++;
      w.job = { id: "job-1", escrow: st.endpoint as `0x${string}`, state: "executing", updatedAt: T0 } as SwapJob;
      if (w.handOver === "lost") throw new TypeError("fetch failed");
      patchSwap(st.orderId, { jobId: w.job.id, state: w.job.state });
      return { job: w.job };
    },
    job: async () => w.job,
    track: async () => ({ tracked: { state: w.track, label: "Executing", steps: [true, true, false, false], detail: "" } as Tracked, job: w.job }),
    refund: async (st) => {
      w.refunds++;
      w.job = { id: "refund-1", escrow: st.endpoint as `0x${string}`, state: "refunding", updatedAt: T0 } as SwapJob;
      return w.job;
    },
    shieldStatus: async () => w.shield,
    registerShield: async (st) => {
      w.shieldRegistrations++;
      w.shield = { id: st.shield!.params.receiptId, receiver: st.shield!.receiver as `0x${string}`, state: "waiting-delivery", updatedAt: T0 };
      return w.shield;
    },
    recoverShield: async (st) => {
      w.shieldRecoveries++;
      const last = w.shield?.shields?.[w.shield.shields.length - 1];
      if (last?.leafIndex === undefined) return 0;
      patchSwap(st.orderId, {
        shield: { ...st.shield!, leaves: [{ leafIndex: last.leafIndex, vault: "0x00000000000000000000000000000000000000e1", amount: last.amount ?? "0" }] },
      });
      return 1;
    },
  };
  return { w, io };
}
const deps = (io: OrderIo, now = T0) => ({ masterSeed: new Uint8Array(32), deployment: null, io, now: () => now });
/** Run the ticks the runner plans, as the scheduler would, until it stops planning or `max` ticks ran. */
async function drive(io: OrderIo, max = 10, from = T0): Promise<string[]> {
  const steps: string[] = [];
  let now = from;
  for (let i = 0; i < max; i++) {
    const a = pending();
    if (!a || a.done) break;
    now = Math.max(now, a.dueAt);
    const r = await runOrderTick(a, deps(io, now));
    steps.push(r?.step ?? "none");
    const again = pending();
    if (again && again.dueAt === a.dueAt) break; // not re-planned: the scheduler would mark it done
  }
  return steps;
}

describe("the order runner (spec v2.0 §7.6: one confirmation)", () => {
  it("funds, then signs and hands over in one tick while the minimum holds, then tracks to the end: one funding, one signature, one hand-over", async () => {
    order();
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    expect(await drive(io, 3)).toEqual(["funded", "handed-over", "track"]);
    expect([w.funds, w.signs, w.handOvers]).toEqual([1, 1, 1]);
    expect(stored()).toMatchObject({ fundedTx: "0xf00d", jobId: "job-1", state: "executing" });
    w.track = "COMPLETED";
    w.job = { ...w.job!, state: "completed" };
    expect(await drive(io, 2, T0 + 60_000)).toEqual(["settled"]);
    expect(pending(), "the order's ticks end with it").toBeUndefined();
    expect(record()).toMatchObject({ kind: "cross-chain", state: "COMPLETED" });
    expect(
      record()!.history.map((h) => h.state),
      "journaled without confirmOrder here: the record starts at the funding",
    ).toEqual(["SUBMITTED", "EXECUTING", "COMPLETED"]);
  });

  it("a moved minimum waits for the user — QUOTE_EXPIRED, nothing signed at the lower minimum —; accepting it signs once at the new minimum", async () => {
    order({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ minOut: 2_900_000n });
    w.escrow = AMOUNT;
    expect(await drive(io, 3)).toEqual(["paused"]);
    expect(stored().paused).toMatchObject({ code: "minimum_moved", minOut: "2900000", approved: "2970000" });
    expect(record()).toMatchObject({ state: "QUOTE_EXPIRED", reason: { code: "minimum_moved", fundsClass: "still-protected" } });
    expect(pending(), "no tick until the user decides").toBeUndefined();
    expect(w.handOvers).toBe(0);
    expect(acceptNewMinimum(ORDER, session, T0 + 1000)).toBe(true);
    expect(stored()).toMatchObject({ approvedMin: "2900000" });
    expect(stored().paused).toBeUndefined();
    expect(await drive(io, 2, T0 + 1000)).toEqual(["handed-over", "track"]);
    expect([w.signs, w.handOvers]).toEqual([2, 1]);
    expect(record()!.state).toBe("EXECUTING");
  });

  it("audit gap 43: 'Accept new minimum' signs the very call whose minimum was accepted while it stays valid — a market still moving asks once", async () => {
    order({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ minOut: 2_900_000n });
    w.escrow = AMOUNT;
    expect(await drive(io, 3)).toEqual(["paused"]);
    w.minOut = 2_850_000n; // the market keeps moving the same way: a fresh quote would be lower again
    expect(acceptNewMinimum(ORDER, session, T0 + 1000)).toBe(true);
    expect(await drive(io, 2, T0 + 1000)).toEqual(["handed-over", "track"]);
    expect(w.reused, "the first signing quoted; the second checked and signed the accepted call").toEqual([
      null,
      expect.objectContaining({ calldata: "0x2c4020" }),
    ]);
    expect([w.signs, w.handOvers]).toEqual([2, 1]);
  });

  it("audit gap 43: an accepted call too close to its deadline, or forgotten by a lock, is quoted afresh — and a lower minimum asks again", async () => {
    order({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ minOut: 2_900_000n });
    w.escrow = AMOUNT;
    expect(await drive(io, 3)).toEqual(["paused"]);
    w.minOut = 2_850_000n;
    const late = T0 + 600_000 - ACCEPTED_CALL_MARGIN_MS + 1000; // less than the margin left before the call's deadline
    expect(acceptNewMinimum(ORDER, session, late)).toBe(true);
    expect(await drive(io, 1, late)).toEqual(["paused"]);
    expect(w.reused.at(-1)).toBeNull();
    expect(stored().paused).toMatchObject({ code: "minimum_moved", minOut: "2850000", approved: "2900000" });
    resetOrderRunnerMemory(); // a lock forgets the call
    w.minOut = 2_800_000n;
    expect(acceptNewMinimum(ORDER, session, late + 1000)).toBe(true);
    expect(await drive(io, 1, late + 1000)).toEqual(["paused"]);
    expect(w.reused.at(-1)).toBeNull();
    expect(w.handOvers, "nothing is signed below an accepted minimum").toBe(0);
  });

  it("a refunded order asks for a note scan at once — its refund note reaches the balance — and plans no more ticks", async () => {
    order({ fundedTx: "0xf00d", state: "refunding", jobId: "refund-1" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    w.job = { id: "refund-1", escrow: "0x00000000000000000000000000000000000000e5", state: "refunded", updatedAt: T0 } as SwapJob;
    w.track = "REFUNDED";
    expect((await runOrderTick(action(), deps(io)))?.step).toBe("settled");
    expect(session.journal().schedule.find((a) => a.id === "discovery:pool")).toMatchObject({ kind: "discovery", dueAt: T0 });
    expect(pending()).toBeUndefined();
  });

  it("'Return funds' from the pause: a funded order goes back through its refund-only job; one never funded is abandoned", async () => {
    order({ fundedTx: "0xf00d", state: "funded", paused: { code: "minimum_moved", minOut: "1", approved: "2970000", at: T0 } });
    const { w, io } = world();
    expect(await returnFunds(ORDER, deps(io))).toBe("refunding");
    expect(w.refunds).toBe(1);
    expect(stored()).toMatchObject({ jobId: "refund-1", state: "refunding" });
    expect(stored().paused).toBeUndefined();
    expect(record()!.state).toBe("REFUNDING");
    session.update((j) => {
      j.swaps = [];
    });
    resetOperationsMemory();
    order();
    const fresh = world();
    expect(await returnFunds(ORDER, deps(fresh.io))).toBe("abandoned");
    expect(fresh.w.refunds).toBe(0);
    expect(stored().state).toBe("abandoned");
    expect(record()!.state).toBe("CANCELLED");
  });

  it("a funding whose outcome is unknown is reconciled from the escrow and never sent again; a failure before sending goes to the backoff", async () => {
    order();
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ fund: "fails-after" });
    expect(await drive(io, 1)).toEqual(["paused"]);
    expect(stored().paused?.code).toBe("reconcile");
    expect(record()).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "reconcile" } });
    // the reload: the next tick reads the escrow (funded), signs and hands over — the withdrawal is not sent twice
    expect(await drive(io, 3, T0 + 20_000)).toEqual(["funded", "handed-over", "track"]);
    expect(w.funds).toBe(1);
    expect(stored().paused).toBeUndefined();
    // a failure before anything was sent: thrown to the scheduler (its backoff retries the tick), nothing paused
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    resetOperationsMemory();
    order();
    const before = world({ fund: "fails-before" });
    await expect(runOrderTick(action(), deps(before.io))).rejects.toThrow("fetch failed");
    expect(stored().paused).toBeUndefined();
    expect(before.w.escrow).toBe(0n);
  });

  it("a funding sent and never confirmed stops once the order can no longer execute: past its deadline, the escrow read and empty", async () => {
    // a dropped funding transaction (2026-10-14): the reconcile pause had read the escrow for good, the record "Reconciling"
    const deadline = Math.floor(T0 / 1000) + 1800;
    order({ params: { amount: AMOUNT.toString(), executeDeadline: deadline, refundAfter: deadline + 7200 } } as Partial<StoredSwap>);
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ fund: "dropped" });
    expect(await drive(io, 1)).toEqual(["paused"]);
    expect(stored().paused?.code).toBe("reconcile");
    // before the deadline the escrow is still watched, and nothing is sent again
    expect((await runOrderTick(pending()!, deps(io, deadline * 1000 - 1_000)))?.step).toBe("paused");
    // past it, an unread escrow decides nothing
    w.escrowUnread = true;
    expect((await runOrderTick(pending()!, deps(io, deadline * 1000 + 1_000)))?.step).toBe("paused");
    expect(stored().paused?.code).toBe("reconcile");
    // read and empty: the order stops, never funded again; the record says the funds are still protected
    w.escrowUnread = false;
    expect((await runOrderTick(pending()!, deps(io, deadline * 1000 + 2_000)))?.step).toBe("stopped");
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "funding_unconfirmed" } });
    expect(record()).toMatchObject({ state: "CANCELLED", reason: { code: "funding_unconfirmed", fundsClass: "still-protected" } });
    expect(pending(), "no more ticks").toBeUndefined();
    expect(w.funds).toBe(1);
  });
  it("a funding already sent is never sent again on its own: a reload while it may land waits; a dead one stops the order", async () => {
    // a reload during a funding (2026-10-14): nothing paused, the escrow still empty, so the runner had sent a second one
    order({ fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 } } as Partial<StoredSwap>);
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    let fate: FundingFate = "pending";
    io.fundingFate = async () => fate;
    expect(await drive(io, 1)).toEqual(["paused"]);
    expect(w.funds, "nothing sent again while it may land").toBe(0);
    expect(stored().paused?.code).toBe("reconcile");
    expect(record()).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "reconcile" } });
    // its notes are spent: the escrow follows, and the runner waits for it
    fate = "landed";
    expect((await runOrderTick(pending()!, deps(io, T0 + 20_000)))?.step).toBe("paused");
    w.escrow = AMOUNT;
    expect((await runOrderTick(pending()!, deps(io, T0 + 40_000)))?.step).toBe("funded");
    expect(w.funds).toBe(0);
    // another order whose funding is dead (its notes unspent, no relayer job, past FUNDING_SETTLE_MS): stopped at once,
    // never funded again on its own (plan §86) — still protected, "Review the swap again"
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    resetOperationsMemory();
    order({ fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 } } as Partial<StoredSwap>);
    const dead = world();
    dead.io.fundingFate = async () => "dead";
    expect(await drive(dead.io, 1)).toEqual(["stopped"]);
    expect(dead.w.funds).toBe(0);
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "funding_unconfirmed" } });
    expect(record()).toMatchObject({ state: "CANCELLED", reason: { code: "funding_unconfirmed", fundsClass: "still-protected" } });
  });

  it("a funding that may still land keeps the order past its window; landing late, it is returned, never left in the escrow", async () => {
    // 2026-10-14: the window's end had stopped such an order whatever its funding's fate, and a funding that landed after
    // it stayed in the escrow with no way back
    const end = Math.floor(T0 / 1000) + 1800;
    order({
      params: { amount: AMOUNT.toString(), executeDeadline: end, refundAfter: end + 7200 },
      fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 },
    } as Partial<StoredSwap>);
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    let fate: FundingFate = "pending";
    io.fundingFate = async () => fate;
    const late = end * 1000 + 60_000;
    expect((await runOrderTick(pending()!, deps(io, late)))?.step, "pending past the window: still reconciling").toBe("paused");
    expect(stored().paused?.code).toBe("reconcile");
    fate = "unknown";
    expect((await runOrderTick(pending()!, deps(io, late + 15_000)))?.step, "an unreadable fate decides nothing").toBe("paused");
    expect(stored().state).not.toBe("abandoned");
    // it lands: the escrow holds the funds, which can only come back through its refund
    fate = "landed";
    w.escrow = AMOUNT;
    expect((await runOrderTick(pending()!, deps(io, late + 30_000)))?.step).toBe("funded");
    expect((await runOrderTick(pending()!, deps(io, late + 45_000)))?.step).toBe("paused");
    expect(stored().paused?.code).toBe("execution_window_closed");
    expect(w.signs + w.funds, "nothing signed, nothing sent again").toBe(0);
    expect(await returnFunds(ORDER, deps(io, late + 60_000))).toBe("refunding");
    expect(w.refunds).toBe(1);
    // a dead funding past the window still stops the order: nothing moved
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    resetOperationsMemory();
    order({
      params: { amount: AMOUNT.toString(), executeDeadline: end, refundAfter: end + 7200 },
      fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://relayer.test", at: T0 },
    } as Partial<StoredSwap>);
    const dead = world();
    dead.io.fundingFate = async () => "dead";
    expect((await runOrderTick(pending()!, deps(dead.io, late)))?.step).toBe("stopped");
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "funding_unconfirmed" } });
  });

  it("THORNode gateways that do not answer at signing: an outage tried again, never an unsafe call; signed once they answer", async () => {
    // 2026-10-14: the local stack's run stopped a funded swap into the protected balance here, for good
    order();
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    const sign = io.sign;
    let outage = true;
    io.sign = async (st, reuse) => {
      if (outage) throw new ProviderCallUnverified("thorchain", "only 1 of 3 THORNode gateways answered for ETH; 2 must agree");
      return sign(st, reuse);
    };
    expect(await drive(io, 1)).toEqual(["funded"]);
    await expect(runOrderTick(pending()!, deps(io, T0 + 2_000))).rejects.toBeInstanceOf(ProviderCallUnverified);
    expect(stored().paused, "not paused: the scheduler's backoff tries again").toBeUndefined();
    outage = false;
    expect((await runOrderTick(pending()!, deps(io, T0 + 20_000)))?.step).toBe("handed-over");
    expect(w.handOvers).toBe(1);
  });

  // 2026-10-14: an order whose execution window closes — a funding delayed for privacy run at a late unlock, a tab closed
  // after its funding, a moved minimum left for an hour — had been funded anyway, or retried its signature for good
  const END = Math.floor(T0 / 1000) + 3600; // the escrow's executeDeadline
  const windowed = (extra: Partial<StoredSwap> = {}) =>
    order({ params: { amount: AMOUNT.toString(), executeDeadline: END } as StoredSwap["params"], ...extra });

  it("an order whose execution window has closed, or is about to, is never funded: stopped unfunded with nothing sent", async () => {
    windowed();
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    // with more than the margin left it is funded as usual
    expect((await runOrderTick(pending()!, deps(io, END * 1000 - FUNDING_MARGIN_MS - 60_000)))?.step).toBe("funded");
    expect(w.funds).toBe(1);
    // a second order whose funding comes four minutes before its window closes
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    resetOperationsMemory();
    windowed();
    const late = world();
    expect((await runOrderTick(pending()!, deps(late.io, END * 1000 - 4 * 60_000)))?.step).toBe("stopped");
    expect(late.w.funds, "nothing sent").toBe(0);
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "order_expired" } });
    expect(pending(), "its ticks end").toBeUndefined();
    expect(record()).toMatchObject({ state: "CANCELLED", reason: { code: "order_expired", fundsClass: "not-moved" } });
  });

  it("a funded order whose window closed before its hand-over stops for Return funds: nothing signed, never retried on its own", async () => {
    windowed({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    w.escrow = AMOUNT;
    const late = END * 1000 + 60_000; // the tab came back after the window
    expect((await runOrderTick(pending()!, deps(io, late)))?.step).toBe("paused");
    expect(w.signs, "no signature that cannot execute").toBe(0);
    expect(stored().paused).toMatchObject({ code: "execution_window_closed" });
    expect(record()).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "execution_window_closed", fundsClass: "still-protected" } });
    expect(actionsFor(record()!), "the way back is offered").toContain("start-refund");
    // a tick that still comes (another tab, a stale schedule) waits for the user
    session.update((j) => {
      j.schedule = [action(late)];
    });
    expect((await runOrderTick(pending()!, deps(io, late + 1000)))?.step).toBe("waiting");
    expect(w.signs).toBe(0);
    // "Return funds": the refund-only job
    expect(await returnFunds(ORDER, deps(io, late + 2000))).toBe("refunding");
    expect(w.refunds).toBe(1);
    expect(stored()).toMatchObject({ jobId: "refund-1" });
  });

  it("a lower minimum accepted after the window closed is not signed: the order stops for Return funds", async () => {
    windowed({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ minOut: 2_900_000n });
    w.escrow = AMOUNT;
    expect((await runOrderTick(pending()!, deps(io, T0 + 2_000)))?.step).toBe("paused");
    expect(stored().paused?.code).toBe("minimum_moved");
    // the user comes back after the window and accepts
    const late = END * 1000 + 5 * 60_000;
    acceptNewMinimum(ORDER, session, late);
    expect((await runOrderTick(pending()!, deps(io, late)))?.step).toBe("paused");
    expect(stored().paused?.code).toBe("execution_window_closed");
    expect(w.signs, "only the first signing, which asked for the new minimum").toBe(1);
  });

  it("a hand-over whose answer was lost, or that another tab made, is found by orderId: never handed over twice", async () => {
    order({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ handOver: "lost" });
    w.escrow = AMOUNT;
    expect(await drive(io, 1)).toEqual(["paused"]);
    expect(stored().paused?.code).toBe("reconcile");
    expect(await drive(io, 1, T0 + 20_000)).toEqual(["track"]);
    expect(w.handOvers).toBe(1);
    expect(stored()).toMatchObject({ jobId: "job-1" });
    expect(stored().paused).toBeUndefined();
  });

  it("an unexecutable route pauses with the funds in the escrow; trying again prepares a fresh quote", async () => {
    order({ fundedTx: "0xf00d", state: "funded" });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ simOk: false });
    w.escrow = AMOUNT;
    expect(await drive(io, 2)).toEqual(["paused"]);
    expect(record()).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "execution_unavailable", fundsClass: "still-protected" } });
    expect(await drive(io, 1, T0 + 1000)).toEqual(["waiting"]);
    w.simOk = true;
    expect(retryOrder(ORDER, session, T0 + 2000)).toBe(true);
    expect(await drive(io, 2, T0 + 2000)).toEqual(["handed-over", "track"]);
    expect(w.handOvers).toBe(1);
  });

  it("V6 Stage 12: a swap into the protected balance — the shield job asked while tracked (registered again when forgotten), the delivered note found once shielded", async () => {
    const shield = {
      factory: "0x00000000000000000000000000000000000000f2",
      receiver: "0x00000000000000000000000000000000000000c7",
      params: {
        receiptId: "0x" + "5e".repeat(32),
        asset: "0x0000000000000000000000000000000000000000",
        minAmount: "200",
        shieldTip: "2",
        ownerCommitment: "1",
        noteSecret: "2",
        noteDataHash: "0x" + "00".repeat(32),
        fallbackRecipient: "0x00000000000000000000000000000000000000fa",
      },
      counter: 9,
      noteData: "0x01",
      registeredAt: T0,
    };
    order({ fundedTx: "0xf00d", state: "executing", jobId: "job-1", shield });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    w.job = { id: "job-1", escrow: "0x00000000000000000000000000000000000000e5", state: "executed", updatedAt: T0 } as SwapJob;
    io.track = async () => {
      const done = (stored().shield?.leaves?.length ?? 0) > 0;
      return {
        tracked: {
          state: done ? "COMPLETED" : "PROVIDER_EXECUTING",
          label: done ? "Completed" : "Executing",
          steps: [true, true, done, done],
          detail: "",
        } as Tracked,
        job: w.job,
      };
    };
    // the executor forgot the receipt (no journal after a restart): it is registered again
    expect((await runOrderTick(action(), deps(io)))?.step).toBe("track");
    expect(w.shieldRegistrations).toBe(1);
    expect(stored().shield?.job?.state).toBe("waiting-delivery");
    expect(w.shieldRecoveries, "nothing shielded yet: the pool is not read").toBe(0);
    // the executor shielded the delivery: the note is looked for once, and the order completes
    w.shield = {
      ...w.shield!,
      state: "shielded",
      shields: [{ txHash: ("0x" + "77".repeat(32)) as `0x${string}`, leafIndex: 42, amount: "2278000000000000000", tip: "2", at: T0 }],
    };
    const r = await runOrderTick(action(T0 + 15_000), deps(io, T0 + 15_000));
    expect(r?.step).toBe("settled");
    expect(w.shieldRegistrations).toBe(1);
    expect(w.shieldRecoveries).toBe(1);
    expect(stored().shield?.job).toMatchObject({ state: "shielded", leafIndex: 42, amount: "2278000000000000000" });
    expect(stored().shield?.leaves).toEqual([{ leafIndex: 42, vault: "0x00000000000000000000000000000000000000e1", amount: "2278000000000000000" }]);
    expect(pending(), "a settled order plans no more ticks").toBeUndefined();
  });

  it("'Delay for more privacy' funds no earlier than its drawn time (1–24 h); a campaign's tranche is never run here", async () => {
    const delayUntil = T0 + 3 * 3600_000;
    order({ runner: { confirmedAt: T0, delayUntil } });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    const r = await runOrderTick(action(), deps(io));
    expect(r?.step).toBe("delayed");
    expect(pending()?.dueAt).toBe(delayUntil);
    expect(w.funds).toBe(0);
    expect(DELAY_FOR_PRIVACY).toEqual([3600, 24 * 3600]);
    expect((await runOrderTick(action(delayUntil), deps(io, delayUntil)))?.step).toBe("funded");
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    order({ campaign: { id: "c1", index: 0 } });
    expect(await runOrderTick(action(), deps(io))).toBeNull();
    expect(pending(), "a tranche's tick is dropped").toBeUndefined();
  });

  it("'Delay for more privacy' from older notes: funded at once; when they no longer cover it, stopped unfunded — never paid from younger notes", async () => {
    order({ runner: { confirmedAt: T0, maxTiming: 0 } });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world();
    expect(await drive(io, 2), "no delay: funded at once, then signed and handed over").toEqual(["funded", "handed-over"]);
    expect(w.funds).toBe(1);
    session.update((j) => {
      j.swaps = [];
      j.schedule = [action()];
    });
    resetOperationsMemory();
    order({ runner: { confirmedAt: T0, maxTiming: 0.3 } });
    const gone = world({ fund: "older-gone" });
    const r = await runOrderTick(action(), deps(gone.io));
    expect(r?.step).toBe("stopped");
    expect(gone.w.funds, "tried once; nothing was sent").toBe(1);
    expect(gone.w.escrow).toBe(0n);
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "older_notes_unavailable" } });
    expect(stored().fundedTx).toBeUndefined();
    expect(pending(), "no tick is planned: nothing retries it with other notes").toBeUndefined();
    expect(record()).toMatchObject({ state: "CANCELLED", phase: "funding", reason: { code: "older_notes_unavailable", fundsClass: "not-moved" } });
  });

  it("a relayer that does not run the swap service's orders: stopped before anything is sent, never funded (a V6 follow-up of 2026-10-16)", async () => {
    order({ runner: { confirmedAt: T0 } });
    session.update((j) => {
      j.schedule = [action()];
    });
    const { w, io } = world({ fund: "relayer-not-ready" });
    const r = await runOrderTick(action(), deps(io));
    expect(r?.step).toBe("stopped");
    expect([w.funds, w.escrow, w.signs, w.handOvers], "asked once; nothing sent, signed or handed over").toEqual([1, 0n, 0, 0]);
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "relayer_not_ready" } });
    expect(stored().fundedTx).toBeUndefined();
    expect(pending(), "nothing retries it").toBeUndefined();
    expect(record()).toMatchObject({ state: "CANCELLED", phase: "funding", reason: { code: "relayer_not_ready", fundsClass: "not-moved" } });
  });
});
