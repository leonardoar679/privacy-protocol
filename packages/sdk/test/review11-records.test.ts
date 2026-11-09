// The eleventh review round (2026-11-04), part B — the chain reads and the records after round 10. A refund the scan finds never closes an order
// that executed: the runner reads its job and its provider first, and one that never executed is closed with its pause (B11-1, B11-2, and the
// critic's campaign step); a closed order re-synced without a reading keeps the journal's last one — a partial fill delivered in part, a
// provider failure whose funds came back refunded (B11-1, VB-N1); a partial-unreturned outcome refines when the rest comes back (B11-8); the
// tracker says what is known of the rest and takes a token symbol only as a symbol (B11-9, B11-13); a Deposited log listed twice is one event
// (B11-5); an endpoint is one however its URL is spelled (B11-12). The reviewer's and the verifier's probes (scratchpad review11/B, VB) became
// these cases.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { journalRefunds } from "../src/privateTx";
import type { RecoveredRefund } from "../src/refunds";
import { syncSwapRecord, swapRecordId } from "../src/operations/swapRecords";
import { getOperation, resetOperationsMemory } from "../src/operations/store";
import { deriveState, trackOrder } from "../src/orderTracker";
import { runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import type { SwapJob } from "../src/relayer";
import { trancheStateOf } from "../src/wallet/campaignRunner";
import { depositedLogs, type Deployment } from "../src/chain";
import { rpcUrlsOf } from "../src/rpcUrls";
import { ProviderCallUnverified, THORNODE_ANSWER_MAX_BYTES, thornodeInbound } from "../src/providerCall";
import { AnswerTooLarge, readCapped } from "@privacy-wallet/privacy-engine/transport/http";
import type { StoredSwap } from "../src/wallet/journal";

const ORDER = "0x" + "ab".repeat(32);
const T0 = Date.parse("2026-11-04T12:00:00Z");
const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
beforeEach(() => {
  resetOperationsMemory();
  session.update((j) => {
    j.swaps = [];
    j.schedule = [];
    j.operations = [];
  });
});

const order = (extra: Partial<StoredSwap> = {}): StoredSwap => {
  const s = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: (10n ** 18n).toString(),
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      slippageBps: 50,
    },
    params: { amount: (10n ** 18n).toString(), executeDeadline: Math.floor(T0 / 1000) + 3600 },
    endpoint: "0x00000000000000000000000000000000000000e5",
    quote: { provider: "thorchain", toAmount: "3000000", toAmountMin: "2970000" },
    approvedMin: "2970000",
    createdAt: T0,
    state: "funded",
    fundedTx: "0x" + "fa".repeat(32),
    refundNoteData: "0x00",
    ...extra,
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [...j.swaps.filter((x) => x.orderId !== s.orderId), s];
  });
  return s;
};
const stored = () => session.journal().swaps.find((x) => x.orderId === ORDER)!;
const refund = (leafIndex = 9): RecoveredRefund =>
  ({
    orderId: ORDER,
    kind: "refund",
    leafIndex,
    note: { vaultId: BigInt("0x" + "e7".padStart(40, "0")), amount: 4n * 10n ** 17n, ownerCommitment: 1n, noteSecret: 2n },
    commitment: 3n,
    noteData: "0x",
    txHash: "0x" + "cd".repeat(32),
    counter: 7,
  }) as unknown as RecoveredRefund;

/** The order's runner, one tick at `now`, the escrow read empty and its flag false (the twelfth review round, C12-1: the runner closes what the scan finds). */
const runnerTick = async (now: number, jobState?: SwapJob["state"]) => {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const track: OrderIo["track"] = (st) =>
    trackOrder(st, {
      deployment: null,
      session,
      now,
      readers: {
        job: async () => (jobState ? ({ id: "job-1", escrow: st.endpoint, state: jobState, updatedAt: T0 } as SwapJob) : null),
        balance: async () => 0n,
        track: async () => null,
        executed: async () => false,
      },
    });
  const io: OrderIo = {
    fund: unused,
    escrowBalance: async () => 0n,
    escrowExecuted: async () => false,
    sign: unused,
    handOver: unused,
    job: async () => null,
    track,
    refund: unused,
    shieldStatus: async () => null,
    registerShield: unused,
    recoverShield: async () => 0,
  };
  const a = session.journal().schedule.find((x) => x.id === `order-tick:${ORDER}`)!;
  return runOrderTick(a, { masterSeed: new Uint8Array(32).fill(5), deployment: null, io, now: () => now });
};

