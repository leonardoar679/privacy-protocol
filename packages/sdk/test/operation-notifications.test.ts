// The operation notifications (spec v2.0 §12.5; doc §76; V6 Stage 15): the five kinds from the record before and after a
// write — a quote in for review, a swap's funding confirmed (a cross-chain swap's "executing"), completed, recovery
// required —, nothing for a record seen for the first time or a state it already had, amounts only when the user allowed
// them; the watcher's baseline at unlock notifies nothing, each transition notifies once, a lock forgets.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { NOTIFICATION_KINDS, kindFor, notificationFor, watchOperationNotifications, type OperationNotification } from "../src/operations/notify";
import { newOperation, putOperation, resetOperationsMemory } from "../src/operations/store";
import type { OperationRecord, OperationState } from "../src/wallet/operationRecord";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession } from "../src/wallet/session";

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12, deploymentCheck: false })));
afterEach(() => resetOperationsMemory());

const swap = (state: OperationState, kind: OperationRecord["kind"] = "swap"): OperationRecord => ({
  v: 3,
  id: "op-1",
  kind,
  state,
  createdAt: 1,
  updatedAt: 1,
  amounts: { asset: "USDC", decimals: 6, input: "8000000000", expectedOutput: "3100307000000000000", outputAsset: "ETH", outputDecimals: 18 },
  fees: [],
  destination: { kind: "fresh", display: "Your protected balance", chain: "ethereum" },
  refs: { txHashes: [] },
  tier: "standard",
  history: [],
});

describe("notificationFor (doc §76)", () => {
  it("the five kinds, each from its transition", () => {
    expect(kindFor(swap("QUOTING"), swap("READY_TO_REVIEW"))).toBe("quote-ready");
    expect(kindFor(swap("SOURCE_CONFIRMING"), swap("PROVIDER_EXECUTING"))).toBe("confirmed");
    expect(kindFor(swap("SOURCE_CONFIRMING"), swap("PROVIDER_EXECUTING"))).toBe("confirmed");
    expect(kindFor(swap("SOURCE_CONFIRMING", "cross-chain"), swap("PROVIDER_EXECUTING", "cross-chain"))).toBe("cross-chain-executing");
    expect(kindFor(swap("DESTINATION_CONFIRMING"), swap("COMPLETED"))).toBe("completed");
    expect(kindFor(swap("SOURCE_CONFIRMING", "protect"), swap("COMPLETED", "protect"))).toBe("completed");
    expect(kindFor(swap("PROVIDER_EXECUTING"), swap("RECOVERY_REQUIRED"))).toBe("recovery-required");
    expect(NOTIFICATION_KINDS).toHaveLength(5);
  });
  it("nothing for a state the record already had, a reorg back to EXECUTING, or the steps in between", () => {
    expect(kindFor(swap("PROVIDER_EXECUTING"), swap("PROVIDER_EXECUTING"))).toBeNull();
    expect(kindFor(swap("DESTINATION_CONFIRMING"), swap("PROVIDER_EXECUTING"))).toBeNull();
    expect(kindFor(swap("AWAITING_AUTHORIZATION"), swap("SOURCE_CONFIRMING"))).toBeNull();
    expect(kindFor(swap("SOURCE_CONFIRMING"), swap("SOURCE_CONFIRMING"))).toBeNull();
    expect(notificationFor(null, swap("COMPLETED"), { amounts: true }), "a record seen for the first time").toBeNull();
  });
  it("no amount unless the user allowed amount previews", () => {
    const plain = notificationFor(swap("DESTINATION_CONFIRMING"), swap("COMPLETED"), { amounts: false })!;
    expect(plain).toEqual({ kind: "completed", operationId: "op-1", operation: "swap" });
    expect(JSON.stringify(plain)).not.toMatch(/8000000000|3100307/);
    const full = notificationFor(
      swap("DESTINATION_CONFIRMING"),
      { ...swap("COMPLETED"), amounts: { ...swap("COMPLETED").amounts, delivered: "3100000000000000000" } },
      { amounts: true },
    )!;
    expect(full.amounts).toEqual({
      input: { asset: "USDC", decimals: 6, value: "8000000000" },
      output: { asset: "ETH", decimals: 18, value: "3100000000000000000" },
    });
  });
});

describe("watchOperationNotifications", () => {
  it("the records at unlock are a baseline; each later transition notifies once; a lock forgets", async () => {
    const s = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
    await s.create("pw");
    s.acknowledgePhrase();
    const before = newOperation({ kind: "swap", amounts: swap("DRAFT").amounts, destination: swap("DRAFT").destination, tier: "standard" });
    putOperation({ ...before, state: "PROVIDER_EXECUTING" }, s);
    const got: OperationNotification[] = [];
    const off = watchOperationNotifications((n) => got.push(n), { prefs: () => ({ amounts: false }), session: s });
    expect(got, "the baseline notifies nothing").toEqual([]);
    putOperation({ ...before, state: "COMPLETED" }, s);
    expect(got.map((n) => n.kind)).toEqual(["completed"]);
    putOperation({ ...before, state: "COMPLETED", updatedAt: 2 }, s);
    expect(got, "the same state again notifies nothing").toHaveLength(1);
    const draft = newOperation({ kind: "swap", amounts: swap("DRAFT").amounts, destination: swap("DRAFT").destination, tier: "standard" });
    putOperation({ ...draft, state: "QUOTING" }, s);
    putOperation({ ...draft, state: "READY_TO_REVIEW" }, s);
    expect(got.map((n) => n.kind)).toEqual(["completed", "quote-ready"]);
    s.lock();
    off();
  });
});
