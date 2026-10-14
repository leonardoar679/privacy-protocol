// The V5 → V6 upgrade of the journaled operation records (Privacy Wallet Web spec v2.0 §12.2): every row of the table,
// the history renamed and merged, `failure` → `reason`, a delay and a stored rejection as fields; idempotent (a V6
// record is returned as it is); applied when the journal is decrypted and persisted by the next write; the upgraded
// records hold the invariants (I-O3 a reason on every failure state, I-O6 FAILED only for a known funds class).
import { describe, expect, it } from "vitest";
import { decryptJournal, emptyJournal, encryptJournal, type JournalData } from "../src/wallet/journal";
import { upgradeOperations, upgradeRecord, upgradeState, type StoredOperation } from "../src/operations/upgrade";
import { FAILURE_STATES, OPERATION_STATES, type OperationKind } from "../src/wallet/operationRecord";

const v5 = (over: Partial<StoredOperation> & { state: string }): StoredOperation => ({
  id: `op:${over.state}`,
  kind: "send",
  createdAt: 1_000,
  updatedAt: 5_000,
  amounts: { asset: "ETH", decimals: 18, input: "1000" },
  fees: [],
  destination: { kind: "entered", display: "0x12…", chain: "ethereum" },
  refs: { txHashes: [] },
  tier: "standard",
  history: [
    { state: "AWAITING_SIGNATURE", at: 1_000 },
    { state: over.state, at: 5_000 },
  ],
  ...over,
});