describe("a refund the scan finds (B11-1, B11-2)", () => {
  it("never closes an order that executed: the refund is journaled, the state is the runner's, its tick due now", () => {
    order({ executionTx: "0x" + "ee".repeat(32), handedOverAt: T0, track: { state: "PARTIAL", label: "Partial", deliveredAmount: "1500000", at: T0 } });
    journalRefunds([refund()]);
    expect(stored().refunds?.map((r) => r.leafIndex)).toEqual([9]);
    expect(stored().state, "left to the runner, which reads the job and the provider").toBe("funded");
    expect(session.journal().schedule.find((a) => a.id === `order-tick:${ORDER}`)?.dueAt).toBeLessThanOrEqual(Date.now());
    expect(getOperation(swapRecordId(ORDER)), "its record not closed here from the journal's reading (the critique, W8)").toBeNull();
  });
  it("one the executor was asked about, no execution seen, is left to the runner too — which closes it once the escrow's flag says it never executed and the escrow holds dust at most (the critique; K4)", () => {
    order({ handOverAttempt: T0, paused: { code: "handover_unknown", detail: "x", at: T0 } });
    journalRefunds([refund()]);
    expect(stored().state).toBe("funded");
    expect(session.journal().schedule.some((a) => a.id === `order-tick:${ORDER}`)).toBe(true);
  });
  it("a job the relayer ended: a lapsed order takes its refund at once; one refund-failed, expired or execute-failed is left to its runner, which closes it REFUNDED once the escrow reads empty — A10-6 kept (the critique, T1; the twelfth review round, C12-1)", async () => {
    for (const state of ["lapsed"]) {
      session.update((j) => {
        j.operations = []; // a record left by the last state would pass the REFUNDED check by itself (the second critique, T5)
        j.schedule = [];
      });
      resetOperationsMemory();
      order({ state, jobId: "job-1", handedOverAt: T0 });
      syncSwapRecord(stored(), null, null, T0); // the record as it was before the scan: never REFUNDED yet
      expect(getOperation(swapRecordId(ORDER))?.state, `${state}: before the scan`).not.toBe("REFUNDED");
      journalRefunds([refund()]);
      expect(stored().state, state).toBe("refunded");
      expect(getOperation(swapRecordId(ORDER))?.state, state).toBe("REFUNDED");
      expect(
        session.journal().schedule.some((a) => a.id === `order-tick:${ORDER}`),
        `${state}: no tick for a closed order`,
      ).toBe(false);
    }
    for (const state of ["refund-failed", "expired", "execute-failed"] as const) {
      session.update((j) => {
        j.operations = [];
        j.schedule = [];
      });
      resetOperationsMemory();
      order({ state, jobId: "job-1", handedOverAt: T0 });
      journalRefunds([refund()]);
      expect(stored().state, `${state}: left to its runner`).toBe(state);
      expect(session.journal().schedule.find((a) => a.id === `order-tick:${ORDER}`)?.dueAt, state).toBeLessThanOrEqual(Date.now());
      const r = await runnerTick(T0 + 5 * 3600_000, state);
      expect(r?.step, state).toBe("settled");
      expect(stored().state, state).toBe("refunded");
      expect(getOperation(swapRecordId(ORDER))?.state, state).toBe("REFUNDED");
    }
  });
  it("an execution seen wins over the relayer's refund states: an executed order in refunding, refund-failed or refund-only is left to its runner — its partial fill's rest comes back that way (the second critique, C1)", () => {
    for (const state of ["refunding", "refund-failed", "refund-only"]) {
      session.update((j) => {
        j.operations = [];
        j.schedule = [];
      });
      resetOperationsMemory();
      order({
        state,
        jobId: "job-1",
        executionTx: "0x" + "ee".repeat(32),
        track: { state: "REFUND_PENDING", label: "Refunding", deliveredAmount: "1500000", at: T0 },
      });
      journalRefunds([refund()]);
      expect(stored().state, state).toBe(state);
      expect(getOperation(swapRecordId(ORDER)), `${state}: its record left to the runner's reading`).toBeNull();
      expect(
        session.journal().schedule.some((a) => a.id === `order-tick:${ORDER}`),
        state,
      ).toBe(true);
    }
  });
  it("a completed order's record is synced again when its refund is found — through the scan: a provider failure whose funds came back is a refund (VB-N1), a partial fill's rest came back (B11-8) (the second critique)", () => {
    order({ state: "completed", executionTx: "0x" + "ee".repeat(32), jobId: "job-1", track: { state: "PROVIDER_FAILED", label: "Failed", at: T0 } });
    syncSwapRecord(
      stored(),
      { state: "PROVIDER_FAILED", label: "Failed", steps: [true, true, false, false], detail: "" } as never,
      { state: "completed" } as never,
      T0,
    );
    expect(getOperation(swapRecordId(ORDER))?.state, "before the scan").toBe("RECOVERY_REQUIRED");
    journalRefunds([refund()]);
    expect(getOperation(swapRecordId(ORDER))?.state, "the scan found the refund").toBe("REFUNDED");
    session.update((j) => {
      j.operations = [];
    });
    resetOperationsMemory();
    order({
      state: "completed",
      executionTx: "0x" + "ee".repeat(32),
      jobId: "job-1",
      refunds: undefined,
      track: { state: "PARTIAL", label: "Partial", deliveredAmount: "1500000", at: T0 },
    });
    syncSwapRecord(
      stored(),
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "", deliveredUnits: "1500000" } as never,
      { state: "completed" } as never,
      T0,
    );
    expect(getOperation(swapRecordId(ORDER))?.outcome, "before the scan").toBe("partial-unreturned");
    journalRefunds([refund()]);
    expect(getOperation(swapRecordId(ORDER))?.outcome, "the rest came back").toBe("partial");
  });
  it("a closed order re-synced with no job takes its journaled state as the job's word: refunded — the rest came back —, completed — the watch ended (the second critique, C4)", () => {
    const partial = { state: "PARTIAL", label: "Partial", deliveredAmount: "1500000", at: T0 };
    const back = order({ state: "refunded", jobId: "job-1", executionTx: "0x" + "ee".repeat(32), track: partial });
    expect(syncSwapRecord(back, null, null, T0)).toMatchObject({ state: "COMPLETED", outcome: "partial" });
    session.update((j) => {
      j.operations = [];
    });
    resetOperationsMemory();
    const watched = order({ state: "completed", jobId: "job-1", executionTx: "0x" + "ee".repeat(32), track: partial });
    expect(syncSwapRecord(watched, null, null, T0)).toMatchObject({ state: "COMPLETED", outcome: "partial-unreturned" });
  });
  it("a campaign step delivered in another token whose symbol is refused is still undelivered in another token (the second critique, T7)", () => {
    const step = { index: 0, state: "executing", amount: "1000000000000000000", orderId: ORDER } as never;
    const next = trancheStateOf(
      step,
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "", otherToken: true } as never,
      null,
      order({ executionTx: "0x" + "ee".repeat(32) }),
      "source-final" as never,
      "ethereum",
      T0,
      {},
    );
    expect(next).toMatchObject({ state: "undelivered", patch: { outcome: { undelivered: "other-token" } } });
  });
  it("a tracker's reading is no execution: a funded order a Refresh read once, never handed over, is closed by its refund with its pause — at its runner's tick, once the escrow reads empty (the critique, W1; the twelfth review round, C12-1)", async () => {
    order({ track: { state: "PROVIDER_TIMEOUT", label: "Waiting", at: T0 }, paused: { code: "execution_window_closed", detail: "x", at: T0 } });
    journalRefunds([refund()]);
    expect(stored().state, "left to its runner").toBe("funded");
    await runnerTick(T0 + 5 * 3600_000);
    expect(stored().state).toBe("refunded");
    expect(stored().paused).toBeUndefined();
    expect(getOperation(swapRecordId(ORDER))?.state).toBe("REFUNDED");
  });
  it("closes one that never executed, its pause with it, at its runner's tick once the escrow reads empty: the record says the funds came back, never 'wait in your escrow' (C12-1)", async () => {
    order({ paused: { code: "handover_unknown", detail: "x", at: T0 } });
    journalRefunds([refund()]);
    expect(stored().state, "left to its runner").toBe("funded");
    await runnerTick(T0 + 5 * 3600_000);
    expect(stored().state).toBe("refunded");
    expect(stored().paused).toBeUndefined();
    syncSwapRecord(stored(), null, null, T0);
    expect(getOperation(swapRecordId(ORDER))?.state).toBe("REFUNDED");
  });
  it("a campaign step that executed is left to its campaign: never booked refunded from the bare state", () => {
    order({
      campaign: { id: "c1", index: 0 },
      executionTx: "0x" + "ee".repeat(32),
      track: { state: "PARTIAL", label: "Partial", deliveredAmount: "1500000", at: T0 },
    });
    journalRefunds([refund()]);
    expect(stored().state).toBe("funded");
    expect(
      session.journal().schedule.some((a) => a.id === `order-tick:${ORDER}`),
      "the campaign ticks its own steps",
    ).toBe(false);
  });
});

