// The eleventh review round (2026-11-04), slice B after its focused critique (K4) and the critique of its fix: a refund the scan finds closes an
// order only on a settled reading. The escrow's own `executed` flag decides once its funds came back — a refund is made only past the execute
// deadline, so the flag is final then — over a job not read, a wallet with no relayer to ask and a relayer that keeps a reverted execution's
// transaction; an escrow the flag says executed has its transaction read from its own Executed event when no job names it; an executed order is
// a refund in full only on the provider's word that nothing was delivered — an answer that tells nothing, a provider not read, a delivery on its
// way are read again, and say so; the runner settles only once the reading closed the order; a job found at another relayer is journaled with
// it; no hand-over hold is taken for an order whose refund came back; a campaign step delivered without an amount settles on what came back.
// The critics' probes (scratchpad review11/K4, K1, K2, K3) became these cases.
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
import { swapRecordId } from "../src/operations/swapRecords";
import { escrowExecuted, executionTxOf, journalStateOf, trackOrder, type TrackDeps } from "../src/orderTracker";
import { HANDOVER_RECHECK_MS, ORDER_LATE_TRACK_MS, orderIo, runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import { trancheStateOf } from "../src/wallet/campaignRunner";
import { protectedInFlight } from "../src/wallet/inFlight";
import { clientsFor, type Deployment } from "../src/chain";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
/** past the refund time: the only time a refund can have been made */
const LATER = (DEADLINE_S + 7200) * 1000 + 600_000;
const EXEC = ("0x" + "ee".repeat(32)) as `0x${string}`;
const ESCROW = "0x00000000000000000000000000000000000000e5";
const VAULT = "0x" + "e7".padStart(40, "0");
const put = (extra: Partial<StoredSwap> = {}, orderId = ORDER): StoredSwap => {
  const s = {
    orderId,
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
    state: "funded",
    fundedTx: "0x" + "fa".repeat(32),
    refundNoteData: "0x00",
    runner: { confirmedAt: T0 },
    ...extra,
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [...j.swaps.filter((x) => x.orderId !== s.orderId), s];
  });
  return s;
};
const stored = (orderId = ORDER) => session.journal().swaps.find((x) => x.orderId === orderId)!;
const pending = (orderId = ORDER) => session.journal().schedule.find((a) => a.id === `order-tick:${orderId}` && !a.done);
const schedule = (at: number, orderId = ORDER) =>
  session.update((j) => {
    j.schedule = [...j.schedule.filter((a) => a.id !== `order-tick:${orderId}`), { id: `order-tick:${orderId}`, kind: "order-tick", orderId, dueAt: at }];
  });
const rec = (orderId = ORDER) => getOperation(swapRecordId(orderId));
const refundNote = (amount = AMOUNT / 2n) => [{ leafIndex: 9, vault: VAULT, amount: amount.toString() }];
const refund = (orderId = ORDER, amount = AMOUNT / 2n): RecoveredRefund =>
  ({
    orderId,
    kind: "refund",
    leafIndex: 9,
    note: { vaultId: BigInt(VAULT), amount, ownerCommitment: 1n, noteSecret: 2n },
    commitment: 3n,
    noteData: "0x",
    txHash: "0x" + "cd".repeat(32),
    counter: 7,
  }) as unknown as RecoveredRefund;
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
const tick = async (io: OrderIo, now: number, orderId = ORDER, deployment: Deployment | null = null) =>
  (await runOrderTick(pending(orderId)!, { masterSeed: new Uint8Array(32), deployment, io, now: () => now }))?.step;
/** the tracker with its readers replaced: the job, the provider's track (with the transaction it was asked about), the escrow's flag and the
 *  execution's event (absent: not read) */
const reader = (
  now: number,
  job: Partial<SwapJob> | null,
  track: unknown,
  o: { executed?: () => Promise<boolean | null>; executionTx?: () => Promise<`0x${string}` | null>; asked?: string[] } = {},
) => {
  const readers: NonNullable<TrackDeps["readers"]> = {
    job: async () => job as SwapJob | null,
    balance: async () => 0n,
    track: async (_s, tx) => {
      o.asked?.push(tx);
      return track as never;
    },
    ...(o.executed ? { executed: o.executed } : {}),
    ...(o.executionTx ? { executionTx: o.executionTx } : {}),
  };
  return (st: StoredSwap) => trackOrder(st, { deployment: null, session, now, readers });
};
const REVERTED = ("0x" + "dd".repeat(32)) as `0x${string}`;
const refundedJob = { id: "job-1", escrow: ESCROW, state: "refunded", executionTx: EXEC, updatedAt: T0 } as Partial<SwapJob>;
const handedOver = { state: "executed", jobId: "job-1", executionTx: EXEC, relayerUrl: "http://relayer.test", handedOverAt: T0 } as Partial<StoredSwap>;

