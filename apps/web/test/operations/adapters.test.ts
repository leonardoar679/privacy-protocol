// The adapters (spec v2.0 §12, the mapping table): every OrderState of the tracker, every SwapJobState of the executor,
// every TrancheState and PauseReason of the campaign, a journaled order with or without the tracker's read — into the
// one vocabulary, with a catalog code on every failure and a delay as an attribute; and I-O5: "Transaction failed" is
// never the words of a delay, a provider that executed or a destination still confirming.
import { describe, expect, it } from "vitest";
import { ORDER_STATE_MAP, PAUSE_MAP, STORED_SWAP_MAP, SWAP_JOB_MAP, fromCampaign, fromStoredSwap, fromTranche } from "@privacy-wallet/sdk/operations/adapters";
import { CODES } from "@privacy-wallet/sdk/operations/errors/catalog";
import { recordWords, stateWords } from "../../src/features/operations/recovery";
import { t } from "../../src/app/i18n/messages";
import { FAILURE_STATES, OPERATION_STATES, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import type { OrderState } from "@privacy-wallet/sdk/orderTracker";
import type { SwapJobState } from "@privacy-wallet/sdk/relayer";
import type { PauseReason, TrancheState } from "@privacy-wallet/protocol/wallet/campaign";

const ORDER_STATES: OrderState[] = ["COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED", "PARTIAL", "REFUND_PENDING", "PROVIDER_TIMEOUT", "DESTINATION_FAILED", "REFUNDED", "EXPIRED", "CANCELLED", "FAILED", "LATE_REFUND", "DROPPED", "REFUNDED_AT_DESTINATION", "PROVIDER_FAILED"];
const JOB_STATES: SwapJobState[] = ["waiting-funding", "expired", "refund-only", "executing", "executed", "execute-failed", "refunding", "refunded", "refund-failed", "completed", "lapsed"];
const TRANCHE_STATES: TrancheState[] = ["planned", "ready", "committed", "funded", "signed", "executing", "source-confirmed", "destination-submitted", "destination-confirmed", "settled", "partial", "refunding", "refunded", "failed", "skipped"];
const PAUSES: PauseReason[] = ["price-deviation", "provider-error", "chain-congestion", "route-degraded", "unexpected-destination", "security-incident", "anomaly", "reconcile", "bounds", "user", "wallet-pause", "velocity"];

/** Every row: a state of the list; a failure state names a catalog code; a delay names one and qualifies an open state; nothing maps to FAILED (I-O6: an order's outcome is tracked). */
function wellFormed(k: string, m: { state: OperationState; code?: string; delayed?: true }): void {
  expect(OPERATION_STATES, k).toContain(m.state);
  if (FAILURE_STATES.includes(m.state)) expect(CODES, `${k} names a code`).toContain(m.code);
  if (m.code) expect(CODES, k).toContain(m.code);
  if (m.delayed) expect(["AWAITING_AUTHORIZATION", "PREPARING_PROOF", "SUBMITTING", "SOURCE_CONFIRMING", "PROVIDER_EXECUTING", "DESTINATION_CONFIRMING", "REFUNDING"], k).toContain(m.state);
  expect(m.state, `${k}: an order is never final-failed by an adapter`).not.toBe("FAILED");
}

describe("the mapping table", () => {
  it("every OrderState of the tracker has a row: the source legs EXECUTING, the destination SETTLING, a provider past its window a delay", () => {
    expect(Object.keys(ORDER_STATE_MAP).sort()).toEqual([...ORDER_STATES].sort());
    for (const [k, m] of Object.entries(ORDER_STATE_MAP)) wellFormed(k, m);
    expect(ORDER_STATE_MAP.SOURCE_SUBMITTED.state, "the funding confirming").toBe("SOURCE_CONFIRMING");
    expect(ORDER_STATE_MAP.SOURCE_FINAL.state).toBe("PROVIDER_EXECUTING");
    expect(ORDER_STATE_MAP.PROVIDER_EXECUTING.state).toBe("PROVIDER_EXECUTING");
    expect(ORDER_STATE_MAP.DESTINATION_SUBMITTED.state).toBe("DESTINATION_CONFIRMING");
    expect(ORDER_STATE_MAP.DESTINATION_FINAL.state).toBe("DESTINATION_CONFIRMING");
    expect(ORDER_STATE_MAP.PROVIDER_TIMEOUT).toEqual({ state: "PROVIDER_EXECUTING", phase: "execution", code: "provider_timeout", delayed: true });
    expect(ORDER_STATE_MAP.DESTINATION_FAILED).toMatchObject({ state: "RECOVERY_REQUIRED", code: "destination_failed" });
    expect(ORDER_STATE_MAP.FAILED).toMatchObject({ state: "RECOVERY_REQUIRED", code: "needs_attention" });
    // the twelfth review round, XH: a relayer's "refunded" over an escrow that still holds the order — nothing was swapped, the funds held for it
    expect(ORDER_STATE_MAP.DROPPED).toMatchObject({ state: "RECOVERY_REQUIRED", phase: "execution", code: "execution_window_closed" });
    expect(ORDER_STATE_MAP.PARTIAL).toMatchObject({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
    expect(ORDER_STATE_MAP.EXPIRED, "V7: a funded order past its window waits for the return").toMatchObject({ state: "RECOVERY_REQUIRED", code: "order_expired" });
    expect(ORDER_STATE_MAP.REFUND_PENDING.state).toBe("REFUNDING");
    expect(ORDER_STATE_MAP.CANCELLED.state).toBe("CANCELLED");
    // a refund back after the executor's watch (audit round 2, r36): the wallet's to return, its funds still protected
    expect(ORDER_STATE_MAP.LATE_REFUND).toMatchObject({ state: "RECOVERY_REQUIRED", phase: "settlement", code: "late_refund" });
    // the sixth review round (2026-11-03): a refund paid at the destination is the order's end; a provider failure with nothing back needs attention with its reason
    expect(ORDER_STATE_MAP.REFUNDED_AT_DESTINATION).toMatchObject({ state: "COMPLETED", phase: "settlement" });
    expect(ORDER_STATE_MAP.PROVIDER_FAILED).toMatchObject({ state: "RECOVERY_REQUIRED", phase: "settlement", code: "provider_failed" });
  });
  it("every SwapJobState of the executor has a row; a journaled order's own state is read the same way", () => {
    expect(Object.keys(SWAP_JOB_MAP).sort()).toEqual([...JOB_STATES].sort());
    for (const [k, m] of Object.entries(SWAP_JOB_MAP)) wellFormed(k, m);
    expect(SWAP_JOB_MAP["waiting-funding"].state).toBe("SOURCE_CONFIRMING");
    expect(SWAP_JOB_MAP.executing.state).toBe("PROVIDER_EXECUTING");
    expect(SWAP_JOB_MAP.executed.state).toBe("PROVIDER_EXECUTING");
    expect(SWAP_JOB_MAP["execute-failed"]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "execute_failed" });
    expect(SWAP_JOB_MAP["refund-failed"]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "refund_failed" });
    expect([SWAP_JOB_MAP.expired.state, SWAP_JOB_MAP["refund-only"].state, SWAP_JOB_MAP.refunding.state]).toEqual(["REFUNDING", "REFUNDING", "REFUNDING"]);
    expect(STORED_SWAP_MAP.committed.state).toBe("AWAITING_AUTHORIZATION");
    expect(STORED_SWAP_MAP.funded.state, "funded: submitted, never back before it (I-O7)").toBe("SOURCE_CONFIRMING");
    expect(STORED_SWAP_MAP.abandoned.state).toBe("CANCELLED");
    expect(STORED_SWAP_MAP.completed.state).toBe("COMPLETED");
  });
  it("a journaled order: the tracker's read wins, else its own state, else what the funding says", () => {
    expect(fromStoredSwap({ state: "funded", fundedTx: "0x1" }, { state: "DESTINATION_SUBMITTED" }).state).toBe("DESTINATION_CONFIRMING");
    expect(fromStoredSwap({ state: "executing" }, null).state).toBe("PROVIDER_EXECUTING");
    expect(fromStoredSwap({ state: "something-new", fundedTx: "0x1" }, null).state).toBe("SOURCE_CONFIRMING");
    expect(fromStoredSwap({ state: "something-new" }, null).state).toBe("AWAITING_AUTHORIZATION");
  });
  it("every TrancheState has a mapping; `failed` needs recovery before the hand-over (the send's outcome is unknown) and after it", () => {
    for (const s of TRANCHE_STATES) wellFormed(s, fromTranche(s, false));
    expect(fromTranche("failed", false)).toMatchObject({ state: "RECOVERY_REQUIRED", code: "send_failed" });
    expect(fromTranche("failed", true)).toMatchObject({ state: "RECOVERY_REQUIRED", code: "execute_failed" });
    expect(fromTranche("planned", false).state).toBe("READY_TO_REVIEW");
    expect(fromTranche("destination-confirmed", true).state).toBe("DESTINATION_CONFIRMING");
    expect(fromTranche("source-confirmed", true).state).toBe("PROVIDER_EXECUTING");
    expect(fromTranche("settled", true).state).toBe("COMPLETED");
    expect(fromTranche("skipped", false).state).toBe("CANCELLED");
    expect(fromTranche("partial", true)).toMatchObject({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
  });
  it("a campaign: every pause reason has a row (a congestion, the velocity rule and a pause the user asked for are delays); running follows its furthest open step", () => {
    expect(Object.keys(PAUSE_MAP).sort()).toEqual([...PAUSES].sort());
    for (const [k, m] of Object.entries(PAUSE_MAP)) { wellFormed(k, m); expect(CODES, k).toContain(m.code!); }
    expect(PAUSE_MAP["chain-congestion"]).toEqual({ state: "PROVIDER_EXECUTING", code: "chain_congestion", delayed: true });
    expect(PAUSE_MAP.user).toEqual({ state: "PROVIDER_EXECUTING", code: "user_pause", delayed: true });
    expect(PAUSE_MAP["wallet-pause"]).toEqual({ state: "PROVIDER_EXECUTING", code: "wallet_pause", delayed: true });
    expect(PAUSE_MAP.velocity).toEqual({ state: "PROVIDER_EXECUTING", code: "velocity", delayed: true });
    expect(PAUSE_MAP.reconcile.state).toBe("RECOVERY_REQUIRED");
    expect(PAUSE_MAP["provider-error"].state).toBe("RECOVERY_REQUIRED");
    const tranche = (index: number, state: TrancheState, over: Record<string, unknown> = {}) => ({ index, amount: "1", state, attempt: 1, ...over }) as never;
    expect(fromCampaign({ state: "paused", pause: { reason: "price-deviation", detail: "", at: 1 }, tranches: [] })).toEqual({ state: "RECOVERY_REQUIRED", code: "price_deviation", phase: "execution" });
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "settled"), tranche(1, "destination-submitted", { jobId: "j" }), tranche(2, "planned")] }).state).toBe("DESTINATION_CONFIRMING");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "settled"), tranche(1, "committed"), tranche(2, "planned")] }).state, "a running campaign was submitted (I-O7)").toBe("SOURCE_CONFIRMING");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "planned")] }).state).toBe("SOURCE_CONFIRMING");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "failed", { jobId: "j", handedOverAt: 1 })] })).toMatchObject({ state: "RECOVERY_REQUIRED", code: "execute_failed" });
    expect(fromCampaign({ state: "completed", tranches: [] }).state).toBe("COMPLETED");
    expect(fromCampaign({ state: "cancelled", tranches: [] }).state).toBe("CANCELLED");
    expect(fromCampaign({ state: "winding-down", tranches: [] }).state).toBe("REFUNDING");
    expect(fromCampaign({ state: "preparing-notes", tranches: [] }).state).toBe("AWAITING_AUTHORIZATION");
    expect(fromCampaign({ state: "requoting", tranches: [] })).toMatchObject({ state: "RECOVERY_REQUIRED", code: "quote_expired" });
  });
});

