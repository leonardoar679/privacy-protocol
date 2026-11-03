// The order blob is written back only while the operation still has one (the fourth review round, 2026-11-03): a prepare racing a
// finalize had put the destination and the refund material back into a row finalize had just cleared, for the retention sweep to
// find; and finalize's two statements are one transaction — a crash between them had left an operation with no blob and no
// execution row, which prepare answered as unknown until a restore.
import { describe, expect, it } from "vitest";
import { createLogger } from "@privacy-wallet/server-kit";
import { openDb } from "../src/db";
import { Store } from "../src/store";

const op = (id: string) =>
  ({
    id,
    kind: "swap",
    state: "AWAITING_AUTHORIZATION",
    provider: "stub",
    network: "ethereum",
    tier: "retail",
    quoteId: "q-" + id,
    orderId: "0x" + id.padStart(64, "0"),
    escrow: "0x" + "ee".repeat(20),
    asset: "native",
    amount: "1000",
    executorTip: "10",
    executeDeadline: 1_000,
    refundAfter: 2_000,
  }) as never;

describe("the order blob", () => {
  it("setBlobIfPresent: true while the blob is there, false for an unknown operation and after finalize cleared it — which stays cleared", () => {
    const store = new Store(
      openDb(":memory:"),
      createLogger(() => undefined),
      () => 1_000,
    );
    store.createOperation(op("op_a"), "blob-1");
    expect(store.setBlobIfPresent("op_a", "blob-2")).toBe(true);
    expect(store.blob("op_a")).toBe("blob-2");
    expect(store.setBlobIfPresent("op_zzz", "blob-3")).toBe(false);
    store.finalize("op_a", { providerRef: "ref-1", expectedSeconds: 60 });
    expect(store.blob("op_a")).toBeNull();
    expect(store.execution("op_a")).toMatchObject({ providerRef: "ref-1", expectedSeconds: 60, finalizedAt: 1_000 });
    expect(store.setBlobIfPresent("op_a", "blob-4"), "finalize cleared it: nothing written back").toBe(false);
    expect(store.blob("op_a")).toBeNull();
    store.setBlob("op_a", "blob-5"); // the unconditional write (a restore) still writes
    expect(store.blob("op_a")).toBe("blob-5");
  });
});