describe("an executed order whose refund came back, its provider not read or telling nothing (K4)", () => {
  it("stays open and says the delivery is read again — its tick kept, its record executing, never terminal — and the provider's answer settles it partial with what it delivered", async () => {
    put(handedOver);
    journalRefunds([refund()]);
    expect(pending(), "left to its runner").toBeDefined();
    expect(await tick(baseIo({ track: reader(LATER, refundedJob, null) }), LATER)).toBe("track");
    expect(stored().track?.state).toBe("PROVIDER_EXECUTING");
    expect(stored().state, "open: never closed on the job's word alone").toBe("executed");
    expect(pending()?.dueAt, "read again later").toBe(LATER + ORDER_LATE_TRACK_MS);
    expect(rec()?.state, "never 'returning to your balance': what came back is in it already").toBe("PROVIDER_EXECUTING");
    expect(
      session.journal().schedule.find((a) => a.id === "discovery:pool"),
      "its refund note found already: no scan asked",
    ).toBeUndefined();
    // the next scan leaves it to the runner again: an execution was seen
    journalRefunds([refund()]);
    expect(stored().state).toBe("executed");
    expect(rec()?.state).not.toBe("REFUNDED");
    const step = await tick(baseIo({ track: reader(LATER + 600_000, refundedJob, { state: "partial", deliveredAmount: "1500000" }) }), LATER + 600_000);
    expect(step).toBe("settled");
    expect(stored().state).toBe("completed");
    expect(rec()?.state).toBe("COMPLETED");
    expect(rec()?.outcome).toBe("partial");
    expect(rec()?.amounts.delivered).toBe("1500000");
    expect(pending()).toBeUndefined();
  });

  it("an answer that tells nothing — unknown (four adapters' own failures), pending, executing — is read again; only the provider's refund or failure is a refund in full", async () => {
    for (const state of ["unknown", "pending", "executing"]) {
      put({ ...handedOver, refunds: refundNote() });
      schedule(LATER);
      expect(await tick(baseIo({ track: reader(LATER, refundedJob, { state }) }), LATER), state).toBe("track");
      expect(stored().track?.state, state).toBe("PROVIDER_EXECUTING");
      expect(stored().state, state).toBe("executed");
    }
    for (const state of ["refunded", "failed"]) {
      put({ ...handedOver, refunds: refundNote(AMOUNT) });
      schedule(LATER);
      expect(await tick(baseIo({ track: reader(LATER, refundedJob, { state }) }), LATER), state).toBe("settled");
      expect(stored().state, state).toBe("refunded");
    }
  });

  it("its refund note not found yet: the order open, a note scan asked at once", async () => {
    put(handedOver);
    schedule(LATER);
    expect(await tick(baseIo({ track: reader(LATER, refundedJob, null) }), LATER)).toBe("track");
    expect(stored().state).toBe("executed");
    expect(session.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done)).toMatchObject({ kind: "discovery", dueAt: LATER });
  });

  it("its words say what is known: a delivery on its way names the destination transaction and the rest back in the balance; an execution not known says the funds came back", async () => {
    put({ ...handedOver, refunds: refundNote() });
    const onItsWay = await reader(LATER, refundedJob, { state: "destination-submitted", destinationTxHash: "0x" + "bc".repeat(32) })(stored());
    expect(onItsWay.tracked.detail).toMatch(
      /^The provider sent the destination transaction 0xbcbcbcbc…; .* came back to the escrow and was re-shielded into your private balance, and what the swap delivered is read again\.$/,
    );
    put({ state: "executing", jobId: "job-1", relayerUrl: "http://relayer.test", handedOverAt: T0, refunds: refundNote() });
    const notKnown = await reader(LATER, null, null)(stored());
    expect(notKnown.tracked.detail).toBe("Your funds came back to your private balance; whether the swap delivered part of them first is read again.");
  });

  it("a journaled reading that said nothing was delivered (units 0) stands while the provider is not read: a refund in full, closed", async () => {
    put({
      ...handedOver,
      refunds: refundNote(AMOUNT),
      track: { state: "PROVIDER_EXECUTING", label: "Executing", at: T0, deliveredAmount: "0" } as StoredSwap["track"],
    });
    const r = await reader(LATER, refundedJob, null)(stored());
    expect(r.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });

  it("another token kept through an answer that tells nothing (unknown, pending, executing), in the reading and the journal", async () => {
    put({ ...handedOver, state: "executed" });
    const job = { id: "job-1", escrow: ESCROW, state: "executed", executionTx: EXEC, updatedAt: T0 } as Partial<SwapJob>;
    await reader(LATER, job, { state: "partial", deliveredAsset: "USDC" })(stored());
    expect(stored().track).toMatchObject({ otherToken: true, deliveredAsset: "USDC" });
    for (const state of ["unknown", "pending", "executing"]) {
      const r = await reader(LATER, job, { state })(stored());
      expect(r.tracked, state).toMatchObject({ state: "PARTIAL", otherToken: true, deliveredAsset: "USDC" });
      expect(stored().track, state).toMatchObject({ otherToken: true, deliveredAsset: "USDC" });
    }
  });

  it("journalStateOf: a refunded job's reading that has not settled keeps the order executed — never reopening a closed one", () => {
    for (const reading of ["PROVIDER_EXECUTING", "DESTINATION_SUBMITTED"] as const) {
      expect(journalStateOf({ state: "executed" }, { state: reading }, { state: "refunded" }), reading).toBe("executed");
      expect(journalStateOf({ state: "refunded" }, { state: reading }, { state: "refunded" }), reading).toBeUndefined();
      expect(journalStateOf({ state: "completed" }, { state: reading }, { state: "refunded" }), reading).toBeUndefined();
    }
    expect(journalStateOf({ state: "executed" }, { state: "REFUNDED" }, { state: "refunded" }), "a settled reading closes it").toBe("refunded");
    expect(journalStateOf({ state: "executing", refunds: refundNote() }, { state: "PROVIDER_EXECUTING" }, null), "no job read: as it is").toBeUndefined();
  });
});