describe("the mapping table (spec v2.0 §12.2)", () => {
  it("renames each V5 state; NETWORK_CONFIRMING by kind; NETWORK_DELAYED by phase; every other name unchanged", () => {
    const send: OperationKind = "send",
      swap: OperationKind = "cross-chain";
    expect(upgradeState("QUOTE_READY", send, undefined, undefined, true)).toBe("REVIEW");
    expect(upgradeState("RELAYER_EXECUTING", swap, undefined, undefined, true)).toBe("EXECUTING");
    for (const k of ["protect", "send", "withdraw", "classic-deposit", "classic-withdraw"] as OperationKind[])
      expect(upgradeState("NETWORK_CONFIRMING", k, undefined, undefined, true), k).toBe("CONFIRMING");
    for (const k of ["swap", "cross-chain"] as OperationKind[]) expect(upgradeState("NETWORK_CONFIRMING", k, undefined, undefined, true), k).toBe("EXECUTING");
    expect(upgradeState("SETTLEMENT_VERIFYING", swap, undefined, undefined, true)).toBe("SETTLING");
    expect(upgradeState("PROVIDER_FAILED", swap, undefined, { code: "execute_failed", fundsClass: "still-protected" }, true)).toBe("RECOVERY_REQUIRED");
    expect(upgradeState("NETWORK_DELAYED", swap, "funding", undefined, true)).toBe("CONFIRMING");
    expect(upgradeState("NETWORK_DELAYED", swap, "execution", undefined, true)).toBe("EXECUTING");
    expect(upgradeState("NETWORK_DELAYED", swap, "settlement", undefined, true)).toBe("SETTLING");
    expect(upgradeState("NETWORK_DELAYED", send, "execution", undefined, true), "a send has no execution leg").toBe("CONFIRMING");
    for (const same of [
      "DRAFT",
      "QUOTING",
      "REVIEW",
      "AWAITING_SIGNATURE",
      "SIGNED",
      "SUBMITTED",
      "COMPLETED",
      "QUOTE_EXPIRED",
      "RECOVERY_REQUIRED",
      "REFUNDING",
      "REFUNDED",
      "CANCELLED",
    ])
      expect(upgradeState(same, swap, undefined, undefined, true)).toBe(same);
  });
  it("SUBMISSION_FAILED → FAILED with its reason; an unknown class, or a code that leaves something to track, → RECOVERY_REQUIRED (I-O6)", () => {
    expect(upgradeRecord(v5({ state: "SUBMISSION_FAILED", failure: { code: "bad_fee", class: "not-moved" } }))).toMatchObject({
      v: 2,
      state: "FAILED",
      reason: { code: "bad_fee", fundsClass: "not-moved" },
    });
    expect(upgradeRecord(v5({ state: "SUBMISSION_FAILED", failure: { code: "send_failed", class: "unknown", detail: "x" } }))).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "send_failed", fundsClass: "unknown", detail: "x" },
    });
    expect(upgradeRecord(v5({ state: "SUBMISSION_FAILED", failure: { code: "nullifier_in_flight", class: "still-protected" } })).state).toBe(
      "RECOVERY_REQUIRED",
    );
    expect(upgradeRecord(v5({ state: "SUBMISSION_FAILED" })), "no reason stored: unknown").toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "unknown", fundsClass: "unknown" },
    });
  });
  it("a stored SIGNATURE_REJECTED is CANCELLED with `user_rejected` and the decline's time; a NETWORK_DELAYED record keeps its phase's state with `delayed`", () => {
    const rejected = upgradeRecord(v5({ state: "SIGNATURE_REJECTED", failure: { code: "user_rejected", class: "not-moved" } }));
    expect(rejected).toMatchObject({
      state: "CANCELLED",
      reason: { code: "user_rejected", fundsClass: "not-moved" },
      declined: { at: 5_000, code: "user_rejected" },
    });
    expect(rejected.history.map((h) => h.state)).toEqual(["AWAITING_SIGNATURE", "CANCELLED"]);
    const delayed = upgradeRecord(
      v5({
        kind: "cross-chain",
        phase: "execution",
        state: "NETWORK_DELAYED",
        failure: { code: "provider_timeout", class: "still-protected" },
        recovery: { state: "monitoring", since: 4_000 },
        history: [
          { state: "SUBMITTED", at: 2_000 },
          { state: "NETWORK_CONFIRMING", at: 3_000 },
          { state: "NETWORK_DELAYED", at: 4_000, note: "slow" },
        ],
      }),
    );
    expect(delayed).toMatchObject({ state: "EXECUTING", delayed: { since: 4_000, code: "provider_timeout" }, recovery: { state: "monitoring", since: 4_000 } });
    expect(delayed.reason, "a delay is not a failure").toBeUndefined();
    expect(delayed.history, "consecutive equal lines merge: the first time kept, the notes joined").toEqual([
      { state: "SUBMITTED", at: 2_000 },
      { state: "EXECUTING", at: 3_000, note: "slow" },
    ]);
  });
  it("history lines are renamed: a rejection or a failure the record moved past reads as the state it went back to", () => {
    const r = upgradeRecord(
      v5({
        kind: "protect",
        state: "COMPLETED",
        history: [
          { state: "DRAFT", at: 1_000 },
          { state: "QUOTE_READY", at: 1_100 },
          { state: "REVIEW", at: 1_200 },
          { state: "AWAITING_SIGNATURE", at: 1_300 },
          { state: "SIGNATURE_REJECTED", at: 1_400 },
          { state: "AWAITING_SIGNATURE", at: 1_500 },
          { state: "SUBMITTED", at: 1_600 },
          { state: "NETWORK_CONFIRMING", at: 1_700 },
          { state: "COMPLETED", at: 1_800 },
        ],
      }),
    );
    expect(r.history.map((h) => [h.state, h.at])).toEqual([
      ["DRAFT", 1_000],
      ["REVIEW", 1_100],
      ["AWAITING_SIGNATURE", 1_300],
      ["REVIEW", 1_400],
      ["AWAITING_SIGNATURE", 1_500],
      ["SUBMITTED", 1_600],
      ["CONFIRMING", 1_700],
      ["COMPLETED", 1_800],
    ]);
    const resumed = upgradeRecord(
      v5({
        state: "SUBMITTED",
        history: [
          { state: "AWAITING_SIGNATURE", at: 1_000 },
          { state: "SUBMISSION_FAILED", at: 1_100 },
          { state: "SUBMITTED", at: 1_200 },
        ],
        failure: { code: "relayer_unreachable", class: "unknown" },
      }),
    );
    expect(
      resumed.history.map((h) => h.state),
      "a failure the record moved past was not final",
    ).toEqual(["AWAITING_SIGNATURE", "RECOVERY_REQUIRED", "SUBMITTED"]);
    expect(resumed.reason, "an open state carries no reason").toBeUndefined();
  });
});

