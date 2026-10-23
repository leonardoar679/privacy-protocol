// A swap's record says what its destination was (audit round 2, n60/n62): the commit dropped the request's destination kind,
// so every swap — a typed-in address too, a campaign's always — read as a fresh address of this wallet, "Verified" in
// Activity, and a swap into the protected balance had an empty destination. Offline: the service, the order check and the
// gas ceilings are stubs; the commit and the record are the real code's.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { Deployment } from "../src/chain";
import type { Asset } from "../src/assets";
import type { StoredSwap } from "../src/wallet/journal";
import { bookOf } from "../src/wallet/addressBook";
import { consumeFreshAddress } from "../src/keys/chainKeys";

vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async () => ({
        operationId: "op_" + "b".repeat(26),
        order: {
          orderId: ("0x" + "cd".repeat(32)) as Hex,
          params: { orderId: "0x" + "cd".repeat(32), amount: "1000000000000000000", executeDeadline: 2_000_000_000, refundAfter: 2_000_007_200 },
          endpoint: "0x00000000000000000000000000000000000e5c01",
          quote: { provider: "thorchain", toAmount: "990", toAmountMin: "980" },
        },
        scores: [],
        status: "Pending",
      }),
    },
  };
});
vi.mock("../src/swapGuard", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/swapGuard")>()), checkOrder: () => undefined }));
vi.mock("../src/executionCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/executionCost")>()),
  tipCeiling: async () => null,
  shieldTipCeiling: async () => null,
}));

import { commitOrder } from "../src/swapExecute";
import { syncSwapRecord } from "../src/operations/swapRecords";

const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e1",
  rpcUrl: "http://x",
  rpcUrls: ["http://x"],
  fromBlock: 0n,
  erc20Vaults: [],
  swapFactory: "0x00000000000000000000000000000000000000f1",
} as Deployment;
const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});

const commit = (destinationKind: "entered" | "fresh") =>
  commitOrder({
    masterSeed: session.state().seed!,
    deployment,
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: "1000000000000000000",
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      slippageBps: 50,
      destinationKind,
    },
    policy: "balanced",
    provider: "thorchain",
    fromAsset: { symbol: "ETH", decimals: 18, vault: "0x00000000000000000000000000000000000000e1" } as unknown as Asset,
  } as Parameters<typeof commitOrder>[0]);

describe("a swap's destination in its record (audit round 2, n60/n62)", () => {
  it("is the kind its commit journaled: a typed-in address is never a verified fresh one", async () => {
    const entered = (await commit("entered")).stored;
    expect((entered.request as { destinationKind?: string }).destinationKind).toBe("entered");
    expect(syncSwapRecord(entered, null, null).destination).toMatchObject({ kind: "entered", display: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" });
    const fresh = (await commit("fresh")).stored;
    expect(syncSwapRecord(fresh, null, null).destination.kind).toBe("fresh");
    // a campaign's step: its own kind too
    expect(syncSwapRecord({ ...entered, campaign: { id: "c1", index: 0 } } as StoredSwap, null, null).destination.kind).toBe("entered");
    // an order journaled before the kind was: nothing verified is claimed
    const { destinationKind: _, ...older } = entered.request as Record<string, unknown>;
    expect(syncSwapRecord({ ...entered, request: older } as StoredSwap, null, null).destination.kind).toBe("entered");
  });

  it("a fresh destination is used in the book from its commit: an order stopped before its hand-over never gives it out again (audit round 2, n54)", async () => {
    const dest = consumeFreshAddress(session.state().seed!, "bitcoin").address;
    const entry = () => bookOf(session.journal()).find((e) => e.address.toLowerCase() === dest.toLowerCase());
    expect(entry()?.lifecycle, "reserved: still unused").not.toBe("used");
    await commitOrder({
      masterSeed: session.state().seed!,
      deployment,
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
        amount: "1000000000000000000",
        destination: dest,
        slippageBps: 50,
        destinationKind: "fresh",
      },
      policy: "balanced",
      provider: "thorchain",
      fromAsset: { symbol: "ETH", decimals: 18, vault: "0x00000000000000000000000000000000000000e1" } as unknown as Asset,
    } as Parameters<typeof commitOrder>[0]);
    expect(entry()).toMatchObject({ lifecycle: "used" });
  });

  it("into the protected balance: the user's own balance, never an empty label", async () => {
    const base = (await commit("fresh")).stored;
    const into = { ...base, request: { ...(base.request as object), destination: "" }, shield: { receiver: "0x" + "5e".repeat(20) } } as unknown as StoredSwap;
    expect(syncSwapRecord(into, null, null).destination).toMatchObject({ kind: "privacy-address", display: "Your protected balance" });
  });
});