describe("an order handed over, its refund found, whether it executed not known (K4)", () => {
  it("its relayer not read: read again with its tick — never a terminal record on a reading without the job; the escrow's flag then closes it as never executed", async () => {
    put({ state: "executing", jobId: "job-1", relayerUrl: "http://relayer.test", handedOverAt: T0 });
    journalRefunds([refund()]);
    for (let i = 0; i < 2; i++) {
      const at = LATER + i * 60_000;
      expect(await tick(baseIo({ track: reader(at, null, null) }), at), `read ${i}`).toBe("track");
      expect(stored().track?.state).toBe("PROVIDER_EXECUTING");
      expect(stored().state, "open").toBe("executing");
      expect(rec()?.state, "never terminal on it").not.toBe("REFUNDED");
      expect(pending()?.dueAt, "its refund came back: read every ten minutes").toBe(at + ORDER_LATE_TRACK_MS);
    }
    expect(protectedInFlight(), "in flight while it is not known").toBe(1);
    const at = LATER + 120_000;
    expect(await tick(baseIo({ track: reader(at, null, null, { executed: async () => false }) }), at)).toBe("settled");
    expect(stored().state).toBe("refunded");
    expect(rec()?.state).toBe("REFUNDED");
    expect(protectedInFlight()).toBe(0);
  });

  it("the relayer back: executed, its rest refunded, the provider's delivered amount — partly delivered, never refunded in full", async () => {
    put({ state: "executing", jobId: "job-1", relayerUrl: "http://relayer.test", handedOverAt: T0 });
    journalRefunds([refund()]);
    expect(await tick(baseIo({ track: reader(LATER, null, null) }), LATER)).toBe("track");
    const step = await tick(baseIo({ track: reader(LATER + 60_000, refundedJob, { state: "partial", deliveredAmount: "1500000" }) }), LATER + 60_000);
    expect(step).toBe("settled");
    expect(stored().state).toBe("completed");
    expect(rec()?.amounts.delivered).toBe("1500000");
  });

  it("asked about only by its jobId (a job found by orderId), only by a wallet's own hand-over (handedOverAt), or with a job read executing: never a refund in full on it", async () => {
    const shapes: [string, Partial<StoredSwap>, Partial<SwapJob> | null][] = [
      ["a jobId alone", { state: "executing", jobId: "job-1", relayerUrl: "http://relayer.test" }, null],
      ["a hand-over without a relayer", { handedOverAt: T0 }, null],
      [
        "a job read executing, no transaction yet",
        { state: "executing", jobId: "job-1", relayerUrl: "http://relayer.test" },
        { id: "job-1", escrow: ESCROW, state: "executing", updatedAt: T0 } as Partial<SwapJob>,
      ],
    ];
    for (const [name, extra, job] of shapes) {
      put({ ...extra, refunds: refundNote() });
      const before = stored().state;
      const r = await reader(LATER, job, null, { executed: async () => null })(stored());
      expect(r.tracked.state, name).toBe("PROVIDER_EXECUTING");
      expect(stored().state, `${name}: left open`).toBe(job ? "executing" : before);
    }
  });
});

describe("an order whose execution its event named, read again until a reading settles it (the fourth critique)", () => {
  it("its first answer telling nothing — unknown, a delivery on its way, the provider not read —: asked again at the next tick, never paused 'the executor is asked again'", async () => {
    for (const first of [{ state: "unknown" }, { state: "destination-submitted" }, null]) {
      const name = first ? first.state : "not read";
      session.update((j) => {
        j.operations = []; // a record left terminal by the last case would pass the checks by itself
      });
      resetOperationsMemory();
      put({ handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote() });
      schedule(LATER);
      const asked: string[] = [];
      const answers = [first, { state: "partial", deliveredAmount: "1500000" }];
      let flagReads = 0;
      let eventReads = 0;
      const io = baseIo({
        escrowExecuted: async () => (flagReads++, true),
        track: (st) => {
          const answer = answers[asked.length];
          return reader(LATER, null, answer, { executed: async () => true, executionTx: async () => (eventReads++, EXEC), asked })(st);
        },
      });
      expect(await tick(io, LATER), `${name}: tick 1`).toBe("track");
      expect(stored().executionTx, name).toBe(EXEC);
      expect(stored().paused, `${name}: the funds are back, nothing waits for the user`).toBeUndefined();
      expect(await tick(io, LATER + ORDER_LATE_TRACK_MS), `${name}: tick 2`).toBe("settled");
      expect(asked, name).toEqual([EXEC, EXEC]);
      expect(flagReads, `${name}: the runner's flag once — then the execution journaled is read as such`).toBe(1);
      expect(eventReads, `${name}: the event once — then the transaction it named, journaled`).toBe(1);
      expect(stored().state, name).toBe("completed");
      expect(rec()?.state, name).toBe("COMPLETED");
      expect(rec()?.reason?.code, name).not.toBe("handover_unknown");
    }
  });

  it("read by a Refresh first: its transaction journaled and its pause ended there, then the runner settles it", async () => {
    put({ handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote() });
    schedule(LATER);
    const refresh = await reader(LATER, null, { state: "unknown" }, { executed: async () => true, executionTx: async () => EXEC })(stored());
    expect(refresh.tracked.state).toBe("PROVIDER_EXECUTING");
    expect(stored().executionTx).toBe(EXEC);
    expect(stored().paused, "never 'nothing was swapped' for an executed swap").toBeUndefined();
    const io = baseIo({ track: reader(LATER + 60_000, null, { state: "partial", deliveredAmount: "1500000" }, { executed: async () => true }) });
    expect(await tick(io, LATER + 60_000)).toBe("settled");
    expect(stored().state).toBe("completed");
    expect(rec()?.state).toBe("COMPLETED");
  });

  it("an execution journaled with a pause still standing: the pause ended at the next tick, the order read as executed", async () => {
    put({ executionTx: EXEC, handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote() });
    schedule(LATER);
    expect(await tick(baseIo({ track: reader(LATER, null, { state: "unknown" }, { executed: async () => null }) }), LATER)).toBe("track");
    expect(stored().paused).toBeUndefined();
    expect(rec()?.state).toBe("PROVIDER_EXECUTING");
  });

  it("a delivery found ends a pause too: an order into the protected balance whose delivered note is found reads completed, its record with it", async () => {
    put({
      handOverAttempt: T0,
      paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"],
      shield: { leaves: [{ leafIndex: 4, vault: "0x" + "00".repeat(20), amount: "2990000" }] } as unknown as StoredSwap["shield"],
    });
    const r = await reader(LATER, null, null)(stored());
    expect(r.tracked.state).toBe("COMPLETED");
    expect(stored().state).toBe("completed");
    expect(stored().paused, "never the pause's RECOVERY_REQUIRED over a closed order").toBeUndefined();
    schedule(LATER);
    expect(await tick(baseIo({}), LATER), "the closed order's tick re-syncs it and ends").toBeUndefined();
    expect(rec()?.state).toBe("COMPLETED");
  });

  it("a settled reading ends a pause too: an order a Refresh reads refunded in full is closed with its words, never the pause's", async () => {
    put({ handOverAttempt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote(AMOUNT) });
    await reader(LATER, null, null, { executed: async () => false })(stored());
    expect(stored().state).toBe("refunded");
    expect(stored().paused).toBeUndefined();
  });
});