describe("I-O5 — the words never say the transaction failed while the truth is a delay", () => {
  it("only FAILED speaks of a failed transaction; a delay, a provider that executed or a destination still confirming has its own words", () => {
    const failing = OPERATION_STATES.filter((s) => /transaction failed/i.test(stateWords(s, t)));
    expect(failing).toEqual(["FAILED"]);
    const delayedOrVerifying: OperationState[] = [
      ORDER_STATE_MAP.DESTINATION_SUBMITTED.state, ORDER_STATE_MAP.DESTINATION_FINAL.state, ORDER_STATE_MAP.PROVIDER_EXECUTING.state, ORDER_STATE_MAP.PROVIDER_TIMEOUT.state,
      SWAP_JOB_MAP.executed.state, SWAP_JOB_MAP.executing.state, PAUSE_MAP["chain-congestion"].state, fromTranche("destination-confirmed", true).state, fromTranche("source-confirmed", true).state,
    ];
    for (const s of delayedOrVerifying) expect(stateWords(s, t), s).not.toMatch(/fail/i);
    expect(recordWords({ state: "PROVIDER_EXECUTING", delayed: { since: 1, code: "provider_timeout" } }, t)).toBe("Taking longer than expected");
    expect(recordWords({ state: "FAILED", delayed: { since: 1, code: "x" } }, t), "a terminal record says its state").toBe("Transaction failed");
    expect(stateWords("DESTINATION_CONFIRMING", t)).toBe("Settling at the destination");
    expect(stateWords("SOURCE_CONFIRMING", t)).toBe("Confirming on the network");
    expect(stateWords("RECOVERY_REQUIRED", t)).toBe("Needs attention");
  });
});
