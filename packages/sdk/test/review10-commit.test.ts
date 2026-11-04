// The tenth review round (2026-11-04), D-1 (HIGH), the swap side: a lock during a commit's wait (the scan after an unlock, or the swap
// service's competition) had let the commit derive its refund note from the seed the lock zeroed and, after a quick unlock, journal the
// order — ready to be funded, its refund a note anyone can spend. A commit is now bound to the opening it began in. Offline: the service,
// the order check and the gas ceilings are stubs (as in swap-destination-kind.test.ts); the commit is the real code.
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { Deployment } from "../src/chain";

const seen: { bodies: unknown[] } = { bodies: [] };
let gate: () => void = () => {};
let gated = Promise.resolve();
vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async (body: unknown) => {
        seen.bodies.push(body);
        await gated; // the competition takes its time
        return {
          operationId: "op_" + "b".repeat(26),
          order: {
            orderId: ("0x" + "cd".repeat(32)) as Hex,
            params: { orderId: "0x" + "cd".repeat(32), amount: "1000000000000000000", executeDeadline: 2_000_000_000, refundAfter: 2_000_007_200 },
            endpoint: "0x00000000000000000000000000000000000e5c01",
            quote: { provider: "thorchain", toAmount: "990", toAmountMin: "980" },
          },
          scores: [],
          status: "Pending",
        };
      },
    },
  };
});
vi.mock("../src/swapGuard", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/swapGuard")>()), checkOrder: () => undefined }));
vi.mock("../src/executionCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/executionCost")>()),
  tipCeiling: async () => 10n ** 30n,
  shieldTipCeiling: async () => 10n ** 30n,
}));

import { commitOrder } from "../src/swapExecute";

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
const request = {
  from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
  to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
  amount: "1000000000000000000",
  destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  slippageBps: 50,
  destinationKind: "entered",
};
const commit = () =>
  commitOrder({
    masterSeed: session.state().seed!, // the Swap screen's seed prop
    deployment,
    request,
    policy: "balanced",
    provider: "thorchain",
    fromAsset: { symbol: "ETH", decimals: 18, vault: "0x00000000000000000000000000000000000000e1" },
  } as never).catch((e: unknown) => e as { code?: string });

describe("a commit across a lock (the tenth review round, D-1)", () => {
  it("is refused when the lock comes while it waits for the scan: nothing is asked of the service", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    session.lock(); // the previous case's unlock left its scan hold: a new wallet starts from a locked session
    await session.create("a strong password", undefined, { replace: true });
    session.acknowledgePhrase();
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    seen.bodies = [];
    const flow = commit();
    await new Promise((r) => setTimeout(r, 20));
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    expect(((await flow) as { code?: string }).code).toBe("locked_mid_flow");
    expect(seen.bodies, "the service was never asked").toEqual([]);
    expect(session.journal().swaps).toEqual([]);
  });

  it("is refused when the lock comes while the service answers: the order is journaled nowhere", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    session.lock(); // the previous case's unlock left its scan hold: a new wallet starts from a locked session
    await session.create("a strong password", undefined, { replace: true });
    session.acknowledgePhrase(); // a new wallet: no scan hold, the commit goes straight to the service
    seen.bodies = [];
    gated = new Promise<void>((r) => (gate = r));
    const flow = commit();
    for (let i = 0; i < 100 && !seen.bodies.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen.bodies).toHaveLength(1);
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    gate();
    expect(((await flow) as { code?: string }).code).toBe("locked_mid_flow");
    expect(session.journal().swaps, "not journaled into the wallet opened again").toEqual([]);
    gated = Promise.resolve();
  });
});