describe("the escrow's flag over the transactions (K4)", () => {
  it("the flag true and a job naming none: the escrow's event names the one execution, over the journal's — the relayer's own call that reverted (r01)", async () => {
    put({ ...handedOver, executionTx: REVERTED, refunds: refundNote() });
    const asked: string[] = [];
    const job = { id: "job-1", escrow: ESCROW, state: "refunded", updatedAt: T0 } as Partial<SwapJob>;
    const r = await reader(
      LATER,
      job,
      { state: "partial", deliveredAmount: "1500000" },
      { executed: async () => true, executionTx: async () => EXEC, asked },
    )(stored());
    expect(asked).toEqual([EXEC]);
    expect(r.tracked.state).toBe("PARTIAL");
    expect(stored().executionTx).toBe(EXEC);
    // the event not read: the journal's, as before
    put({ ...handedOver, executionTx: REVERTED, refunds: refundNote() });
    const fallback: string[] = [];
    await reader(LATER, job, { state: "unknown" }, { executed: async () => true, executionTx: async () => null, asked: fallback })(stored());
    expect(fallback).toEqual([REVERTED]);
  });

  it("no refund in play and its relayer not read: the provider is asked with the journal's transaction, as before", async () => {
    put(handedOver);
    const asked: string[] = [];
    const r = await reader(T0 + 60_000, null, { state: "completed" }, { asked })(stored());
    expect(asked).toEqual([EXEC]);
    expect(r.tracked.state, "its executor not read: the reading waits for its word (r38)").toBe("PROVIDER_EXECUTING");
    expect(stored().executionTx).toBe(EXEC);
  });

  it("a job naming none takes the journal's transaction away on the flag's word that the escrow never executed, and before any refund (r01) — the provider never asked about it", async () => {
    const job = { id: "job-1", escrow: ESCROW, state: "refunded", updatedAt: T0 } as Partial<SwapJob>;
    put({ ...handedOver, refunds: refundNote(AMOUNT) });
    const denied: string[] = [];
    const r = await reader(LATER, job, null, { executed: async () => false, asked: denied })(stored());
    expect(denied).toEqual([]);
    expect(r.tracked.state).toBe("REFUNDED");
    expect(stored().executionTx).toBeUndefined();
    // the flag's word with no job read (its relayer down): taken away too
    put({ ...handedOver, refunds: refundNote(AMOUNT) });
    await reader(LATER, null, null, { executed: async () => false })(stored());
    expect(stored().executionTx).toBeUndefined();
    put(handedOver);
    const before: string[] = [];
    const executing = { id: "job-1", escrow: ESCROW, state: "waiting-funding", updatedAt: T0 } as Partial<SwapJob>;
    await reader(T0 + 60_000, executing, null, { asked: before })(stored());
    expect(before, "no refund in play: the flag is not read").toEqual([]);
    expect(stored().executionTx, "the relayer's word (a dropped call): taken away").toBeUndefined();
  });

  it("a reverted execution's transaction kept by its relayer is no execution once the flag reads false — refunded in full; unread, it is asked about", async () => {
    put({ state: "execute-failed", jobId: "job-1", executionTx: EXEC, relayerUrl: "http://relayer.test", handedOverAt: T0 });
    const r = await reader(LATER, refundedJob, null, { executed: async () => false })(stored());
    expect(r.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
    put({ state: "execute-failed", jobId: "job-1", executionTx: EXEC, relayerUrl: "http://relayer.test", handedOverAt: T0 });
    const unread = await reader(LATER, refundedJob, null, { executed: async () => null })(stored());
    expect(unread.tracked.state).toBe("PROVIDER_EXECUTING");
    expect(stored().state).toBe("executed");
  });

  it("another relayer's job naming no execution keeps the journal's transaction while the flag does not deny it: the provider is asked with it (the critic's P5)", async () => {
    for (const flag of [true, null]) {
      put({ ...handedOver, refunds: refundNote() });
      const asked: string[] = [];
      const job = { id: "job-2", escrow: ESCROW, state: "refunded", updatedAt: T0 } as Partial<SwapJob>;
      const r = await reader(LATER, job, { state: "partial", deliveredAmount: "1500000" }, { executed: async () => flag, asked })(stored());
      expect(asked, String(flag)).toEqual([EXEC]);
      expect(r.tracked.state, String(flag)).toBe("PARTIAL");
      expect(stored().executionTx, `${flag}: never deleted for a job that names none`).toBe(EXEC);
    }
  });

  it("the flag true, a job read in a non-executing state naming no transaction, none journaled: its transaction read from the escrow's event and asked about — never a refund in full", async () => {
    const job = { id: "job-1", escrow: ESCROW, state: "refunded", updatedAt: T0 } as Partial<SwapJob>;
    put({ state: "refund-only", jobId: "job-1", relayerUrl: "http://relayer.test", handedOverAt: T0, refunds: refundNote() });
    const none = await reader(LATER, job, null, { executed: async () => true, executionTx: async () => null })(stored());
    expect(none.tracked.state, "no transaction to ask about: read again").toBe("PROVIDER_EXECUTING");
    expect(none.tracked.detail).toMatch(/execution transaction is looked for again/);
    expect(stored().state, "kept open, executed").toBe("executed");
    const asked: string[] = [];
    const found = await reader(
      LATER,
      job,
      { state: "partial", deliveredAmount: "1500000" },
      { executed: async () => true, executionTx: async () => EXEC, asked },
    )(stored());
    expect(asked).toEqual([EXEC]);
    expect(found.tracked.state).toBe("PARTIAL");
    expect(stored().executionTx, "journaled once found").toBe(EXEC);
    expect(stored().state).toBe("completed");
    // found, and the provider telling nothing yet: read again from the provider — the words say so
    put({ state: "refund-only", jobId: "job-1", relayerUrl: "http://relayer.test", handedOverAt: T0, refunds: refundNote() });
    const silent = await reader(LATER, job, { state: "unknown" }, { executed: async () => true, executionTx: async () => EXEC })(stored());
    expect(silent.tracked.state).toBe("PROVIDER_EXECUTING");
    expect(silent.tracked.detail).toMatch(/read again from the provider/);
  });
});

describe("the escrow's own reads, through the wallet's endpoints (K4; the tests critic's T1)", () => {
  const BLOCK0 = 1000n;
  const T0S = BigInt(Math.floor(T0 / 1000));
  /** an endpoint: blocks every 12 s from BLOCK0 at T0, the escrow's flag, its balance, its Executed event in block `at`, a log range of `cap` blocks */
  const endpoint = (o: {
    executed: boolean | Error;
    balance?: bigint;
    at?: bigint;
    latest?: bigint;
    cap?: bigint;
    calls?: { fn: string; address?: string }[];
  }) => ({
    readContract: async (q: { address: string; functionName: string }) => {
      o.calls?.push({ fn: q.functionName, address: q.address });
      if (q.functionName !== "executed") throw new Error(`unexpected ${q.functionName}`);
      if (o.executed instanceof Error) throw o.executed;
      return o.executed;
    },
    getBalance: async () => o.balance ?? 0n,
    getBlockNumber: async () => o.latest ?? BLOCK0 + 2000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: T0S + (blockNumber - BLOCK0) * 12n }),
    // an endpoint serves a capped range of blocks, as public ones do
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > (o.cap ?? 5_000n)) throw new Error("block range too large");
      return o.at !== undefined && o.at >= fromBlock && o.at <= toBlock ? [{ transactionHash: EXEC, blockNumber: o.at }] : [];
    },
  });
  const deployment = { chainId: 1, rpcUrl: "http://rpc1.test", rpcUrls: ["http://rpc1.test", "http://rpc2.test"], fromBlock: 0n } as unknown as Deployment;

  it("a wallet with no relayer: the order its hand-over finalized, refunded by anyone's deployAndRefund, closes on the flag read at the escrow — its pause with it", async () => {
    const calls: { fn: string; address?: string }[] = [];
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: false, calls }), endpoint({ executed: false })] as never);
    put({ handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    journalRefunds([refund()]);
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "wallet" } });
    expect(await tick(io, LATER, ORDER, deployment)).toBe("settled");
    expect(calls).toContainEqual({ fn: "executed", address: ESCROW });
    expect(stored().state).toBe("refunded");
    expect(stored().paused).toBeUndefined();
    expect(rec()?.state).toBe("REFUNDED");
    expect(protectedInFlight()).toBe(0);
  });

  it("executed by the user's own deployAndExecute: its transaction read from the escrow's event, the provider asked through the swap service, the order settled partial", async () => {
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: true, at: BLOCK0 + 100n }), endpoint({ executed: true, at: BLOCK0 + 100n })] as never);
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ track: { state: "partial", deliveredAmount: "1500000" }, status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    put({ handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    journalRefunds([refund()]);
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "wallet" } });
    expect(await tick(io, LATER, ORDER, deployment)).toBe("settled");
    expect(
      asked.some((u) => u.includes("/v1/track/thorchain") && u.includes(EXEC.slice(2, 12))),
      "the provider asked about the transaction the event named",
    ).toBe(true);
    expect(stored().executionTx).toBe(EXEC);
    expect(stored().state).toBe("completed");
    expect(rec()?.state).toBe("COMPLETED");
    expect(rec()?.amounts.delivered).toBe("1500000");
    expect(protectedInFlight()).toBe(0);
  });

  it("the tracker's own flag read: a reverted execution's kept transaction with the flag false at every endpoint is a refund in full", async () => {
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: false }), endpoint({ executed: false })] as never);
    put({ state: "execute-failed", jobId: "job-1", executionTx: EXEC, relayerUrl: "http://relayer.test", handedOverAt: T0 });
    const r = await trackOrder(stored(), {
      deployment,
      session,
      now: LATER,
      readers: { job: async () => refundedJob as SwapJob, balance: async () => 0n, track: async () => null },
    });
    expect(r.tracked.state).toBe("REFUNDED");
    expect(stored().state).toBe("refunded");
  });

  it("executed, no transaction found anywhere: kept open and read every ten minutes, never holding the idle lock — what no job and no event can say stays open (the residual, stated)", async () => {
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: true }), endpoint({ executed: true })] as never);
    put({ handedOverAt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    journalRefunds([refund()]);
    const prod = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "wallet" } });
    const heldDuring: boolean[] = [];
    // watched at the tracker's read, which every tick makes: the first from 1b's flag, the next as an execution journaled
    let flagReads = 0;
    const io: OrderIo = {
      ...prod,
      escrowExecuted: async (st) => (flagReads++, prod.escrowExecuted!(st)),
      track: async (st) => {
        heldDuring.push(session.holds().some((h) => h.reason === "hand-over"));
        return prod.track(st);
      },
    };
    for (let i = 0; i < 3; i++) {
      const at = LATER + i * ORDER_LATE_TRACK_MS;
      expect(await tick(io, at, ORDER, deployment), `tick ${i}`).toBe("track");
      expect(stored().state).toBe("executed");
      expect(stored().paused, "its pause cleared: the funds are back").toBeUndefined();
      expect(rec()?.state).toBe("PROVIDER_EXECUTING");
      expect(pending()?.dueAt).toBe(at + ORDER_LATE_TRACK_MS);
      expect(
        session.holds().some((h) => h.reason === "hand-over"),
        "no hand-over hold for an order whose refund came back",
      ).toBe(false);
    }
    expect(heldDuring, "nor during its ticks").toEqual([false, false, false]);
    expect(flagReads, "the runner's flag read once: an order journaled executed is read as such from then on").toBe(1);
  });

  it("escrowExecuted: every endpoint's word — agreed, it answers; one failing, or two that disagree, is no answer", async () => {
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: true }), endpoint({ executed: true })] as never);
    expect(await escrowExecuted(deployment, ESCROW)).toBe(true);
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: false }), endpoint({ executed: false })] as never);
    expect(await escrowExecuted(deployment, ESCROW)).toBe(false);
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: false }), endpoint({ executed: new Error("returned no data (0x): no code there") })] as never);
    expect(await escrowExecuted(deployment, ESCROW), "never 'not executed' on a failed read").toBeNull();
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: true }), endpoint({ executed: false })] as never);
    expect(await escrowExecuted(deployment, ESCROW)).toBeNull();
  });

  it("executionTxOf: the event between the order's creation and its deadline, window by window, named alike by every endpoint", async () => {
    const latest = BLOCK0 + 20_000n;
    // the deadline lies 150 blocks after the creation; an execution there is found, one past the deadline is not this order's
    vi.mocked(clientsFor).mockReturnValue([
      endpoint({ executed: true, at: BLOCK0 + 140n, latest }),
      endpoint({ executed: true, at: BLOCK0 + 140n, latest }),
    ] as never);
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S)).toBe(EXEC);
    vi.mocked(clientsFor).mockReturnValue([
      endpoint({ executed: true, at: BLOCK0 + 200n, latest }),
      endpoint({ executed: true, at: BLOCK0 + 200n, latest }),
    ] as never);
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "after the deadline: none").toBeNull();
    // a window longer than one read: a delayed order's 72 hours, its execution in the last window
    const long = DEADLINE_S + 72 * 3600;
    const at = BLOCK0 + BigInt(72 * 300 + 100);
    vi.mocked(clientsFor).mockReturnValue([
      endpoint({ executed: true, at, latest: at + 9000n }),
      endpoint({ executed: true, at, latest: at + 9000n }),
    ] as never);
    expect(await executionTxOf(deployment, ESCROW, T0, long)).toBe(EXEC);
    // one endpoint that names none: no agreed answer
    vi.mocked(clientsFor).mockReturnValue([endpoint({ executed: true, at: BLOCK0 + 140n, latest }), endpoint({ executed: true, latest })] as never);
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S)).toBeNull();
  });

  it("executionTxOf's bounds: an execution before a fast device's commit time is found, so is one in the deadline's own block, never one after it; a capped endpoint is read in smaller windows", async () => {
    const latest = BLOCK0 + 20_000n;
    const both = (o: Parameters<typeof endpoint>[0]) => vi.mocked(clientsFor).mockReturnValue([endpoint(o), endpoint(o)] as never);
    // the device's clock 5 minutes fast at the commit: the execution came 2 minutes after the true commit, 3 minutes before createdAt
    both({ executed: true, at: BLOCK0 - 15n, latest });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "a fast device clock").toBe(EXEC);
    // ... up to the hour's margin: 55 minutes fast, found; more than an hour before the commit, not this order's
    both({ executed: true, at: BLOCK0 - 275n, latest });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "55 minutes").toBe(EXEC);
    both({ executed: true, at: BLOCK0 - 305n, latest });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "61 minutes").toBeNull();
    // the block whose time is the deadline (BLOCK0 + 150): execute() takes block.timestamp <= the deadline
    both({ executed: true, at: BLOCK0 + 150n, latest });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "the deadline's own block").toBe(EXEC);
    both({ executed: true, at: BLOCK0 + 151n, latest });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "one past it").toBeNull();
    // a deadline still ahead of the latest block: read to the latest, the latest included
    both({ executed: true, at: BLOCK0 + 100n, latest: BLOCK0 + 100n });
    expect(await executionTxOf(deployment, ESCROW, T0, DEADLINE_S), "the latest block").toBe(EXEC);
    // a day-long window at an endpoint that serves 2,000 blocks at a time: halved until it answers
    const day = DEADLINE_S + 24 * 3600;
    both({ executed: true, at: BLOCK0 + 7_000n, latest, cap: 2_000n });
    expect(await executionTxOf(deployment, ESCROW, T0, day)).toBe(EXEC);
  });
});