describe("a closed order re-synced without a reading (B11-1, VB-N1)", () => {
  it("a partial fill whose rest came back is delivered in part — never REFUNDED for good", () => {
    const s = order({
      state: "refunded",
      executionTx: "0x" + "ee".repeat(32),
      track: { state: "PARTIAL", label: "Partial", deliveredAmount: "1500000", at: T0 },
      refunds: [{ leafIndex: 9, vault: "0x" + "e7".padStart(40, "0"), amount: "400000000000000000" }],
    });
    const rec = syncSwapRecord(s, null, null, T0);
    expect(rec).toMatchObject({ state: "COMPLETED", outcome: "partial" });
    expect(rec.amounts.delivered).toBe("1500000");
  });
  it("a provider failure whose funds came back is a refund, never 'Swap complete'", () => {
    const s = order({
      state: "completed",
      executionTx: "0x" + "ee".repeat(32),
      track: { state: "PROVIDER_FAILED", label: "Failed", at: T0 },
      refunds: [{ leafIndex: 9, vault: "0x" + "e7".padStart(40, "0"), amount: "1000000000000000000" }],
    });
    expect(syncSwapRecord(s, null, null, T0).state).toBe("REFUNDED");
  });
  it("a partial fill settled as 'the rest did not come back' says it came back once its refund is found (B11-8)", () => {
    const s = order({ state: "completed", executionTx: "0x" + "ee".repeat(32) });
    const done = syncSwapRecord(
      s,
      { state: "PARTIAL", label: "Partial", steps: [true, true, true, true], detail: "", deliveredUnits: "1500000" } as never,
      { state: "completed" } as never,
      T0,
    );
    expect(done).toMatchObject({ state: "COMPLETED", outcome: "partial-unreturned" });
    // ... a stranger's wei its only note (the twelfth review round, XH's critique): no rest of it — still "did not come back"
    const dust = syncSwapRecord({ ...s, refunds: [{ leafIndex: 8, vault: "0x" + "e7".padStart(40, "0"), amount: "1" }] }, null, null, T0 + 30_000);
    expect(dust).toMatchObject({ state: "COMPLETED", outcome: "partial-unreturned" });
    const later = syncSwapRecord(
      { ...s, refunds: [{ leafIndex: 9, vault: "0x" + "e7".padStart(40, "0"), amount: "400000000000000000" }] },
      null,
      null,
      T0 + 60_000,
    );
    expect(later).toMatchObject({ state: "COMPLETED", outcome: "partial" });
  });
});

