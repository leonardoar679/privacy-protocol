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
  v: 2,
  id: "swap:1",
  kind: "cross-chain",
  state: "EXECUTING",
  createdAt: 1,
  updatedAt: 1,
  amounts: { asset: "ETH", decimals: 18, input: AMOUNT.toString() },
  fees: [],
  destination: { kind: "fresh", display: "bc1q…", chain: "bitcoin" },
  refs: { txHashes: [FUNDED.fundedTx], orderId: "0x" + "0a".repeat(32) },
  tier: "standard",
  history: [
    { state: "SUBMITTED", at: 1 },
    { state: "EXECUTING", at: 1 },
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
    expect(ORDER_STATE_MAP[t.state].state).toBe("EXECUTING");
  });
  it("the source confirmed, the destination delayed: SETTLING with the destination pending — wait, no refund, no failure", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const t = deriveState(
      s,
      facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "destination-submitted", destinationTxHash: "0x" + "33".repeat(32) } }),
    );
    expect([ORDER_STATE_MAP[t.state].state, t.settlement]).toEqual(["SETTLING", "DESTINATION_PENDING"]);
    const rec = swapRecord({ state: "SETTLING", settlement: t.settlement });
    expect(canRefund(rec), "the money left the escrow").toBe(false);
    expect(needsAttention(rec)).toBe(false);
  });
  it("the provider delivered, the executor's completion is late: the money arrived (settlement COMPLETED) while the record settles — never failed", () => {
    const s = stored({ ...FUNDED, jobId: "job-1", executionTx: "0x" + "22".repeat(32) });
    const t = deriveState(
      s,
      facts({ job: job("executed", { executionTx: s.executionTx }), track: { state: "destination-final", deliveredAmount: "2990000" } }),
    );
    expect([ORDER_STATE_MAP[t.state].state, t.settlement]).toEqual(["SETTLING", "COMPLETED"]);
    const done = deriveState(s, facts({ job: job("completed", { executionTx: s.executionTx }), track: { state: "completed", deliveredAmount: "2990000" } }));
    expect([ORDER_STATE_MAP[done.state].state, done.settlement]).toEqual(["COMPLETED", "COMPLETED"]);
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
      { state: "EXECUTING", phase: "execution", code: "provider_timeout", delayed: true },
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
    const before = swapRecord({ state: "EXECUTING", settlement: "SOURCE_CONFIRMED" });
    const back = transition(before, { type: "resume", to: ORDER_STATE_MAP[t.state].state }, 2);
    expect(back.ok && back.record.state).toBe("CONFIRMING");
    expect(back.ok && back.record.refs.txHashes, "the same funding transaction, nothing new").toEqual(before.refs.txHashes);
    const forward = deriveState(s, facts({ escrowBalance: AMOUNT }));
    expect(forward.settlement, "re-included: confirmed again").toBe("SOURCE_CONFIRMED");
  });
  it("a quote expired: before the funding nothing moved (QUOTE_EXPIRED, not moved); after it, the record waits for the user's choice", () => {
    const t = deriveState(stored(), facts({ now: NOW + 3_600_000 }));
    expect(ORDER_STATE_MAP[t.state]).toMatchObject({ state: "QUOTE_EXPIRED", code: "order_expired" });
    expect(t.settlement).toBeUndefined();
    const funded = swapRecord({
      state: "CONFIRMING",
      history: [
        { state: "SUBMITTED", at: 1 },
        { state: "CONFIRMING", at: 1 },
      ],
    });
    const moved = transition(funded, { type: "quote-expired", code: "minimum_moved" }, 2);
    expect(moved.ok && moved.record).toMatchObject({ state: "QUOTE_EXPIRED", reason: { code: "minimum_moved", fundsClass: "still-protected" } });
    expect(moved.ok && needsAttention(moved.record)).toBe(true);
    expect(moved.ok && transition(moved.record, { type: "review" }, 3).ok, "never back before the funding (I-O7)").toBe(false);
    expect(moved.ok && transition(moved.record, { type: "resume", to: "EXECUTING" }, 3).ok, "the new minimum accepted").toBe(true);
    expect(moved.ok && transition(moved.record, { type: "refunding" }, 3).ok, "or the money back").toBe(true);
  });
});
