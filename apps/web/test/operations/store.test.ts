// @vitest-environment happy-dom
// The operation store (spec §12): a draft stays in memory and the journal never gains the field on its own; from
// AWAITING_AUTHORIZATION on the record is in the encrypted journal and survives a lock and an unlock; a later event
// updates it in place; the open and finished lists; the hooks' snapshots are stable until a change. V6: a declined
// prompt sends the record back to its review and out of the journal; a V5 record is read and written as V6.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  OperationRepository,
  OperationService,
  OperationStore,
  applyEvent,
  allOperations,
  finishedOperations,
  getOperation,
  newOperation,
  openOperations,
  operationsOf,
  removeOperation,
  resetOperationsMemory,
} from "@privacy-wallet/sdk/operations/store";
import { emptyJournal } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useOpenOperations, useOperation } from "../../src/hooks";

const HASH = "0x" + "ef".repeat(32);
const draft = (kind: "send" | "protect" = "send") =>
  newOperation(
    {
      kind,
      amounts: { asset: "ETH", decimals: 18, input: "1000" },
      destination: { kind: "privacy-address", display: "pp1q…", chain: "ethereum" },
      tier: "standard",
    },
    10_000,
  );

beforeAll(async () => {
  await session.ready;
  session.forget();
  resetOperationsMemory();
  await session.create("correct horse battery staple");
});
afterAll(() => {
  session.forget();
  resetOperationsMemory();
});

describe("where a record lives", () => {
  it("a draft stays in memory: the journal has no `operations` and emptyJournal() never writes the field", () => {
    const d = draft();
    expect(d.state).toBe("DRAFT");
    expect(getOperation(d.id)).toBe(d);
    expect(session.journal().operations).toBeUndefined();
    expect(Object.keys(emptyJournal())).not.toContain("operations");
    applyEvent(d.id, { type: "review" }, session, 10_001);
    expect(getOperation(d.id)?.state).toBe("READY_TO_REVIEW");
    expect(session.journal().operations).toBeUndefined();
    removeOperation(d.id);
    expect(getOperation(d.id)).toBeNull();
  });
  it("from AWAITING_AUTHORIZATION the record is journaled, survives lock / unlock, and a later event updates it in place", async () => {
    const d = draft();
    applyEvent(d.id, { type: "review" }, session, 10_001);
    applyEvent(d.id, { type: "confirm" }, session, 10_002);
    expect(operationsOf(session.journal()).map((r) => [r.id, r.state])).toEqual([[d.id, "AWAITING_AUTHORIZATION"]]);
    session.lock();
    expect(session.isUnlocked()).toBe(false);
    expect(getOperation(d.id)).toBeNull();
    expect(await session.unlock("correct horse battery staple")).toBe(true);
    expect(getOperation(d.id)).toMatchObject({
      state: "AWAITING_AUTHORIZATION",
      history: [
        { state: "DRAFT", at: 10_000 },
        { state: "READY_TO_REVIEW", at: 10_001 },
        { state: "AWAITING_AUTHORIZATION", at: 10_002 },
      ],
    });
    const t = applyEvent(d.id, { type: "submitted", txHash: HASH, by: "relayer" }, session, 10_003);
    expect(t?.ok).toBe(true);
    expect(operationsOf(session.journal())).toHaveLength(1);
    expect(operationsOf(session.journal())[0]).toMatchObject({ state: "SOURCE_CONFIRMING", refs: { txHashes: [HASH] } });
    const refused = applyEvent(d.id, { type: "edit" }, session, 10_004);
    expect(refused && !refused.ok && refused.reason, "V7: I-O7 names its refusal before the table does").toBe("after-submission");
    expect(applyEvent("no-such-id", { type: "edit" })).toBeNull();
    removeOperation(d.id);
    expect(operationsOf(session.journal())).toEqual([]);
  });
  it("the open and the finished lists, newest first; the hooks see a change and keep a stable snapshot between changes", () => {
    const a = draft(),
      b = draft("protect");
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
    expect(one.result.current?.state).toBe("AWAITING_AUTHORIZATION");
    act(() => {
      applyEvent(b.id, { type: "confirming", txHash: HASH }, session, 20_005);
      applyEvent(b.id, { type: "completed", ref: { txHash: HASH, leafIndex: 3 } }, session, 20_006);
    });
    expect(open.result.current.map((r) => r.id)).toEqual([a.id]);
    expect(finishedOperations().map((r) => [r.id, r.state])).toEqual([[b.id, "COMPLETED"]]);
    act(() => {
      applyEvent(a.id, { type: "rejected" }, session, 20_007);
    });
    expect(one.result.current, "V6: a declined prompt goes back to the review").toMatchObject({
      state: "READY_TO_REVIEW",
      declined: { at: 20_007, code: "user_rejected" },
    });
    expect(
      operationsOf(session.journal()).map((r) => r.id),
      "a draft again: it leaves the journal",
    ).toEqual([b.id]);
    expect(open.result.current).toEqual([]);
    expect(allOperations()).toHaveLength(2);
    open.unmount();
    one.unmount();
    removeOperation(a.id);
    removeOperation(b.id);
  });
  it("V6: every record the store writes carries `v: 3`; a V5 record in the journal is read in the V6 vocabulary and written back as V6", () => {
    const d = draft();
    expect(d.v).toBe(3);
    const v5 = {
      id: "send:v5",
      kind: "send",
      state: "SUBMISSION_FAILED",
      createdAt: 1_000,
      updatedAt: 2_000,
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      fees: [],
      destination: { kind: "entered", display: "0x12…", chain: "ethereum" },
      refs: { txHashes: [] },
      tier: "standard",
      failure: { code: "bad_fee", class: "not-moved" },
      history: [
        { state: "AWAITING_AUTHORIZATION", at: 1_000 },
        { state: "SUBMISSION_FAILED", at: 2_000 },
      ],
    };
    session.update((j) => {
      j.operations = [v5 as never];
    });
    expect(getOperation("send:v5")).toMatchObject({
      v: 3,
      state: "FAILED",
      reason: { code: "bad_fee", fundsClass: "not-moved" },
      history: [{ state: "AWAITING_AUTHORIZATION" }, { state: "FAILED" }],
    });
    expect(getOperation("send:v5")).not.toHaveProperty("failure");
    expect(finishedOperations().map((r) => r.id)).toEqual(["send:v5"]);
    applyEvent(d.id, { type: "review" }, session, 30_000);
    applyEvent(d.id, { type: "confirm" }, session, 30_001);
    expect(OperationStore.get(d.id)?.state).toBe("AWAITING_AUTHORIZATION");
    expect(OperationRepository.read(session.journal()).map((r) => r.v)).toEqual([3, 3]);
    expect(OperationService.apply(d.id, { type: "cancel" }, session, 30_002)?.ok).toBe(true);
    removeOperation(d.id);
    removeOperation("send:v5");
  });
});