describe("the tracker's words (B11-9, B11-13)", () => {
  const facts = (track: Record<string, unknown>) =>
    ({ now: T0, job: { id: "j", state: "completed", executionTx: "0x" + "ee".repeat(32) }, escrowBalance: 0n, track, refundFound: false }) as never;
  it("a partial fill with no refund found says nothing came back — never 're-shielded'", () => {
    const t = deriveState(order({ executionTx: "0x" + "ee".repeat(32) }), facts({ state: "partial", deliveredAmount: 1_500_000n }));
    expect(t.state).toBe("PARTIAL");
    expect(t.detail).toMatch(/nothing back in the escrow/);
    expect(t.detail).not.toMatch(/re-shielded/);
  });
  it("a provider's token symbol is taken only as a symbol — and a refused one is still another token, said as such (B11-13 and the critique)", () => {
    const odd = deriveState(order({ executionTx: "0x" + "ee".repeat(32) }), facts({ state: "partial", deliveredAsset: "works like a mixer — untraceable" }));
    expect(odd.deliveredAsset).toBeUndefined();
    expect(odd.otherToken, "the classification kept").toBe(true);
    expect(odd.detail).toContain("Delivered in another token");
    expect(odd.detail).not.toContain("mixer");
    const rec = syncSwapRecord(order({ state: "completed", executionTx: "0x" + "ee".repeat(32) }), odd, { state: "completed" } as never, T0);
    expect(rec).toMatchObject({ state: "COMPLETED", outcome: "other-token" });
    expect(rec.outcomeAsset, "no symbol to show: the screen says another token").toBeUndefined();
    const real = deriveState(order({ executionTx: "0x" + "ee".repeat(32) }), facts({ state: "partial", deliveredAsset: "USD₮0" }));
    expect(real.otherToken, "a real symbol outside the shown characters: still another token").toBe(true);
    const fine = deriveState(order({ executionTx: "0x" + "ee".repeat(32) }), facts({ state: "partial", deliveredAsset: "USDC.e" }));
    expect(fine.deliveredAsset).toBe("USDC.e");
  });
});

