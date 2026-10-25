// No swap is committed with its tips unchecked (audit round 2, critic gap 4). The wallet checks the executor's tip — and a
// shield receipt's — against three times its own estimate of the gas they pay for; a failed fee read or a missing price
// had left the escrow's 1 % cap alone, so a swap service could set a 1 % tip at that moment. Without an estimate nothing is
// committed now (no note counter taken, the service not asked), and an ERC-20's estimate falls back to the last good prices
// of the past day. Offline: the RPC client, the service and the order check are stubs; the commit and the ceilings are real.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { executionUnits, gasCeilingWei } from "@privacy-wallet/contracts";
import { serializePrices, type Prices } from "@privacy-wallet/protocol/wallet/valuation";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore } from "../src/wallet/notes";
import { priceStore } from "../src/prices";
import type { Deployment } from "../src/chain";
import type { Asset } from "../src/assets";

const rpc = vi.hoisted(() => ({ feesDown: false }));
vi.mock("../src/chain", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/chain")>();
  return {
    ...real,
    // the fee history: 10 gwei base, 1 gwei priority — or none
    clientFor: () => ({
      getFeeHistory: async () => {
        if (rpc.feesDown) throw new Error("mock: the RPC endpoint does not answer");
        return { oldestBlock: 1n, baseFeePerGas: [10_000_000_000n, 10_000_000_000n], gasUsedRatio: [0.5], reward: [[1_000_000_000n]] };
      },
    }),
  };
});
const service = vi.hoisted(() => ({ asked: 0 }));
vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async () => {
        service.asked++;
        return {
          operationId: "op_" + "c".repeat(26),
          order: {
            orderId: ("0x" + "ab".repeat(32)) as Hex,
            params: {
              orderId: "0x" + "ab".repeat(32),
              amount: "1000000000000000000",
              executorTip: "1",
              executeDeadline: 2_000_000_000,
              refundAfter: 2_000_007_200,
            },
            endpoint: "0x00000000000000000000000000000000000e5c02",
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

import { commitOrder } from "../src/swapExecute";
import { CostUnknown, tipCeiling, TIP_CEILING_MULTIPLE } from "../src/executionCost";
import { classify } from "../src/operations/errors/catalog";

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
const ETH = { symbol: "ETH", decimals: 18, token: null, vault: "0x00000000000000000000000000000000000000e1" } as unknown as Asset;
const USDC = {
  symbol: "USDC",
  decimals: 6,
  token: "0x00000000000000000000000000000000000000a0",
  vault: "0x00000000000000000000000000000000000000a1",
} as unknown as Asset;
const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});

const commit = (o: Partial<Parameters<typeof commitOrder>[0]> = {}) =>
  commitOrder({
    masterSeed: session.state().seed!,
    deployment,
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: "1000000000000000000",
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      slippageBps: 50,
      destinationKind: "entered",
    },
    policy: "balanced",
    provider: "thorchain",
    fromAsset: ETH,
    ...o,
  } as Parameters<typeof commitOrder>[0]);
const feed = (symbol: string, usd: bigint, at: number) => ({
  symbol,
  usd1e8: usd * 10n ** 8n,
  roundId: 1n,
  updatedAt: at,
  source: "test",
  endpoints: 1,
  stale: false,
  heartbeatSeconds: 3600,
});
const setLastGood = (p: Prices | null) =>
  session.update((j) => {
    (j as { prices?: unknown }).prices = p ? serializePrices(p) : undefined;
  });

describe("a swap's tips are never accepted unchecked (audit round 2, critic gap 4)", () => {
  it("without a fee read no order is committed: no note counter taken, the service not asked, nothing journaled", async () => {
    rpc.feesDown = true;
    const before = { asked: service.asked, swaps: session.journal().swaps.length, counter: noteStore.nextCounter() };
    try {
      const e = await commit().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CostUnknown);
    } finally {
      rpc.feesDown = false;
    }
    expect(service.asked, "the service was not asked").toBe(before.asked);
    expect(session.journal().swaps).toHaveLength(before.swaps);
    expect(noteStore.nextCounter(), "no note counter taken").toBe(before.counter);
    // the fee history back: the same commit goes through
    expect((await commit()).stored.state).toBe("committed");
    expect(service.asked).toBe(before.asked + 1);
  });

  it("a shield receipt's tip neither: an output token without a price commits nothing", async () => {
    priceStore.reset();
    setLastGood(null);
    const asked = service.asked;
    const e = await commit({
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "ethereum", asset: USDC.token as string, decimals: 6, symbol: "USDC" },
        amount: "1000000000000000000",
        destination: "",
        slippageBps: 50,
      },
      shield: { shieldTip: 1n, fallbackRecipient: "0x00000000000000000000000000000000000000f9" },
    } as Partial<Parameters<typeof commitOrder>[0]>).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CostUnknown);
    expect(service.asked).toBe(asked);
  });

  it("an ERC-20's estimate reads the last good prices of the past day when the current read lacks one; older, there is none", async () => {
    const now = Math.floor(Date.now() / 1000);
    const current: Prices = { chainId: 1, at: now, feeds: { ETH: { unavailable: true, reason: "one endpoint did not answer" }, USDC: feed("USDC", 1n, now) } };
    const last = (at: number): Prices => ({ chainId: 1, at, feeds: { ETH: feed("ETH", 2500n, at), USDC: feed("USDC", 1n, at) } });
    const wei = gasCeilingWei(executionUnits(true), { baseFeePerGas: 10_000_000_000n, priorityFeePerGas: 1_000_000_000n });
    const den = 10n ** 18n * 10n ** 8n;
    const inUsdc = (wei * 2500n * 10n ** 8n * 10n ** 6n + den - 1n) / den;
    setLastGood(last(now - 3600));
    expect(await tipCeiling(deployment, USDC, current), "an hour-old read").toBe(inUsdc * TIP_CEILING_MULTIPLE);
    setLastGood(last(now - 25 * 3600));
    expect(await tipCeiling(deployment, USDC, current), "more than a day old: no estimate").toBeNull();
    setLastGood(null);
  });

  it("reads as nothing moved, the wallet trying again", () => {
    expect(classify(new CostUnknown())).toMatchObject({ code: "cost_unknown", fundsClass: "not-moved", actions: ["wait"] });
  });
});
