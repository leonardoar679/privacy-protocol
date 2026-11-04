// The settlement of a swap (Privacy Wallet Web spec v2.0 §12.4; doc §41, §82) — the scenarios one by one, through the
// tracker's pure derivation (deriveState, legsOf), the shared settlementOf / nextSettlement, the adapters and the
// recovery model: a provider offline, the source confirmed with the destination delayed, a provider that delivered with
// the executor's completion late, a destination failure, a refund available, a refund delayed, an RPC that cannot be
// read (never a downgrade), a reorg (the leg back to pending, nothing re-sent), an expired quote.
import { describe, expect, it } from "vitest";
import { deriveState, legsOf, type TrackFacts } from "../src/orderTracker";
import { ORDER_STATE_MAP } from "../src/operations/adapters";
import { transition } from "../src/operations/reducer";
import { actionsFor, canRefund, needsAttention } from "../src/operations/recovery";
import { nextSettlement, settlementOf } from "@privacy-wallet/protocol/wallet/settlement";
import type { SwapJob } from "../src/relayer";
import type { StoredSwap } from "../src/wallet/journal";
import type { OperationRecord } from "../src/wallet/operationRecord";

const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const AMOUNT = 10n ** 18n;
const stored = (over: Partial<StoredSwap> = {}): StoredSwap =>
  ({
    orderId: "0x" + "0a".repeat(32),
    attemptId: "0x" + "0b".repeat(32),
    refundCounter: 1,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { symbol: "ETH", decimals: 18, chain: "ethereum" },
      to: { symbol: "BTC", decimals: 8, chain: "bitcoin" },
      amount: AMOUNT.toString(),
      destination: "bc1q…",
    },
    params: { amount: AMOUNT.toString(), executeDeadline: S + 1_800, refundAfter: S + 7_200 },
    endpoint: "0x" + "0c".repeat(20),
    createdAt: NOW - 60_000,
    state: "committed",
    ...over,
  }) as StoredSwap;
const FUNDED = { fundedTx: "0x" + "11".repeat(32), state: "funded" } as const;
const job = (state: SwapJob["state"], over: { executionTx?: string; error?: string } = {}): SwapJob =>
  ({ id: "job-1", escrow: "0x" + "0c".repeat(20), state, updatedAt: NOW, ...over }) as SwapJob;
const facts = (over: Partial<TrackFacts> = {}): TrackFacts => ({ now: NOW, job: null, escrowBalance: null, track: null, refundFound: false, ...over });
const withTrack = (s: StoredSwap, settlement: string | undefined): StoredSwap => ({
  ...s,
  track: { state: "x", label: "x", at: NOW - 1_000, ...(settlement ? { settlement } : {}) },
});
const swapRecord = (over: Partial<OperationRecord>): OperationRecord => ({
  v: 3,
  id: "swap:1",
  kind: "cross-chain",
  state: "PROVIDER_EXECUTING",
  createdAt: 1,
  updatedAt: 1,
  amounts: { asset: "ETH", decimals: 18, input: AMOUNT.toString() },
  fees: [],
  destination: { kind: "fresh", display: "bc1q…", chain: "bitcoin" },
  refs: { txHashes: [FUNDED.fundedTx], orderId: "0x" + "0a".repeat(32) },
  tier: "standard",
  history: [
    { state: "SOURCE_CONFIRMING", at: 1 },
    { state: "PROVIDER_EXECUTING", at: 1 },
  ],
  ...over,
});

