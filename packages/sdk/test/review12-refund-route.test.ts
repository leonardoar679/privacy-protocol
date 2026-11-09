// The twelfth review round, 2026-11-06, F12-1 and its critique (ZA): a delayed order committed on a route refunding a failure to the escrow is
// checked against a fresh quote before its funding. When Mayan, the order's provider, quotes none of the committed route type while it quotes the
// other, the API's rebuild (or its prepare) answers `refund_route_unavailable`: the signing would meet it while it does, so the check stops the
// order here, unfunded — read as a check that could not be made, it had been funded and then held to its refund time. A provider that quotes
// nothing at all is an outage, as before: the order is funded and its signing retried.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { ScheduledAction, StoredSwap } from "../src/wallet/journal";
import { ApiError } from "../src/api/client";
import { patchSwap } from "../src/swapFunding";
import { resetOperationsMemory } from "../src/operations/store";
import { runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import { CATALOG } from "../src/operations/errors/catalog";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  session.update((j) => {
    j.swaps = [];
    j.schedule = [];
    j.operations = [];
  });
  resetOperationsMemory();
});

const ORDER = "0x" + "ab".repeat(32);
const AMOUNT = 10n ** 18n;
const T0 = Date.parse("2026-10-13T12:00:00Z");
const delayUntil = T0 + 3 * 3600_000;
function order(): StoredSwap {
  const s = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "mayan",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
      amount: AMOUNT.toString(),
      destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      slippageBps: 50,
    },
    params: { amount: AMOUNT.toString() },
    endpoint: "0x00000000000000000000000000000000000000e5",
    quote: { provider: "mayan", toAmount: "3000000", toAmountMin: "2970000", refundTarget: "escrow" },
    approvedMin: "2970000",
    createdAt: T0,
    state: "committed",
    refundNoteData: "0x00",
    runner: { confirmedAt: T0, delayUntil },
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [s];
  });
  return s;
}
const action = (dueAt: number): ScheduledAction => ({ id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt });
function io(precheck: () => Promise<never>): { io: OrderIo; funds: () => number } {
  let funds = 0;
  const io = {
    fund: async (st: StoredSwap, onStatus: (l: string) => void) => {
      funds++;
      onStatus("Withdrawing privately: handing it to the relayer…");
      patchSwap(st.orderId, { fundedTx: "0xf00d", state: "funded" });
      return { txHash: "0xf00d" };
    },
    escrowBalance: async () => 0n,
    sign: async () => {
      throw new ApiError(
        400,
        "refund_route_unavailable",
        "mayan's route now refunds a failure at the destination, not to the pool as the order was committed; retry later",
      );
    },
    handOver: async () => {
      throw new Error("not reached");
    },
    job: async () => null,
    track: async () => {
      throw new Error("not reached");
    },
    refund: async () => {
      throw new Error("not reached");
    },
    shieldStatus: async () => null,
    registerShield: async () => {
      throw new Error("no");
    },
    recoverShield: async () => 0,
    precheck,
  } as unknown as OrderIo;
  return { io, funds: () => funds };
}
const deps = (i: OrderIo, now: number) => ({ masterSeed: new Uint8Array(32).fill(1), deployment: null, io: i, now: () => now });

describe("F12-1 (ZA): a delayed funding's check and a route that now refunds outside the pool", () => {
  it("the rebuild's refund_route_unavailable stops the order unfunded, its words kept", async () => {
    order();
    session.update((j) => {
      j.schedule = [action(delayUntil)];
    });
    const w = io(async () => {
      throw new ApiError(
        400,
        "refund_route_unavailable",
        "mayan's route now refunds a failure at the destination, not to the pool as the order was committed; retry later",
      );
    });
    const r = await runOrderTick(action(delayUntil), deps(w.io, delayUntil));
    expect(r?.step).toBe("stopped");
    expect(w.funds(), "never funded").toBe(0);
    expect(session.journal().swaps[0]?.paused).toMatchObject({ code: "call_refused", detail: expect.stringMatching(/refunds a failure at the destination/) });
  });

  it("a provider quoting nothing at all is an outage, as before: the order is funded and its signing retried", async () => {
    order();
    session.update((j) => {
      j.schedule = [action(delayUntil)];
    });
    const w = io(async () => {
      throw new ApiError(400, "no_quote", "no quote from mayan right now; retry later");
    });
    const r = await runOrderTick(action(delayUntil), deps(w.io, delayUntil));
    expect(r?.step).toBe("funded");
    expect(w.funds()).toBe(1);
  });

  it("its catalog row: the funds still protected, the wallet monitoring", () => {
    expect(CATALOG.refund_route_unavailable).toEqual({ source: "service", fundsClass: "still-protected", actions: ["continue-monitoring"] });
  });
});
