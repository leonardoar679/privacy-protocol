// The ninth review round (2026-11-04): an order's funding is a durable fact — a handed-over order reconciled from its escrow's balance
// is never read "never funded" (C-01) — its record never goes back before its submission, a lost hand-over answer is never read
// "nothing was swapped" at the window's end (C-09), the price guard is told by its code (A9-5), a funding is given up as dead only with
// its escrow read (B-F1), and an attempt kept without its call's digest is told by the address its call pays (C-10). The reviewers'
// probes (scratchpad review9/C f2 and f9, review9/B p1) became these cases.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { fundedOf, type ScheduledAction, type StoredSwap } from "../src/wallet/journal";
import type { SwapJob } from "../src/relayer";
import { deriveState, trackOrder } from "../src/orderTracker";
import { fundingFate, fundingReads, patchSwap, type FundingReads } from "../src/swapFunding";
import { getOperation, resetOperationsMemory } from "../src/operations/store";
import { swapRecordId, syncSwapRecord } from "../src/operations/swapRecords";
import { actionsFor } from "../src/operations/recovery";
import { ApiError } from "../src/api/client";
import { indexSpends, rememberSpendIndex, forgetSpendIndexes } from "../src/wallet/spends";
import { HANDOVER_RECHECK_MS, runOrderTick, signRetryMs, type OrderIo } from "../src/wallet/orderRunner";
import type { Deployment } from "../src/chain";
import type { Hex } from "viem";

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
  forgetSpendIndexes();
});

const ORDER = "0x" + "cd".repeat(32);
const AMOUNT = 10n ** 18n;
const T0 = Date.parse("2026-11-04T12:00:00Z");
const DEADLINE_S = Math.floor(T0 / 1000) + 1800;
const ESCROW = "0x00000000000000000000000000000000000000e5";

function put(extra: Partial<StoredSwap> = {}): StoredSwap {
  const s = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: AMOUNT.toString(),
      destination: "bc1q",
      slippageBps: 50,
    },
    params: { amount: AMOUNT.toString(), executeDeadline: DEADLINE_S, refundAfter: DEADLINE_S + 7200 },
    endpoint: ESCROW,
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
const stored = () => session.journal().swaps.find((x) => x.orderId === ORDER)!;
const pending = () => session.journal().schedule.find((a) => a.id === `order-tick:${ORDER}`);
const action = (dueAt: number): ScheduledAction => ({ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt });
const due = (at: number) =>
  session.update((j) => {
    j.schedule = j.schedule.map((a) => ({ ...a, dueAt: at }));
  });
const unused = async (): Promise<never> => {
  throw new Error("not used");
};
const baseIo = (over: Partial<OrderIo>): OrderIo => ({
  fund: unused,
  escrowBalance: async () => null,
  sign: unused,
  handOver: unused,
  job: async () => null,
  track: unused,
  refund: unused,
  shieldStatus: async () => null,
  registerShield: unused,
  recoverShield: async () => 0,
  ...over,
});
const tick = async (io: OrderIo, now: number) =>
  (await runOrderTick(pending()!, { masterSeed: new Uint8Array(32), deployment: null, io, now: () => now }))?.step;