describe("settlementOf (the legs → where the money is)", () => {
  it("the order of the rules: a final leg, a refund under way, a refund possible, the source, the destination, the provider", () => {
    expect(settlementOf({ funded: false, executed: false, refundable: false })).toBeNull();
    expect(settlementOf({ funded: true, executed: false, refundable: false })).toBe("SOURCE_CONFIRMED");
    expect(settlementOf({ funded: true, executed: true, provider: "pending", refundable: false })).toBe("PROVIDER_PENDING");
    expect(settlementOf({ funded: true, executed: true, provider: "destination-submitted", refundable: false })).toBe("DESTINATION_PENDING");
    expect(settlementOf({ funded: true, executed: true, provider: "partial", refundable: false })).toBe("DESTINATION_PENDING");
    expect(settlementOf({ funded: true, executed: true, provider: "delivered", refundable: false })).toBe("COMPLETED");
    expect(settlementOf({ funded: true, executed: false, refundable: true })).toBe("REFUND_AVAILABLE");
    expect(settlementOf({ funded: true, executed: true, refund: "pending", refundable: false })).toBe("REFUNDING");
    expect(settlementOf({ funded: true, executed: false, refund: "done", refundable: false })).toBe("COMPLETED");
    expect(nextSettlement("PROVIDER_PENDING", null), "a read that could not tell keeps the last").toBe("PROVIDER_PENDING");
  });
});