describe("two orders read at once (the critic's P5b)", () => {
  it("each closes on its own escrow's flag: a shared last read had closed one on the other's word", async () => {
    const X = "0x" + "c1".repeat(32);
    const Y = "0x" + "c2".repeat(32);
    for (const id of [X, Y])
      put({ handOverAttempt: T0, relayerUrl: "http://relayer.test", paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] }, id);
    journalRefunds([refund(X), refund(Y)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const io = baseIo({
      escrowBalance: async () => 0n,
      escrowExecuted: async (st) => {
        await gate;
        return st.orderId === Y ? false : null;
      },
    });
    const both = Promise.all([tick(io, LATER, X), tick(io, LATER, Y)]);
    release();
    const [sx, sy] = await both;
    expect([sx, stored(X).state]).toEqual(["track", "funded"]);
    expect([sy, stored(Y).state]).toEqual(["settled", "refunded"]);
  });
});

describe("a job found ended closes the order only on a settled reading (the fifth critique)", () => {
  it("at the tick's lookup: a refunded job found, the provider telling nothing this time — open, executing, never a terminal record", async () => {
    put({ handOverAttempt: T0, relayerUrl: "http://relayer.test", paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    schedule(LATER);
    const io = baseIo({ job: async () => ({ ...refundedJob, at: "http://relayer.test" }) as never, track: reader(LATER, refundedJob, { state: "unknown" }) });
    expect(await tick(io, LATER)).toBe("track");
    expect(stored().jobId).toBe("job-1");
    expect(stored().state, "open: the reading has not settled").toBe("executed");
    expect(rec()?.state).not.toBe("REFUNDED");
    expect(pending(), "read again").toBeDefined();
  });

  it("before a funding and at a funding that landed (another copy's hand-over): a job found ended keeps the order funded until it is read; its reading decides", async () => {
    for (const [name, extra, found] of [
      ["before any funding, a completed job", {}, { id: "job-1", escrow: ESCROW, state: "completed", executionTx: EXEC, updatedAt: T0 }],
      ["a funding that landed, a refunded job", { fundingAttempt: { at: T0 } }, { ...refundedJob }],
    ] as [string, Partial<StoredSwap>, Partial<SwapJob>][]) {
      session.update((j) => {
        j.operations = [];
      });
      resetOperationsMemory();
      put({ state: "committed", fundedTx: undefined, ...extra });
      schedule(T0 + 60_000);
      const io = baseIo({ escrowBalance: async () => 0n, fundingFate: async () => "landed", job: async () => found as never });
      expect(await tick(io, T0 + 60_000), name).toBe("track");
      expect(stored().state, name).toBe("funded");
      expect(["REFUNDED", "COMPLETED"].includes(rec()?.state ?? ""), `${name}: never terminal before a reading`).toBe(false);
    }
    // the completed job's reading: the provider's failure, nothing back — the order closes with its reason, never "Swap complete"
    const failed = baseIo({
      track: reader(T0 + 120_000, { id: "job-1", escrow: ESCROW, state: "completed", executionTx: EXEC, updatedAt: T0 }, { state: "failed" }),
    });
    put({ state: "funded", jobId: "job-1", relayerUrl: "http://relayer.test" });
    schedule(T0 + 120_000);
    expect(await tick(failed, T0 + 120_000)).toBe("settled");
    expect(rec()?.state).toBe("RECOVERY_REQUIRED");
    expect(rec()?.reason?.code).toBe("provider_failed");
  });

  it("before the hand-over: a job found ended keeps the order funded", async () => {
    put({ relayerUrl: "http://a.test" });
    schedule(T0 + 60_000);
    let lookups = 0;
    const io = baseIo({
      escrowBalance: async () => AMOUNT,
      sign: async () => ({ sim: { ok: true, gas: 1n }, label: "signed" }) as never,
      job: async () => (++lookups === 1 ? null : ({ ...refundedJob, at: "http://a.test" } as never)),
    });
    expect(await tick(io, T0 + 60_000)).toBe("handed-over");
    expect(stored().jobId).toBe("job-1");
    expect(stored().state).toBe("funded");
  });
});

describe("a Return funds' job after a hand-over (the fifth critique)", () => {
  it("says nothing of the execution: the order is left to its runner, whose tracker reads the escrow's flag — one never handed over is closed at once", () => {
    for (const state of ["refund-only", "refunding"]) {
      session.update((j) => {
        j.operations = [];
        j.schedule = [];
      });
      resetOperationsMemory();
      put({ state, jobId: "job-r", relayerUrl: "http://relayer.test", handOverAttempt: T0 });
      journalRefunds([refund()]);
      expect(stored().state, `${state} after a hand-over attempt`).toBe(state);
      expect(pending(), `${state}: its runner reads it`).toBeDefined();
      put({ state, jobId: "job-r", relayerUrl: "http://relayer.test", handOverAttempt: undefined });
      journalRefunds([refund()]);
      expect(stored().state, `${state}, never handed over: its refund closes it`).toBe("refunded");
    }
  });
});

describe("a job found at another relayer is journaled with it (K4)", () => {
  const atB = { id: ORDER, escrow: ESCROW, state: "executing", updatedAt: T0, at: "http://b.test" } as SwapJob & { at: string };

  it("at the job lookup of a handed-over order (the production reader: the relayer Settings names, after the order's own answered 404)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("http://b.test/swap/"))
        return new Response(JSON.stringify({ id: ORDER, escrow: ESCROW, state: "executing", updatedAt: T0 }), { status: 200 });
      return new Response(JSON.stringify({ error: "unknown swap job" }), { status: 404 });
    }) as typeof fetch;
    put({ handOverAttempt: T0, relayerUrl: "http://a.test", paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment: null, session, submission: { kind: "relayer", url: "http://b.test" } });
    schedule(T0 + 60_000);
    expect(await tick(io, T0 + 60_000)).toBe("track");
    expect(stored().jobId).toBe(ORDER);
    expect(stored().relayerUrl, "the relayer that answered").toBe("http://b.test");
    expect(stored().track?.state, "read there: executing, never 'did not answer'").toBe("SOURCE_FINAL");
  });

  it("an order with no relayer journaled is pinned to the one that answered (the reader's own `at`)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: ORDER, escrow: ESCROW, state: "executing", updatedAt: T0 }), { status: 200 })) as typeof fetch;
    put({ handOverAttempt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"] });
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment: null, session, submission: { kind: "relayer", url: "http://b.test" } });
    schedule(T0 + 60_000);
    await tick(io, T0 + 60_000);
    expect(stored().relayerUrl).toBe("http://b.test");
  });

  it("at a funding that landed into an escrow read short (another copy's hand-over), and before a funding", async () => {
    for (const [name, extra] of [
      ["a funding that landed", { fundingAttempt: { at: T0 } }],
      ["before any funding", {}],
    ] as [string, Partial<StoredSwap>][]) {
      put({ state: "committed", fundedTx: undefined, relayerUrl: "http://a.test", ...extra });
      schedule(T0 + 60_000);
      const io = baseIo({ escrowBalance: async () => 0n, fundingFate: async () => "landed", job: async () => atB });
      expect(await tick(io, T0 + 60_000), name).toBe("track");
      expect(stored().jobId, name).toBe(ORDER);
      expect(stored().relayerUrl, name).toBe("http://b.test");
    }
  });

  it("before the hand-over (another tab's, between the tick's first lookup and its signature)", async () => {
    put({ relayerUrl: "http://a.test" });
    schedule(T0 + 60_000);
    let lookups = 0;
    const io = baseIo({
      escrowBalance: async () => AMOUNT,
      sign: async () => ({ sim: { ok: true, gas: 1n }, label: "signed" }) as never,
      job: async () => (++lookups === 1 ? null : atB),
    });
    expect(await tick(io, T0 + 60_000)).toBe("handed-over");
    expect(stored().jobId).toBe(ORDER);
    expect(stored().relayerUrl).toBe("http://b.test");
  });
});

