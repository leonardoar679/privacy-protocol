// A handed-over order is read at the relayer it was handed to (audit round 2, r38): every tick had built its reads from the
// relayer Settings name now, so an order handed to another one read "unknown" there — a handed-over, executed order fell
// back to "Waiting for source", polled every 15 s for good, its refund and shield job asked of a relayer that never had them.
import { describe, expect, it, vi } from "vitest";
import type { StoredSwap } from "../src/wallet/journal";

const asked = vi.hoisted(() => [] as string[]);
const refunds = vi.hoisted(() => ({ asked: [] as string[], down: new Set<string>(), refusing: new Set<string>() }));
vi.mock("../src/relayer", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/relayer")>();
  return {
    ...real,
    relayerSwapStatus: async (url: string, orderId: string) => {
      asked.push(url);
      return url === "http://old.relayer" ? { id: orderId, escrow: "0x00000000000000000000000000000000000e5c00", state: "executed", updatedAt: 1 } : null;
    },
    relayerSwapRefund: async (url: string) => {
      refunds.asked.push(url);
      if (refunds.down.has(url)) throw new TypeError("fetch failed");
      if (refunds.refusing.has(url)) throw new real.RelayerRefusal("this order is not refundable here", "not_refundable", 400);
      return { id: "0x" + "ab".repeat(32), escrow: "0x00000000000000000000000000000000000e5c00", state: "refunding", updatedAt: 1 };
    },
  };
});

import { orderIo } from "../src/wallet/orderRunner";
import { session } from "../src/wallet/session";

describe("a handed-over order's relayer (audit round 2, r38)", () => {
  it("its job is read where it was handed over; the relayer Settings name now only when that one does not know it", async () => {
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment: null, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = { orderId: "0x" + "ab".repeat(32), relayerUrl: "http://old.relayer" } as unknown as StoredSwap;
    expect((await io.job(stored))?.state).toBe("executed");
    expect(asked).toEqual(["http://old.relayer"]);
    asked.length = 0;
    expect(await io.job({ ...stored, relayerUrl: "http://gone.relayer" } as StoredSwap)).toBeNull();
    expect(asked, "unknown there: today's relayer asked too").toEqual(["http://gone.relayer", "http://new.relayer"]);
    asked.length = 0;
    await io.job({ ...stored, relayerUrl: undefined } as StoredSwap);
    expect(asked, "an order from before: today's relayer").toEqual(["http://new.relayer"]);
  });

  it("its refund goes where it was handed over; today's relayer takes it only when that one cannot be reached", async () => {
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1" } as never;
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = { orderId: "0x" + "ab".repeat(32), relayerUrl: "http://old.relayer", params: {}, refundNoteData: "0x01" } as unknown as StoredSwap;
    await io.refund(stored);
    expect(refunds.asked).toEqual(["http://old.relayer"]);
    refunds.asked.length = 0;
    refunds.down.add("http://old.relayer");
    await io.refund(stored);
    expect(refunds.asked, "unreachable: today's relayer").toEqual(["http://old.relayer", "http://new.relayer"]);
    refunds.asked.length = 0;
    refunds.down.clear();
    refunds.refusing.add("http://old.relayer");
    await expect(io.refund(stored)).rejects.toThrow(/not refundable/);
    expect(refunds.asked, "a refusal is an answer: never asked elsewhere").toEqual(["http://old.relayer"]);
  });
});