describe("C-01: a handed-over order is funded, whatever its state field says", () => {
  it("fundedOf: the funding's transaction, its landing, the funded state, or a hand-over or an execution", () => {
    const s = put();
    expect(fundedOf(s)).toBe(false);
    for (const extra of [
      { fundedTx: "0xf00d" },
      { fundedAt: T0 },
      { state: "funded" },
      { jobId: "job-1", state: "executing" },
      { handedOverAt: T0 },
      { executionTx: "0xee" },
    ])
      expect(fundedOf({ ...s, ...extra }), JSON.stringify(extra)).toBe(true);
  });

  it("deriveState: handed over without a journaled fundedTx, the executor not read, is executing — before and after its window, never 'expired before it was funded'", () => {
    const facts = { job: null, escrowBalance: null, track: { state: "completed" } as never, refundFound: false };
    const late = deriveState(put({ state: "executing", jobId: "job-1", executionTx: "0x" + "ee".repeat(32) }), { ...facts, now: (DEADLINE_S + 600) * 1000 });
    expect(late.state).toBe("PROVIDER_EXECUTING");
    const early = deriveState(put({ state: "executing", jobId: "job-1" }), { ...facts, now: T0 + 60_000, track: null });
    expect(early.state).toBe("PROVIDER_EXECUTING");
  });

  it("deriveState: a job read `waiting-funding` (its node behind the chain) is the source leg — never COMMITTED or EXPIRED", () => {
    const s = put({ state: "waiting-funding", jobId: "job-1" });
    const wf = { id: "job-1", escrow: ESCROW, state: "waiting-funding", updatedAt: T0 } as unknown as SwapJob;
    for (const now of [T0 + 60_000, (DEADLINE_S + 30) * 1000]) {
      expect(deriveState(s, { now, job: wf, escrowBalance: null, track: null, refundFound: false }).state).toBe("SOURCE_SUBMITTED");
      expect(deriveState(s, { now, job: wf, escrowBalance: AMOUNT, track: null, refundFound: false }).state).toBe("SOURCE_FINAL");
    }
  });

  it("a settlement is derived for such an order once its job is read", () => {
    const s = put({ state: "executing", jobId: "job-1" });
    const job = { id: "job-1", escrow: ESCROW, state: "executing", updatedAt: T0 } as unknown as SwapJob;
    expect(deriveState(s, { now: T0 + 60_000, job, escrowBalance: 0n, track: null, refundFound: false }).settlement).toBeDefined();
  });

  it("syncSwapRecord keeps I-O7: a submitted record never goes back to AWAITING_AUTHORIZATION, whatever the order reads", () => {
    const s = put({ state: "funded", fundedTx: "0xf00d" });
    syncSwapRecord(s, null, null, T0);
    syncSwapRecord(
      put({ state: "executing", jobId: "job-1" }),
      { state: "PROVIDER_EXECUTING", label: "Executing", steps: [true, true, false, false], detail: "" },
      null,
      T0 + 1000,
    );
    expect(getOperation(swapRecordId(ORDER))!.state).toBe("PROVIDER_EXECUTING");
    // a read of the order as never funded (an older journal's order, a tracker's COMMITTED): the record stays where it was
    syncSwapRecord(put({ state: "committed", jobId: undefined, fundedTx: undefined }), null, null, T0 + 2000);
    const rec = getOperation(swapRecordId(ORDER))!;
    expect(rec.state).toBe("PROVIDER_EXECUTING");
    expect(rec.history.map((h) => h.state)).not.toContain("AWAITING_AUTHORIZATION");
  });

  it("end to end: the funding's answer lost, reconciled from the escrow (fundedAt journaled), handed over, then one failed relayer read past the deadline — still tracked, never 'not moved'", async () => {
    put();
    session.update((j) => {
      j.schedule = [action(T0)];
    });
    let escrow = 0n;
    let job: SwapJob | null = null;
    let relayerDown = false;
    const nowRef = { v: T0 };
    const io = baseIo({
      fund: async (_st, onStatus) => {
        onStatus("Withdrawing privately: handing it to the relayer…");
        escrow = AMOUNT;
        throw new TypeError("fetch failed");
      },
      fundingFate: async () => "pending",
      escrowBalance: async () => escrow,
      sign: async () => ({ sim: { ok: true, gas: 1n }, label: "signed" }) as never,
      handOver: async (st) => {
        job = { id: "job-1", escrow: st.endpoint, state: "executing", updatedAt: T0, executionTx: "0x" + "ee".repeat(32) } as unknown as SwapJob;
        patchSwap(st.orderId, { jobId: "job-1", state: "executing" });
        return { job };
      },
      job: async () => (relayerDown ? null : job),
      track: (st) =>
        trackOrder(st, {
          deployment: null,
          session,
          now: nowRef.v,
          readers: { job: async () => (relayerDown ? null : job), balance: async () => 0n, track: async () => ({ state: "pending" }) as never },
        }),
    });
    const at = async (now: number) => {
      nowRef.v = now;
      return tick(io, now);
    };
    expect(await at(T0)).toBe("paused");
    patchSwap(ORDER, { fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://r", at: T0 } });
    expect(await at(T0 + 15_000)).toBe("funded");
    expect(stored().fundedAt, "its landing journaled for good").toBe(T0 + 15_000);
    expect(await at(T0 + 16_000)).toBe("handed-over");
    expect(await at(T0 + 31_000)).toBe("track");
    relayerDown = true;
    const late = (DEADLINE_S + 300) * 1000;
    due(late);
    expect(await at(late)).toBe("track");
    expect(pending(), "its ticks go on").toBeDefined();
    const rec = getOperation(swapRecordId(ORDER))!;
    expect(rec.state).toBe("PROVIDER_EXECUTING");
    expect(rec.reason?.code).not.toBe("order_expired");
    expect(stored().track?.state).toBe("PROVIDER_EXECUTING");
  });
});

describe("C-09: a hand-over whose answer was lost, at the window's end", () => {
  const io = (escrow: bigint | null, answers: { job: SwapJob | null }) =>
    baseIo({
      escrowBalance: async () => escrow,
      job: async () => answers.job,
      sign: async () => ({ sim: { ok: true, gas: 1n }, label: "signed" }) as never,
      handOver: async (_st, _signed, onSending) => {
        onSending?.("http://relayer.test"); // the swap service finalized it and the executor was asked (the tenth review round, A10-3)
        throw new TypeError("fetch failed"); // the hand-over reached the executor; its answer is lost
      },
      track: async () => ({
        tracked: { state: "PROVIDER_EXECUTING", label: "Executing", steps: [true, true, false, false], detail: "" } as never,
        job: answers.job,
      }),
    });

  it("is an outcome not known yet: paused handover_unknown, the executor asked again, Return funds offered — never 'nothing was swapped'", async () => {
    put({ state: "funded", fundedTx: "0xf00d" });
    session.update((j) => {
      j.schedule = [action(T0)];
    });
    const answers = { job: null as SwapJob | null };
    const o = io(0n, answers);
    expect(await tick(o, T0)).toBe("paused");
    expect(stored().paused?.code).toBe("reconcile");
    expect(stored().handOverAttempt, "the attempt journaled before it was sent").toBe(T0);
    const end = DEADLINE_S * 1000 + 1;
    due(end);
    expect(await tick(o, end)).toBe("paused");
    expect(stored().paused?.code).toBe("handover_unknown");
    const rec = getOperation(swapRecordId(ORDER))!;
    expect(rec).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "handover_unknown", fundsClass: "unknown" } });
    expect(actionsFor(rec)).toEqual(expect.arrayContaining(["continue-monitoring", "start-refund"]));
    expect(pending()?.dueAt, "asked again").toBe(end + HANDOVER_RECHECK_MS);
    // the executor answers: the order is tracked from its job
    answers.job = { id: "job-1", escrow: ESCROW, state: "executing", updatedAt: end } as unknown as SwapJob;
    due(end + HANDOVER_RECHECK_MS);
    expect(await tick(o, end + HANDOVER_RECHECK_MS)).toBe("track");
    expect(stored()).toMatchObject({ jobId: "job-1", paused: undefined });
  });

  it("a hand-over the swap service refused reached no executor: no attempt journaled, and at the window's end the escrow read decides (the tenth review round, A10-3)", async () => {
    put({ state: "funded", fundedTx: "0xf00d" });
    session.update((j) => {
      j.schedule = [action(T0)];
    });
    const refused = baseIo({
      escrowBalance: async () => AMOUNT,
      job: async () => null,
      sign: async () => ({ sim: { ok: true, gas: 1n }, label: "signed" }) as never,
      handOver: async () => {
        throw new ApiError(503, "service_capacity", "the swap service is busy"); // the finalize: nothing was handed to an executor
      },
      track: unused,
    });
    expect(await tick(refused, T0)).toBe("paused");
    expect(stored().handOverAttempt, "nothing reached the executor").toBeUndefined();
    const end = DEADLINE_S * 1000 + 1;
    due(end);
    expect(await tick(refused, end)).toBe("paused");
    expect(stored().paused?.code).toBe("execution_window_closed");
  });

  it("with an attempt, the escrow still holding the whole order ten minutes past the window settles it too; before, it is asked again less and less often (A10-3)", async () => {
    put({ state: "funded", fundedTx: "0xf00d", handOverAttempt: T0, relayerUrl: "http://relayer.test" });
    const end = DEADLINE_S * 1000 + 1;
    session.update((j) => {
      j.schedule = [action(end)];
    });
    const o = baseIo({ escrowBalance: async () => AMOUNT, job: async () => null, track: unused });
    expect(await tick(o, end)).toBe("paused");
    expect(stored().paused?.code).toBe("handover_unknown");
    expect(pending()?.dueAt).toBe(end + HANDOVER_RECHECK_MS);
    const later = end + 20 * 60_000;
    due(later);
    expect(await tick(o, later)).toBe("paused");
    expect(stored().paused?.code, "nothing executes past the deadline: the full escrow says nothing was swapped").toBe("execution_window_closed");
  });

  it("without a hand-over attempt, the escrow holding the order: 'nothing was swapped' stands, read from the escrow", async () => {
    put({ state: "funded", fundedTx: "0xf00d" });
    session.update((j) => {
      j.schedule = [action(DEADLINE_S * 1000 + 1)];
    });
    expect(await tick(io(AMOUNT, { job: null }), DEADLINE_S * 1000 + 1)).toBe("paused");
    expect(stored().paused?.code).toBe("execution_window_closed");
    // the escrow short (executed by another copy, or refunded): not known
    put({ state: "funded", fundedTx: "0xf00d", paused: undefined });
    session.update((j) => {
      j.schedule = [action(DEADLINE_S * 1000 + 1)];
    });
    expect(await tick(io(0n, { job: null }), DEADLINE_S * 1000 + 1)).toBe("paused");
    expect(stored().paused?.code).toBe("handover_unknown");
  });
});

