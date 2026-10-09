// The adapters (spec §12, the mapping table): every OrderState of the tracker, every SwapJobState of the executor,
// every TrancheState and PauseReason of the campaign, a journaled order with or without the tracker's read — into
// the one vocabulary, with a catalog code on every failure; and I-O5: "Transaction failed" is never the words of a
// provider that executed or a destination still confirming.
import { describe, expect, it } from "vitest";
import { ORDER_STATE_MAP, PAUSE_MAP, STORED_SWAP_MAP, SWAP_JOB_MAP, fromCampaign, fromStoredSwap, fromTranche } from "../../src/features/operations/adapters";
import { CODES } from "../../src/features/operations/errors/catalog";
import { stateWords } from "../../src/features/operations/recovery";
import { t } from "../../src/app/i18n/messages";
import { OPERATION_STATES, type OperationState } from "../../src/wallet/operationRecord";
import type { OrderState } from "../../src/sdk/orderTracker";
import type { SwapJobState } from "../../src/sdk/relayer";
import type { PauseReason, TrancheState } from "@ref/wallet/campaign";

const ORDER_STATES: OrderState[] = ["COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED", "PARTIAL", "REFUND_PENDING", "PROVIDER_TIMEOUT", "DESTINATION_FAILED", "REFUNDED", "EXPIRED", "CANCELLED", "FAILED"];
const JOB_STATES: SwapJobState[] = ["waiting-funding", "expired", "refund-only", "executing", "executed", "execute-failed", "refunding", "refunded", "refund-failed", "completed"];
const TRANCHE_STATES: TrancheState[] = ["planned", "ready", "committed", "funded", "signed", "executing", "source-confirmed", "destination-submitted", "destination-confirmed", "settled", "partial", "refunding", "refunded", "failed", "skipped"];
const PAUSES: PauseReason[] = ["price-deviation", "provider-error", "chain-congestion", "route-degraded", "unexpected-destination", "security-incident", "anomaly", "reconcile", "bounds", "user", "wallet-pause", "velocity"];