describe("idempotence and the journal", () => {
  const fixture = (): StoredOperation[] => [
    v5({ id: "a", kind: "protect", state: "NETWORK_CONFIRMING", phase: "settlement" }),
    v5({
      id: "b",
      kind: "swap",
      state: "PROVIDER_FAILED",
      failure: { code: "execute_failed", class: "still-protected" },
      refs: { txHashes: ["0x" + "11".repeat(32)], orderId: "0x01" },
    }),
    v5({ id: "c", kind: "send", state: "SIGNATURE_REJECTED", failure: { code: "user_rejected", class: "not-moved" } }),
    v5({ id: "d", kind: "cross-chain", state: "NETWORK_DELAYED", phase: "settlement", failure: { code: "network_delayed", class: "still-protected" } }),
    v5({ id: "e", kind: "withdraw", state: "SUBMISSION_FAILED", failure: { code: "receipt_reverted", class: "not-moved" } }),
    v5({ id: "f", kind: "cross-chain", state: "SETTLEMENT_VERIFYING" }),
    v5({ id: "g", kind: "send", state: "COMPLETED" }),
  ];
  it("upgrading twice equals upgrading once (a V6 record comes back as the same object); the upgraded records hold I-O3 and I-O6", () => {
    const once = upgradeOperations(fixture());
    const twice = upgradeOperations(once);
    expect(twice).toEqual(once);
    once.forEach((r, i) => expect(twice[i]).toBe(r));
    expect(once.map((r) => [r.id, r.state])).toEqual([
      ["a", "CONFIRMING"],
      ["b", "RECOVERY_REQUIRED"],
      ["c", "CANCELLED"],
      ["d", "SETTLING"],
      ["e", "FAILED"],
      ["f", "SETTLING"],
      ["g", "COMPLETED"],
    ]);
    for (const r of once) {
      expect(r.v).toBe(2);
      expect(OPERATION_STATES, r.id).toContain(r.state);
      for (const h of r.history) expect(OPERATION_STATES, `${r.id} history`).toContain(h.state);
      expect(r, r.id).not.toHaveProperty("failure");
      if (FAILURE_STATES.includes(r.state)) expect(r.reason, `${r.id} I-O3`).toBeDefined();
      if (r.state === "FAILED") expect(["not-moved", "still-protected"], `${r.id} I-O6`).toContain(r.reason!.fundsClass);
      expect(r.history[r.history.length - 1].state, r.id).toBe(r.state);
    }
  });
  it("a malformed record never makes the journal unreadable: it is kept as it is, the others upgrade", () => {
    const broken = {
      id: "x",
      kind: "send",
      state: "SUBMISSION_FAILED",
      get history(): never {
        throw new Error("unreadable");
      },
    } as unknown as StoredOperation;
    const out = upgradeOperations([broken, v5({ id: "ok", state: "SETTLEMENT_VERIFYING", kind: "swap" })]);
    expect(out[0]).toBe(broken);
    expect(out[1]).toMatchObject({ id: "ok", v: 2, state: "SETTLING" });
    expect(upgradeRecord(v5({ state: "COMPLETED", history: undefined as never })).history, "no history: the state's own line").toEqual([
      { state: "COMPLETED", at: 5_000 },
    ]);
  });
  it("a V5 journal decrypts into V6 records; written back and decrypted again it is unchanged; a journal without records gains no field", () => {
    const key = new Uint8Array(32).fill(7);
    const rng = (n: number) => new Uint8Array(n).fill(9);
    const v5Journal = { ...emptyJournal(), operations: fixture() } as unknown as JournalData;
    const read = decryptJournal(key, encryptJournal(key, v5Journal, rng))!;
    expect(read.operations!.map((r) => r.state)).toEqual(["CONFIRMING", "RECOVERY_REQUIRED", "CANCELLED", "SETTLING", "FAILED", "SETTLING", "COMPLETED"]);
    const again = decryptJournal(key, encryptJournal(key, read, rng))!;
    expect(again).toEqual(read);
    expect(JSON.stringify(encryptJournal(key, again, rng)), "the next write persists V6, byte for byte the same").toBe(
      JSON.stringify(encryptJournal(key, read, rng)),
    );
    const plain = decryptJournal(key, encryptJournal(key, emptyJournal(), rng))!;
    expect(Object.keys(plain)).not.toContain("operations");
    expect(Object.keys(emptyJournal())).not.toContain("operations");
  });
});