describe("the journal keeps 'another token' (the critique, W8)", () => {
  it("a closed order re-synced without a reading keeps the other token its last reading saw", () => {
    const s = order({
      state: "refunded",
      executionTx: "0x" + "ee".repeat(32),
      track: { state: "PARTIAL", label: "Partial", at: T0, otherToken: true },
      refunds: [{ leafIndex: 9, vault: "0x" + "e7".padStart(40, "0"), amount: "400000000000000000" }],
    });
    expect(syncSwapRecord(s, null, null, T0)).toMatchObject({ state: "COMPLETED", outcome: "other-token" });
  });
});

describe("the chain reads (B11-5, B11-12)", () => {
  it("a Deposited log listed twice is one event; two different deposits at one leaf stay two", async () => {
    const d = { ethVault: "0x00000000000000000000000000000000000000e7", erc20Vaults: [], fromBlock: 0n } as unknown as Deployment;
    const log = {
      address: "0x00000000000000000000000000000000000000e7",
      args: { ownerCommitment: 5n, amount: 10n ** 18n, leafIndex: 3 },
      transactionHash: "0xaa",
      logIndex: 2,
      blockNumber: 5n,
    };
    const client = (logs: unknown[]) => ({ getBlockNumber: async () => 10n, getLogs: async () => logs }) as never;
    expect(await depositedLogs(client([log, { ...log }]), d)).toHaveLength(1);
    expect(await depositedLogs(client([log, { ...log, args: { ...log.args, amount: 2n * 10n ** 18n } }]), d)).toHaveLength(2);
  });
  it("one endpoint however its URL is spelled: the default port, a trailing host dot, an empty query", () => {
    const d = (rpcUrls: string[]) => ({ rpcUrl: rpcUrls[0], rpcUrls });
    expect(
      rpcUrlsOf(
        d([
          "https://rpc.example.org/v1/key",
          "https://rpc.example.org:443/v1/key",
          "https://rpc.example.org./v1/key",
          "https://RPC.example.org/v1/key?",
          "https://rpc.example.org/v1/key/",
        ]),
      ),
    ).toHaveLength(1);
    expect(
      rpcUrlsOf(d(["https://rpc.example.org/v1/key", "https://rpc.example.org/v1/other", "https://rpc.example.org:8545/v1/key"])),
      "distinct paths and ports stay",
    ).toHaveLength(3);
  });
});

describe("a third party's answer is read to a bound (the completeness critic, C11-11's twin)", () => {
  const MB = 1024 * 1024;
  const streaming = (total: number, counter: { pulled: number }) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (counter.pulled >= total) return c.close();
          counter.pulled += MB;
          c.enqueue(new Uint8Array(MB).fill(0x20));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  it("a THORNode gateway streaming 64 MB is no answer: the read stops at the bound, the lookup an outage", async () => {
    const counter = { pulled: 0 };
    const fetchFn = (async () => streaming(64 * MB, counter)) as unknown as typeof fetch;
    await expect(thornodeInbound("ETH", { gateways: ["https://gateway.example"], quorum: 1, fetchFn, timeoutMs: 60_000 })).rejects.toBeInstanceOf(
      ProviderCallUnverified,
    );
    expect(counter.pulled, "never the whole answer").toBeLessThanOrEqual(THORNODE_ANSWER_MAX_BYTES + 2 * MB);
  }, 60_000);
  it("a declared length past the bound is not read at all; one inside it is read whole", async () => {
    await expect(readCapped(new Response("x".repeat(100), { headers: { "content-length": String(10 * MB) } }), MB)).rejects.toBeInstanceOf(AnswerTooLarge);
    expect(await readCapped(new Response('{"a":1}'), MB)).toBe('{"a":1}');
  });
});
