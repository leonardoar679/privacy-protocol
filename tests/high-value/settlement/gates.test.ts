// Settlement states and gates (plan §69–§70; contract §3.8, §4.2–§4.3): the plan's §70 names map onto the tranche
// machine (DESTINATION_CONFIRMED is distinct from FINALIZED), the order machine admits only its legal transitions, a user
// status never says "atomic", the gate follows the class and Maximum Safety raises it, finality is the delivered
// state plus the destination chain's elapsed-time margin.
import { describe, it, expect } from "vitest";
import { IN_FLIGHT, PREPARED, TERMINAL, FINALITY_MARGIN_SECONDS, gateFor, settledBy, type TrancheState } from "../../../reference/typescript/src/wallet/campaign";
import { nextState, userStatus, TERMINAL as ORDER_TERMINAL } from "../../../services/private-swap/src/order";
import type { OrderState } from "../../../services/private-swap/src/types";

describe("the §70 names on the tranche machine (contract §4.2)", () => {
  it("every §70 state has a tranche state; delivered-but-not-final is in flight; funded / signed / failed are pending; settled / refunded / skipped are terminal", () => {
    const map: Record<string, TrancheState> = { DRAFT: "planned", QUOTING: "ready", QUOTED: "committed", SIGNED: "signed", SUBMITTED: "executing", SOURCE_CONFIRMED: "source-confirmed", EXECUTING: "source-confirmed", DESTINATION_PENDING: "destination-submitted", DESTINATION_CONFIRMED: "destination-confirmed", FINALIZED: "settled", COMPLETED: "settled", REFUND_PENDING: "refunding", REFUNDED: "refunded", FAILED: "failed" };
    expect(Object.keys(map)).toHaveLength(14);
    for (const s of ["executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial"] as TrancheState[]) expect(IN_FLIGHT).toContain(s);
    for (const s of ["funded", "signed", "failed"] as TrancheState[]) expect(PREPARED).toContain(s);
    for (const s of ["settled", "refunded", "skipped"] as TrancheState[]) expect(TERMINAL).toContain(s);
    expect(IN_FLIGHT).not.toContain("settled");
    expect(map.DESTINATION_CONFIRMED).not.toBe(map.FINALIZED);
  });
});

describe("the order machine (V1.1 §3; contract §4.3)", () => {
  it("admits the legal transitions and throws on any other; the terminal set is fixed", () => {
    expect(nextState("QUOTED", "commit")).toBe("COMMITTED");
    expect(nextState("COMMITTED", "submit-source")).toBe("SOURCE_SUBMITTED");
    expect(nextState("SOURCE_SUBMITTED", "source-final")).toBe("SOURCE_FINAL");
    expect(nextState("SOURCE_FINAL", "executed")).toBe("PROVIDER_EXECUTING");
    expect(nextState("PROVIDER_EXECUTING", "destination-submitted")).toBe("DESTINATION_SUBMITTED");
    expect(nextState("DESTINATION_SUBMITTED", "destination-final")).toBe("DESTINATION_FINAL");
    expect(nextState("DESTINATION_FINAL", "completed")).toBe("COMPLETED");
    expect(nextState("PROVIDER_EXECUTING", "partial")).toBe("PARTIAL");
    expect(nextState("PARTIAL", "refund-window")).toBe("REFUND_PENDING");
    expect(nextState("REFUND_PENDING", "refunded")).toBe("REFUNDED");
    expect(() => nextState("COMPLETED", "commit")).toThrow(/illegal/);
    expect(() => nextState("QUOTED", "executed")).toThrow(/illegal/);
    expect(() => nextState("REFUNDED", "refund-window")).toThrow(/illegal/);
    expect(ORDER_TERMINAL).toEqual(["COMPLETED", "EXPIRED", "CANCELLED", "REFUNDED"]);
  });
  it("a user status is one of the plain words and never 'atomic'", () => {
    const states: OrderState[] = ["QUOTED", "COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED", "EXPIRED", "CANCELLED", "SOURCE_FAILED", "PROVIDER_TIMEOUT", "PARTIAL", "DESTINATION_FAILED", "REFUND_PENDING", "REFUNDED", "FAILED"];
    for (const s of states) { const u = userStatus(s); expect(["Pending", "Executing", "Completed", "Partial", "Refunding", "Refunded", "Failed"]).toContain(u); expect(u).not.toMatch(/atomic/i); }
  });
});

describe("the gate per class and finality by elapsed margin (plan §69; contract §3.8)", () => {
  it("bridge / MPC routes settle at destination final, solver and intent routes at destination submitted, atomic at source final; Maximum Safety raises every gate", () => {
    expect(gateFor("R5", "balanced")).toBe("destination-final");
    expect(gateFor("R2", "balanced")).toBe("destination-submitted");
    expect(gateFor("R4", "best-execution")).toBe("destination-submitted");
    expect(gateFor("R1", "balanced")).toBe("source");
    expect(gateFor("R2", "max-safety")).toBe("destination-final");
    expect(gateFor("R1", "max-safety")).toBe("destination-final");
  });
  it("the margins (Bitcoin 60 min, Solana 1 min, EVM 15 min) count from the delivered state; nothing settles on an unknown state (I3)", () => {
    expect(FINALITY_MARGIN_SECONDS).toMatchObject({ bitcoin: 3600, solana: 60, default: 900 });
    const t0 = 1_000_000_000;
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", deliveredSince: t0, chain: "bitcoin" }, t0 + 3599_000)).toBe(false);
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", deliveredSince: t0, chain: "bitcoin" }, t0 + 3600_000)).toBe(true);
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", deliveredSince: t0, chain: "base" }, t0 + 900_000)).toBe(true);
    expect(settledBy("destination-final", { state: "DESTINATION_FINAL", deliveredSince: t0, chain: "solana" }, t0 + 60_000)).toBe(true);
    expect(settledBy("destination-submitted", { state: "DESTINATION_SUBMITTED", chain: "bitcoin" }, t0)).toBe(true);
    expect(settledBy("source", { state: "SOURCE_FINAL", chain: "bitcoin" }, t0)).toBe(true);
    expect(settledBy("destination-final", { state: "DESTINATION_SUBMITTED", chain: "bitcoin" }, t0 + 10 ** 9)).toBe(false);
    for (const gate of ["source", "destination-submitted", "destination-final"] as const) expect(settledBy(gate, { state: "UNKNOWN", chain: "bitcoin" }, t0 + 10 ** 9), gate).toBe(false);
  });
});