describe("the mapping table", () => {
  it("every OrderState of the tracker has a row, every row a state of the list and a catalog code where it fails", () => {
    expect(Object.keys(ORDER_STATE_MAP).sort()).toEqual([...ORDER_STATES].sort());
    for (const [k, m] of Object.entries(ORDER_STATE_MAP)) { expect(OPERATION_STATES, k).toContain(m.state); if (m.code) expect(CODES, k).toContain(m.code); }
    expect(ORDER_STATE_MAP.DESTINATION_SUBMITTED.state).toBe("SETTLEMENT_VERIFYING");
    expect(ORDER_STATE_MAP.DESTINATION_FINAL.state).toBe("SETTLEMENT_VERIFYING");
    expect(ORDER_STATE_MAP.PROVIDER_EXECUTING.state).toBe("NETWORK_CONFIRMING");
    expect(ORDER_STATE_MAP.PROVIDER_TIMEOUT).toEqual({ state: "NETWORK_DELAYED", phase: "execution", code: "provider_timeout" });
    expect(ORDER_STATE_MAP.DESTINATION_FAILED).toMatchObject({ state: "PROVIDER_FAILED", code: "destination_failed" });
    expect(ORDER_STATE_MAP.FAILED).toMatchObject({ state: "RECOVERY_REQUIRED", code: "needs_attention" });
    expect(ORDER_STATE_MAP.PARTIAL).toMatchObject({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
    expect(ORDER_STATE_MAP.EXPIRED).toMatchObject({ state: "QUOTE_EXPIRED", code: "order_expired" });
    expect(ORDER_STATE_MAP.REFUND_PENDING.state).toBe("REFUNDING");
    expect(ORDER_STATE_MAP.CANCELLED.state).toBe("CANCELLED");
  });
  it("every SwapJobState of the executor has a row; a journaled order's own state is read the same way", () => {
    expect(Object.keys(SWAP_JOB_MAP).sort()).toEqual([...JOB_STATES].sort());
    for (const [k, m] of Object.entries(SWAP_JOB_MAP)) { expect(OPERATION_STATES, k).toContain(m.state); if (m.code) expect(CODES, k).toContain(m.code); }
    expect(SWAP_JOB_MAP["waiting-funding"].state).toBe("SUBMITTED");
    expect(SWAP_JOB_MAP.executing.state).toBe("RELAYER_EXECUTING");
    expect(SWAP_JOB_MAP.executed.state).toBe("NETWORK_CONFIRMING");
    expect(SWAP_JOB_MAP["execute-failed"]).toMatchObject({ state: "PROVIDER_FAILED", code: "execute_failed" });
    expect(SWAP_JOB_MAP["refund-failed"]).toMatchObject({ state: "RECOVERY_REQUIRED", code: "refund_failed" });
    expect([SWAP_JOB_MAP.expired.state, SWAP_JOB_MAP["refund-only"].state, SWAP_JOB_MAP.refunding.state]).toEqual(["REFUNDING", "REFUNDING", "REFUNDING"]);
    expect(STORED_SWAP_MAP.committed.state).toBe("AWAITING_SIGNATURE");
    expect(STORED_SWAP_MAP.funded.state).toBe("AWAITING_SIGNATURE");
    expect(STORED_SWAP_MAP.abandoned.state).toBe("CANCELLED");
    expect(STORED_SWAP_MAP.completed.state).toBe("COMPLETED");
  });
  it("a journaled order: the tracker's read wins, else its own state, else what the funding says", () => {
    expect(fromStoredSwap({ state: "funded", fundedTx: "0x1" }, { state: "DESTINATION_SUBMITTED" }).state).toBe("SETTLEMENT_VERIFYING");
    expect(fromStoredSwap({ state: "executing" }, null).state).toBe("RELAYER_EXECUTING");
    expect(fromStoredSwap({ state: "something-new", fundedTx: "0x1" }, null).state).toBe("SUBMITTED");
    expect(fromStoredSwap({ state: "something-new" }, null).state).toBe("AWAITING_SIGNATURE");
  });
  it("every TrancheState has a mapping; `failed` is a submission failure before the hand-over and a provider failure after it", () => {
    for (const s of TRANCHE_STATES) { const m = fromTranche(s, false); expect(OPERATION_STATES, s).toContain(m.state); if (m.code) expect(CODES, s).toContain(m.code); }
    expect(fromTranche("failed", false)).toMatchObject({ state: "SUBMISSION_FAILED", code: "send_failed" });
    expect(fromTranche("failed", true)).toMatchObject({ state: "PROVIDER_FAILED", code: "execute_failed" });
    expect(fromTranche("destination-confirmed", true).state).toBe("SETTLEMENT_VERIFYING");
    expect(fromTranche("source-confirmed", true).state).toBe("NETWORK_CONFIRMING");
    expect(fromTranche("settled", true).state).toBe("COMPLETED");
    expect(fromTranche("skipped", false).state).toBe("CANCELLED");
    expect(fromTranche("partial", true)).toMatchObject({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
  });
  it("a campaign: every pause reason has a row; running follows its furthest open step; the other states map directly", () => {
    expect(Object.keys(PAUSE_MAP).sort()).toEqual([...PAUSES].sort());
    for (const [k, m] of Object.entries(PAUSE_MAP)) { expect(OPERATION_STATES, k).toContain(m.state); expect(CODES, k).toContain(m.code!); }
    expect(PAUSE_MAP["chain-congestion"]).toEqual({ state: "NETWORK_DELAYED", code: "chain_congestion" });
    expect(PAUSE_MAP.user).toEqual({ state: "SIGNATURE_REJECTED", code: "user_pause" });
    expect(PAUSE_MAP.reconcile.state).toBe("RECOVERY_REQUIRED");
    const tranche = (index: number, state: TrancheState, over: Record<string, unknown> = {}) => ({ index, amount: "1", state, attempt: 1, ...over }) as never;
    expect(fromCampaign({ state: "paused", pause: { reason: "price-deviation", detail: "", at: 1 }, tranches: [] })).toEqual({ state: "QUOTE_EXPIRED", code: "price_deviation", phase: "execution" });
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "settled"), tranche(1, "destination-submitted", { jobId: "j" }), tranche(2, "planned")] }).state).toBe("SETTLEMENT_VERIFYING");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "settled"), tranche(1, "committed"), tranche(2, "planned")] }).state).toBe("SUBMITTED");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "planned")] }).state).toBe("SUBMITTED");
    expect(fromCampaign({ state: "running", tranches: [tranche(0, "failed", { jobId: "j", handedOverAt: 1 })] })).toMatchObject({ state: "PROVIDER_FAILED", code: "execute_failed" });
    expect(fromCampaign({ state: "completed", tranches: [] }).state).toBe("COMPLETED");
    expect(fromCampaign({ state: "cancelled", tranches: [] }).state).toBe("CANCELLED");
    expect(fromCampaign({ state: "winding-down", tranches: [] }).state).toBe("REFUNDING");
    expect(fromCampaign({ state: "preparing-notes", tranches: [] }).state).toBe("AWAITING_SIGNATURE");
    expect(fromCampaign({ state: "requoting", tranches: [] })).toMatchObject({ state: "QUOTE_EXPIRED", code: "quote_expired" });
  });
});

describe("I-O5 — the words never say the transaction failed while the truth is a delay", () => {
  it("only SUBMISSION_FAILED speaks of a failed transaction; what a provider executed or a destination still confirming maps elsewhere", () => {
    const failing = OPERATION_STATES.filter((s) => /transaction failed/i.test(stateWords(s, t)));
    expect(failing).toEqual(["SUBMISSION_FAILED"]);
    const delayedOrVerifying: OperationState[] = [
      ORDER_STATE_MAP.DESTINATION_SUBMITTED.state, ORDER_STATE_MAP.DESTINATION_FINAL.state, ORDER_STATE_MAP.PROVIDER_EXECUTING.state, ORDER_STATE_MAP.PROVIDER_TIMEOUT.state,
      SWAP_JOB_MAP.executed.state, SWAP_JOB_MAP.executing.state, PAUSE_MAP["chain-congestion"].state, fromTranche("destination-confirmed", true).state, fromTranche("source-confirmed", true).state,
    ];
    for (const s of delayedOrVerifying) expect(stateWords(s, t), s).not.toMatch(/fail/i);
    expect(stateWords("NETWORK_DELAYED", t)).toBe("Taking longer than expected");
    expect(stateWords("SETTLEMENT_VERIFYING", t)).toBe("Verifying settlement");
    expect(stateWords("PROVIDER_FAILED", t)).toBe("The provider could not complete");
    expect(stateWords("RECOVERY_REQUIRED", t)).toBe("Needs attention");
  });
});