describe("the provider's answers (K4)", () => {
  it("an answer of nothing at all (undefined) is no answer: read again, never refunded in full", async () => {
    put({ ...handedOver, refunds: refundNote() });
    const job = { id: "job-1", escrow: ESCROW, state: "executed", executionTx: EXEC, updatedAt: T0 } as Partial<SwapJob>;
    const r = await reader(LATER, job, undefined)(stored());
    expect(r.tracked.state).toBe("PROVIDER_EXECUTING");
    expect(stored().state).toBe("executed");
  });

  it("the provider's word of a delivery without its amount is a partial delivery; one still on its way is waited for at the destination; its refund or failure is a refund in full", async () => {
    for (const state of ["completed", "destination-final", "partial"]) {
      put({ ...handedOver, refunds: refundNote(AMOUNT / 50n) });
      const r = await reader(LATER, refundedJob, { state })(stored());
      expect(r.tracked.state, state).toBe("PARTIAL");
      expect(stored().state, state).toBe("completed");
    }
    put({ ...handedOver, refunds: refundNote(AMOUNT / 50n) });
    schedule(LATER);
    expect(await tick(baseIo({ track: reader(LATER, refundedJob, { state: "destination-submitted" }) }), LATER)).toBe("track");
    expect(stored().track?.state).toBe("DESTINATION_SUBMITTED");
    expect(stored().state).toBe("executed");
    expect(rec()?.state, "waiting for the destination, never 'returning to your balance'").toBe("DESTINATION_CONFIRMING");
    for (const state of ["refunded", "failed"]) {
      put({ ...handedOver, refunds: refundNote(AMOUNT) });
      const r = await reader(LATER, refundedJob, { state })(stored());
      expect(r.tracked.state, `${state}: nothing delivered`).toBe("REFUNDED");
      expect(stored().state, state).toBe("refunded");
    }
  });
});

