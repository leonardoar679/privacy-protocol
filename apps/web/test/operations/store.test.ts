// @vitest-environment happy-dom
// The operation store (spec §12): a draft stays in memory and the journal never gains the field on its own; from
// AWAITING_SIGNATURE on the record is in the encrypted journal and survives a lock and an unlock; a later event
// updates it in place; the open and finished lists; the hooks' snapshots are stable until a change.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { applyEvent, allOperations, finishedOperations, getOperation, newOperation, openOperations, operationsOf, removeOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { emptyJournal } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useOpenOperations, useOperation } from "../../src/hooks";

const HASH = "0x" + "ef".repeat(32);
const draft = (kind: "send" | "protect" = "send") => newOperation({ kind, amounts: { asset: "ETH", decimals: 18, input: "1000" }, destination: { kind: "privacy-address", display: "pp1q…", chain: "ethereum" }, tier: "standard" }, 10_000);

beforeAll(async () => { await session.ready; session.forget(); resetOperationsMemory(); await session.create("correct horse battery staple"); });
afterAll(() => { session.forget(); resetOperationsMemory(); });

describe("where a record lives", () => {
  it("a draft stays in memory: the journal has no `operations` and emptyJournal() never writes the field", () => {
    const d = draft();
    expect(d.state).toBe("DRAFT");
    expect(getOperation(d.id)).toBe(d);
    expect(session.journal().operations).toBeUndefined();
    expect(Object.keys(emptyJournal())).not.toContain("operations");
    applyEvent(d.id, { type: "review" }, session, 10_001);
    expect(getOperation(d.id)?.state).toBe("REVIEW");
    expect(session.journal().operations).toBeUndefined();
    removeOperation(d.id);
    expect(getOperation(d.id)).toBeNull();
  });
  it("from AWAITING_SIGNATURE the record is journaled, survives lock / unlock, and a later event updates it in place", async () => {
    const d = draft();
    applyEvent(d.id, { type: "review" }, session, 10_001);
    applyEvent(d.id, { type: "confirm" }, session, 10_002);
    expect(operationsOf(session.journal()).map((r) => [r.id, r.state])).toEqual([[d.id, "AWAITING_SIGNATURE"]]);
    session.lock();
    expect(session.isUnlocked()).toBe(false);
    expect(getOperation(d.id)).toBeNull();
    expect(await session.unlock("correct horse battery staple")).toBe(true);
    expect(getOperation(d.id)).toMatchObject({ state: "AWAITING_SIGNATURE", history: [{ state: "DRAFT", at: 10_000 }, { state: "REVIEW", at: 10_001 }, { state: "AWAITING_SIGNATURE", at: 10_002 }] });
    const t = applyEvent(d.id, { type: "submitted", txHash: HASH, by: "relayer" }, session, 10_003);
    expect(t?.ok).toBe(true);
    expect(operationsOf(session.journal())).toHaveLength(1);
    expect(operationsOf(session.journal())[0]).toMatchObject({ state: "SUBMITTED", refs: { txHashes: [HASH] } });
    const refused = applyEvent(d.id, { type: "edit" }, session, 10_004);
    expect(refused && !refused.ok && refused.reason).toBe("not-allowed");
    expect(applyEvent("no-such-id", { type: "edit" })).toBeNull();
    removeOperation(d.id);
    expect(operationsOf(session.journal())).toEqual([]);
  });
  it("the open and the finished lists, newest first; the hooks see a change and keep a stable snapshot between changes", () => {
    const a = draft(), b = draft("protect");
    applyEvent(a.id, { type: "review" }, session, 20_000);
    applyEvent(a.id, { type: "confirm" }, session, 20_001);
    applyEvent(b.id, { type: "review" }, session, 20_002);
    applyEvent(b.id, { type: "confirm" }, session, 20_003);
    applyEvent(b.id, { type: "submitted", txHash: HASH, by: "wallet" }, session, 20_004);
    expect(openOperations().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(finishedOperations()).toEqual([]);
    const open = renderHook(() => useOpenOperations());
    const one = renderHook(() => useOperation(a.id));
    expect(open.result.current.map((r) => r.id)).toEqual([b.id, a.id]);
    const first = open.result.current;
    open.rerender();
    expect(open.result.current).toBe(first);
    expect(one.result.current?.state).toBe("AWAITING_SIGNATURE");
    act(() => { applyEvent(b.id, { type: "confirming", txHash: HASH }, session, 20_005); applyEvent(b.id, { type: "completed", ref: { txHash: HASH, leafIndex: 3 } }, session, 20_006); });
    expect(open.result.current.map((r) => r.id)).toEqual([a.id]);
    expect(finishedOperations().map((r) => [r.id, r.state])).toEqual([[b.id, "COMPLETED"]]);
    act(() => { applyEvent(a.id, { type: "rejected" }, session, 20_007); });
    expect(one.result.current).toMatchObject({ state: "SIGNATURE_REJECTED", failure: { code: "user_rejected", class: "not-moved" } });
    expect(allOperations()).toHaveLength(2);
    open.unmount(); one.unmount();
    removeOperation(a.id); removeOperation(b.id);
  });
});
