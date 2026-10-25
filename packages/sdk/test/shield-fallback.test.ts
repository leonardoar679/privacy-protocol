// A swap into the protected balance publishes its shield receiver's fallback at the commit (it goes to the swap service and
// the relayer, becomes the receiver's immutable, and is in its deployment's calldata), so the book marks it used then
// (audit round 2, r32): Receive had offered it as "a fresh address of this wallet, used once", to a payer who would see it
// tied to the swap. Offline: the service, the order check and the gas ceilings are stubs; the commit is the real code's.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { bookOf } from "../src/wallet/addressBook";
import { consumeFreshAddress } from "../src/keys/chainKeys";
import type { Deployment } from "../src/chain";
import type { Asset } from "../src/assets";

vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async () => ({
        operationId: "op_" + "a".repeat(26),
        order: {
          orderId: ("0x" + "ab".repeat(32)) as Hex,
          params: { orderId: "0x" + "ab".repeat(32), amount: "1000000000000000000", executeDeadline: 2_000_000_000, refundAfter: 2_000_007_200 },
          endpoint: "0x00000000000000000000000000000000000e5c00",
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
  // a ceiling far above any tip here (these tests check other things; a null estimate commits nothing: critic gap 4)
  tipCeiling: async () => 10n ** 30n,
  shieldTipCeiling: async () => 10n ** 30n,
}));

import { commitOrder } from "../src/swapExecute";

const ETH_VAULT = "0x00000000000000000000000000000000000000e1" as Address;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: ETH_VAULT,
  rpcUrl: "http://x",
  rpcUrls: ["http://x"],
  fromBlock: 0n,
  erc20Vaults: [],
  swapFactory: "0x00000000000000000000000000000000000000f1",
  shieldFactory: "0x00000000000000000000000000000000000000f2",
} as Deployment;
const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});

describe("a shield receiver's fallback (audit round 2, r32)", () => {
  it("is used in the book from its commit: never offered again as an unused fresh address", async () => {
    const fallback = consumeFreshAddress(session.state().seed!, "evm").address as Address;
    const entry = () => bookOf(session.journal()).find((e) => e.address.toLowerCase() === fallback.toLowerCase());
    expect(entry()?.lifecycle, "reserved: still unused").not.toBe("used");
    await commitOrder({
      masterSeed: session.state().seed!,
      deployment,
      request: {
        from: { chain: "ethereum", asset: "0x00000000000000000000000000000000000000d5", decimals: 6, symbol: "USDC" },
        to: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        amount: "1000000000000000000",
        destination: "",
        slippageBps: 50,
      },
      policy: "balanced",
      provider: "thorchain",
      fromAsset: {
        symbol: "USDC",
        decimals: 6,
        vault: "0x00000000000000000000000000000000000000e2",
        token: "0x00000000000000000000000000000000000000d5",
      } as unknown as Asset,
      shield: { shieldTip: 1_000n, fallbackRecipient: fallback },
    } as Parameters<typeof commitOrder>[0]);
    expect(entry()).toMatchObject({ lifecycle: "used" });
  });
});