describe("a delivery final at the destination closes the order (K4)", () => {
  it("a swap into the protected balance whose delivered note is found closes completed, whatever the executor's watch says — and its runner stops", async () => {
    put({ ...handedOver, shield: { leaves: [{ leafIndex: 4, vault: "0x" + "00".repeat(20), amount: "2990000" }] } as unknown as StoredSwap["shield"] });
    const job = { id: "job-1", escrow: ESCROW, state: "executed", executionTx: EXEC, updatedAt: T0 } as Partial<SwapJob>;
    schedule(LATER);
    const io = baseIo({
      track: reader(LATER, job, { state: "completed" }),
      shieldStatus: async () => ({ id: "r", receiver: ESCROW, state: "shielded", updatedAt: T0 }) as never,
    });
    expect(await tick(io, LATER)).toBe("settled");
    expect(stored().state).toBe("completed");
    expect(rec()?.state).toBe("COMPLETED");
  });
});

describe("a campaign step delivered without an amount, its rest back (K4)", () => {
  it("settles for what did not come back — never 'partial' at every pass, its whole amount in flight", () => {
    const step = { index: 0, state: "executing", amount: AMOUNT.toString(), orderId: ORDER } as never;
    const reading = { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "" } as never;
    const next = trancheStateOf(
      step,
      reading,
      refundedJob as SwapJob,
      put({ ...handedOver, refunds: refundNote(AMOUNT / 4n) }),
      "source-final" as never,
      "ethereum",
      T0,
      {},
    );
    expect(next?.state).toBe("settled");
    expect(next?.patch.amount, "the part that did not come back").toBe(((AMOUNT * 3n) / 4n).toString());
    expect(next?.patch.outcome?.refunded).toBe((AMOUNT / 4n).toString());
    expect(next?.patch.funded, "what was handed over stays the step's own amount").toBe(AMOUNT.toString());
    // a refund note larger than the step (a second funding of the same escrow): never a negative step
    const over = trancheStateOf(
      step,
      reading,
      refundedJob as SwapJob,
      put({ ...handedOver, refunds: refundNote(AMOUNT * 2n) }),
      "source-final" as never,
      "ethereum",
      T0,
      {},
    );
    expect(over?.patch.amount).toBe("0");
    expect(over?.patch.outcome?.refunded).toBe(AMOUNT.toString());
    // nothing back yet: still partial, waiting
    const none = trancheStateOf(step, reading, null, put(handedOver), "source-final" as never, "ethereum", T0, {});
    expect(none?.state).toBe("partial");
  });
});