describe("§82 — the scenarios", () => {
  it("the provider offline: the execution is on chain, the provider cannot be read — the record executes on, the settlement is kept, never failed", () => {
    const s = withTrack(stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) }), "PROVIDER_PENDING");
    const t = deriveState(s, facts({ job: job("executed", { executionTx: s.executionTx }), track: null }));
    expect(legsOf(s, facts({ job: job("executed", { executionTx: s.executionTx }), track: null }))).toBeNull();
    expect(t.settlement).toBe("PROVIDER_PENDING");
    expect(ORDER_STATE_MAP[t.state].state).toBe("PROVIDER_EXECUTING");
  });
  it("the source confirmed, the destination delayed: SETTLING with the destination pending — wait, no refund, no failure", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const t = deriveState(
      s,
      facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "destination-submitted", destinationTxHash: "0x" + "33".repeat(32) } }),
    );
    expect([ORDER_STATE_MAP[t.state].state, t.settlement]).toEqual(["DESTINATION_CONFIRMING", "DESTINATION_PENDING"]);
    const rec = swapRecord({ state: "DESTINATION_CONFIRMING", settlement: t.settlement });
    expect(canRefund(rec), "the money left the escrow").toBe(false);
    expect(needsAttention(rec)).toBe(false);
  });
  it("the provider delivered, the executor's completion is late: the money arrived (settlement COMPLETED) while the record settles — never failed", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const t = deriveState(
      s,
      facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "destination-final", deliveredAmount: "2990000" } }),
    );
    expect([ORDER_STATE_MAP[t.state].state, t.settlement]).toEqual(["DESTINATION_CONFIRMING", "COMPLETED"]);
    const done = deriveState(
      s,
      facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "completed", deliveredAmount: "2990000" }, escrowBalance: 0n }),
    );
    expect([ORDER_STATE_MAP[done.state].state, done.settlement]).toEqual(["COMPLETED", "COMPLETED"]);
  });
  it("a refund the provider paid at the destination address (Mayan Fast-MCTP) is final: Refunded, the settlement complete, the record COMPLETED, the step settled (the sixth review round, 2026-11-03)", () => {
    const s = stored({
      ...FUNDED,
      provider: "mayan",
      quote: { provider: "mayan", refundTarget: "destination" },
      jobId: "job-1",
      executionTx: "0x" + "22".repeat(32),
    });
    // the executor still watches: the provider's word suffices — nothing reaches the escrow
    const t = deriveState(s, facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "refunded" }, escrowBalance: 0n }));
    expect(t.state).toBe("REFUNDED_AT_DESTINATION");
    expect(t.label).toBe("Refunded");
    expect(t.detail).toMatch(/refunded at your fresh address on the destination chain.*not to the pool/);
    expect(t.settlement).toBe("COMPLETED");
    expect(ORDER_STATE_MAP[t.state]).toMatchObject({ state: "COMPLETED" });
    // after the watch ended the same; and the track's own word (refundedTo) decides for a quote without the flag
    const done = deriveState(s, facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "refunded" }, escrowBalance: 0n }));
    expect([done.state, done.settlement]).toEqual(["REFUNDED_AT_DESTINATION", "COMPLETED"]);
    const unflagged = stored({ ...FUNDED, provider: "mayan", jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    expect(
      deriveState(unflagged, facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "refunded", refundedTo: "destination" } as never }))
        .state,
    ).toBe("REFUNDED_AT_DESTINATION");
    // an escrow refund stays what it was: a refund on its way to the escrow
    expect(deriveState(unflagged, facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "refunded" } })).state).toBe("REFUND_PENDING");
  });
  it("a provider failure after which nothing came back by the end of the executor's watch ends the order with its reason, never 'once it arrives, return it' for good (the sixth review round, 2026-11-03)", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const failed = deriveState(s, facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "failed" }, escrowBalance: 0n }));
    expect(failed.state).toBe("PROVIDER_FAILED");
    expect(failed.label).toBe("Needs attention");
    expect(failed.detail).toMatch(/the execution failed, and the executor's watch ended with nothing above dust/);
    expect(ORDER_STATE_MAP[failed.state]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "provider_failed" });
    expect(failed.settlement, "no refund is on its way: not REFUNDING").not.toBe("REFUNDING");
    // the provider says it refunded the escrow, but only dust is there after the watch: the same end
    const dust = deriveState(s, facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "refunded" }, escrowBalance: AMOUNT / 1000n }));
    expect(dust.state).toBe("PROVIDER_FAILED");
    expect(dust.detail).toMatch(/a refund to the escrow.*0\.001 ETH/);
    // a refund above the floor in the escrow is a late refund, the wallet's to return, as before
    expect(
      deriveState(s, facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "refunded" }, escrowBalance: AMOUNT / 2n })).state,
    ).toBe("LATE_REFUND");
    // before the watch ends a failure still reads as a refund under way
    expect(deriveState(s, facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "failed" } })).state).toBe("DESTINATION_FAILED");
  });
  it("after the watch ended, an escrow balance that could not be read settles nothing: the order stays open and the last settlement stands (the sixth review round, 2026-11-03)", () => {
    const s = withTrack(stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) }), "DESTINATION_PENDING");
    const unread = deriveState(
      s,
      facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "partial", deliveredAmount: "1000000" }, escrowBalance: null }),
    );
    expect(unread.state, "not PARTIAL on an unread balance").toBe("PROVIDER_EXECUTING");
    expect(unread.settlement, "kept").toBe("DESTINATION_PENDING");
    const read = deriveState(
      s,
      facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "partial", deliveredAmount: "1000000" }, escrowBalance: 0n }),
    );
    expect([read.state, read.settlement]).toEqual(["PARTIAL", "COMPLETED"]);
  });
  it("a destination failure: the provider pays the escrow back — the record needs attention, the settlement is a refund under way", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const t = deriveState(s, facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "failed" } }));
    expect(ORDER_STATE_MAP[t.state]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "destination_failed" });
    expect(t.settlement).toBe("REFUNDING");
  });
  it("a refund available: the execution failed with the escrow funded — REFUND_AVAILABLE, the refund is offered (a refund-only job, never a re-send)", () => {
    const s = stored({ ...FUNDED, jobId: "job-1" });
    const t = deriveState(s, facts({ job: job("execute-failed", { error: "ProviderCallFailed" }), escrowBalance: AMOUNT }));
    expect(t.settlement).toBe("REFUND_AVAILABLE");
    const r = transition(swapRecord({ settlement: t.settlement }), { type: "recovery-required", code: "execute_failed" }, 2);
    expect(r.ok && r.record.recovery?.state).toBe("refund-offered");
    expect(r.ok && actionsFor(r.record)).toContain("start-refund");
    const timedOut = deriveState(stored(FUNDED), facts({ escrowBalance: AMOUNT, now: NOW + 3_600_000 }));
    expect([ORDER_STATE_MAP[timedOut.state], timedOut.settlement], "no job and the window closed: a delay with the refund available").toEqual([
      { state: "PROVIDER_EXECUTING", phase: "execution", code: "provider_timeout", delayed: true },
      "REFUND_AVAILABLE",
    ]);
  });
  it("a refund delayed: the refund job runs on — REFUNDING throughout; a failed refund is offered again", () => {
    const s = withTrack(stored({ ...FUNDED, jobId: "job-1" }), "REFUNDING");
    for (const later of [0, 3_600_000, 86_400_000]) expect(deriveState(s, facts({ now: NOW + later, job: job("refunding") })).settlement).toBe("REFUNDING");
    expect(deriveState(s, facts({ job: job("refund-failed") })).settlement).toBe("REFUND_AVAILABLE");
    expect(deriveState(s, facts({ job: job("refunded") })).settlement, "the refund arrived").toBe("COMPLETED");
  });
  it("the RPC unavailable: an escrow balance or a job that cannot be read never downgrades the settlement", () => {
    const funded = withTrack(stored(FUNDED), "SOURCE_CONFIRMED");
    expect(deriveState(funded, facts({ escrowBalance: null })).settlement).toBe("SOURCE_CONFIRMED");
    const handed = withTrack(stored({ ...FUNDED, jobId: "job-1" }), "PROVIDER_PENDING");
    expect(deriveState(handed, facts({ job: null, escrowBalance: 0n })).settlement, "the job's read failed: kept").toBe("PROVIDER_PENDING");
    expect(deriveState(stored(FUNDED), facts({ escrowBalance: null })).settlement, "nothing known yet: none").toBeUndefined();
  });
  it("a reorg: the funding's leg goes back to pending (the escrow reads empty again) — the record returns to CONFIRMING, nothing is re-sent", () => {
    const s = withTrack(stored(FUNDED), "SOURCE_CONFIRMED");
    const t = deriveState(s, facts({ escrowBalance: 0n }));
    expect(t.state).toBe("SOURCE_SUBMITTED");
    expect(t.settlement, "the leg is pending again").toBeUndefined();
    const before = swapRecord({ state: "PROVIDER_EXECUTING", settlement: "SOURCE_CONFIRMED" });
    const back = transition(before, { type: "resume", to: ORDER_STATE_MAP[t.state].state }, 2);
    expect(back.ok && back.record.state).toBe("SOURCE_CONFIRMING");
    expect(back.ok && back.record.refs.txHashes, "the same funding transaction, nothing new").toEqual(before.refs.txHashes);
    const forward = deriveState(s, facts({ escrowBalance: AMOUNT }));
    expect(forward.settlement, "re-included: confirmed again").toBe("SOURCE_CONFIRMED");
  });
  it("a quote expired (V7): a funded order past its window waits for the return (RECOVERY_REQUIRED); a moved minimum after the funding waits for the user's choice", () => {
    const t = deriveState(stored(), facts({ now: NOW + 3_600_000 }));
    expect(ORDER_STATE_MAP[t.state]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "order_expired" });
    expect(t.settlement).toBeUndefined();
    const funded = swapRecord({
      state: "SOURCE_CONFIRMING",
      history: [
        { state: "SOURCE_CONFIRMING", at: 1 },
        { state: "SOURCE_CONFIRMING", at: 1 },
      ],
    });
    const moved = transition(funded, { type: "quote-expired", code: "minimum_moved" }, 2);
    expect(moved.ok && moved.record).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "minimum_moved", fundsClass: "still-protected" } });
    expect(moved.ok && needsAttention(moved.record)).toBe(true);
    expect(moved.ok && transition(moved.record, { type: "review" }, 3).ok, "never back before the funding (I-O7)").toBe(false);
    expect(moved.ok && transition(moved.record, { type: "resume", to: "PROVIDER_EXECUTING" }, 3).ok, "the new minimum accepted").toBe(true);
    expect(moved.ok && transition(moved.record, { type: "refunding" }, 3).ok, "or the money back").toBe(true);
  });
});