describe("A9-5: the price guard by its code", () => {
  const signing = (e: Error) =>
    baseIo({
      escrowBalance: async () => AMOUNT,
      sign: async () => {
        throw e;
      },
    });
  it("the service's 503 guard_unavailable is an outage, tried again inside the window; a price_guard refusal waits for the user", async () => {
    put({ state: "funded", fundedTx: "0xf00d" });
    session.update((j) => {
      j.schedule = [action(T0)];
    });
    const outage = new ApiError(503, "guard_unavailable", "the price guard's competition could not run; try again shortly");
    expect(await tick(signing(outage), T0)).toBe("waiting");
    expect(stored().paused).toBeUndefined();
    expect(pending()?.dueAt).toBe(T0 + signRetryMs(stored(), T0));
    const refused = new ApiError(409, "price_guard", "re-quote from thorchain is 300 bps below the best alternative (x); refusing to sign");
    due(T0 + 60_000);
    expect(await tick(signing(refused), T0 + 60_000)).toBe("paused");
    expect(stored().paused?.code).toBe("execution_unavailable");
  });
});

describe("B-F1: a funding is given up as dead only with its escrow read", () => {
  it("a 'dead' fate while the escrow cannot be read keeps the order reconciling — never abandoned", async () => {
    put({ fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", relayerUrl: "http://r", at: T0 - 7200_000 } });
    session.update((j) => {
      j.schedule = [action(T0)];
    });
    const io = baseIo({ escrowBalance: async () => null, fundingFate: async () => "dead" });
    expect(await tick(io, T0)).toBe("paused");
    expect(stored()).toMatchObject({ state: "committed", paused: { code: "reconcile" } });
    expect(pending()).toBeDefined();
    // read, and short: a dead funding stops the order as before
    due(T0 + 15_000);
    expect(await tick(baseIo({ escrowBalance: async () => 0n, fundingFate: async () => "dead" }), T0 + 15_000)).toBe("stopped");
    expect(stored()).toMatchObject({ state: "abandoned", paused: { code: "funding_unconfirmed" } });
  });

  it("fundingFate: a digest the endpoints did not agree on (null) is no verdict — the funding landed", async () => {
    const reads: FundingReads = {
      spent: async () => true,
      relayerJob: async () => null,
      receipt: async () => null,
      txKnown: async () => false,
      spendOf: async () => ({ txHash: ("0x" + "77".repeat(32)) as Hex }),
      txInputs: async () => null,
    };
    expect(await fundingFate({ nullifiers: ["1", "2"], by: "relayer", inputsDigest: "0x" + "ab".repeat(32), at: T0 }, reads, T0)).toBe("landed");
    expect(
      await fundingFate(
        { nullifiers: ["1", "2"], by: "relayer", inputsDigest: "0x" + "ab".repeat(32), at: T0 },
        { ...reads, txInputs: async () => ("0x" + "cd".repeat(32)) as Hex },
        T0,
      ),
    ).toBe("dead");
  });
});

describe("C-10: an attempt kept without its call's digest", () => {
  const reads = (to: string | null): FundingReads => ({
    spent: async () => true,
    relayerJob: async () => null,
    receipt: async () => null,
    txKnown: async () => false,
    spendOf: async () => ({ txHash: ("0x" + "77".repeat(32)) as Hex }),
    txRecipient: async () => to as Hex | null,
  });
  const legacy = { nullifiers: ["1", "2"] as [string, string], by: "relayer" as const, at: T0 };
  it("is told by the address the call that spent its pair pays: the order's escrow, or another's call", async () => {
    expect(await fundingFate(legacy, reads(ESCROW), T0, ESCROW)).toBe("landed");
    expect(await fundingFate(legacy, reads("0x" + "99".repeat(20)), T0, ESCROW)).toBe("dead");
    expect(await fundingFate(legacy, reads(null), T0, ESCROW), "not agreed: as before").toBe("landed");
  });
});

describe("D-3: a funding's spent bits from the scan's index, never asked by name", () => {
  const deployment = {
    chainId: 1,
    core: "0x" + "c0".repeat(20),
    ethVault: "0x" + "e7".repeat(20),
    rpcUrl: "http://127.0.0.1:1",
    rpcUrls: ["http://127.0.0.1:1"],
    fromBlock: 0n,
    erc20Vaults: [],
  } as unknown as Deployment;
  it("without an index the fate is unknown (nothing asked); with one, the index answers", async () => {
    const attempt = { nullifiers: ["11", "12"] as [string, string], by: "wallet" as const, at: T0 };
    expect(await fundingFate(attempt, fundingReads(deployment), T0)).toBe("unknown");
    rememberSpendIndex(
      deployment.core,
      indexSpends([{ nullifier0: 11n, nullifier1: 12n, transactionHash: ("0x" + "55".repeat(32)) as Hex, blockNumber: 5n } as never], 10n),
    );
    // spent by exactly this pair in the index; the call's inputs are then read (the test endpoint does not answer): unknown, never dead
    const r = fundingReads(deployment);
    expect(await r.spent(11n)).toBe(true);
    expect(await r.spent(13n)).toBe(false);
    expect(await r.spendOf!([11n, 12n])).toEqual({ txHash: "0x" + "55".repeat(32) });
  });
});