describe("1b reads again what it could not read (the tests critic's T5; the fifth critique)", () => {
  it("the flag false and the escrow not read, or the flag not read: the same tick a minute later — its pause ended, the record saying the funds came back", async () => {
    for (const [name, over] of [
      ["the escrow not read", { escrowExecuted: async () => false, escrowBalance: async () => null }],
      ["the flag not read", { escrowExecuted: async () => null, escrowBalance: async () => 0n }],
    ] as [string, Partial<OrderIo>][]) {
      session.update((j) => {
        j.operations = [];
      });
      resetOperationsMemory();
      put({ handOverAttempt: T0, paused: { code: "handover_unknown", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote(AMOUNT) });
      schedule(LATER);
      expect(await tick(baseIo(over), LATER), name).toBe("track");
      expect(pending()?.dueAt, name).toBe(LATER + HANDOVER_RECHECK_MS);
      expect(stored().paused, `${name}: never "your funds wait in your one-time escrow" over funds already back`).toBeUndefined();
      expect(rec()?.state, name).toBe("PROVIDER_EXECUTING");
      expect(rec()?.history.at(-1)?.note, name).toBe("Executing");
    }
  });

  it("an order paused because its escrow held the whole order past its deadline never executed: its refund closes it without the flag", async () => {
    put({ handOverAttempt: T0, paused: { code: "execution_window_closed", detail: "…", at: T0 } as StoredSwap["paused"], refunds: refundNote(AMOUNT) });
    schedule(LATER);
    let flagReads = 0;
    expect(await tick(baseIo({ escrowExecuted: async () => (flagReads++, null), escrowBalance: async () => 0n }), LATER)).toBe("settled");
    expect(flagReads, "nothing executes past the deadline: the flag is not needed").toBe(0);
    expect(stored().state).toBe("refunded");
    expect(stored().paused).toBeUndefined();
    expect(rec()?.state).toBe("REFUNDED");
  });
});
