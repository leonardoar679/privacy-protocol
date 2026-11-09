// The twelfth review round, 2026-11-06, F12-7: D11-11's choice of the journaled policy took a service's answer when `DELAY_WINDOW[p]` was truthy —
// which an Object.prototype key ("constructor", "toString", "__proto__") is. Journaled, every resume of the order sent it back and the API refused
// it as an unknown policy: after a lock the order was never rebuilt. A policy the wallet knows is an own key of DELAY_WINDOW, for the commit's
// choice and the swap screen's funding window alike.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

const answer: { policy: unknown } = { policy: "constructor" };
vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async () => ({
        operationId: "op_" + "d".repeat(26),
        order: {
          orderId: ("0x" + "ef".repeat(32)) as Hex,
          params: {
            orderId: "0x" + "ef".repeat(32),
            amount: "1000000000000000000",
            executeDeadline: 2_000_000_000,
            refundAfter: 2_000_007_200,
            executorTip: "0",
          },
          endpoint: "0x00000000000000000000000000000000000e5c02",
          quote: { provider: "thorchain", toAmount: "990", toAmountMin: "980" },
          policy: answer.policy,
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
  tipCeiling: async () => 10n ** 30n,
  shieldTipCeiling: async () => 10n ** 30n,
}));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { Deployment } from "../src/chain";
import { commitOrder } from "../src/swapExecute";
import { DELAY_WINDOW, isKnownPolicy, looserThan, quotedPolicy } from "../src/policy";

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
const PROTOTYPE_KEYS = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
const commit = (over: Record<string, unknown>) =>
  commitOrder({
    masterSeed: session.state().seed!,
    deployment,
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: "1000000000000000000",
      destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      slippageBps: 50,
      destinationKind: "entered",
    },
    fromAsset: { symbol: "ETH", decimals: 18, vault: deployment.ethVault, token: null },
    ...over,
  } as never);

beforeEach(async () => {
  const store = memoryStorage();
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  session.lock();
  await session.create("a strong password", undefined, { replace: true });
  session.acknowledgePhrase();
});

describe("F12-7: a policy the wallet knows is an own key of DELAY_WINDOW", () => {
  it("every policy with a funding window, never a prototype key or another type", () => {
    for (const p of Object.keys(DELAY_WINDOW)) expect(isKnownPolicy(p), p).toBe(true);
    for (const p of [...PROTOTYPE_KEYS, "", "unknown", 1, undefined, null]) expect(isKnownPolicy(p), String(p)).toBe(false);
    // another type whose property key reads as a known one (ZF's critique): never a policy
    for (const p of [["balanced"], { toString: () => "balanced" }]) expect(isKnownPolicy(p), JSON.stringify(p)).toBe(false);
  });

  it("the swap screen's quote-set policy: the service's where the wallet knows it and the commit would take it, else the preference's (ZE's critique)", () => {
    expect(quotedPolicy("best-privacy", "balanced")).toBe("best-privacy");
    expect(quotedPolicy("high-privacy", "balanced"), "stricter: the service's").toBe("high-privacy");
    expect(quotedPolicy("privacy-execution", "best-privacy"), "looser: the preference's, as the commit journals").toBe("best-privacy");
    expect(quotedPolicy("fastest", "balanced"), "Fastest only where chosen").toBe("balanced");
    expect(quotedPolicy("fastest", "fastest")).toBe("fastest");
    for (const p of [...PROTOTYPE_KEYS, undefined]) expect(quotedPolicy(p, "best-price"), String(p)).toBe("best-price");
    expect(quotedPolicy("constructor", "native"), "native is balanced plus a filter").toBe("balanced");
  });

  it("looser than wanted: Fastest where not chosen, or a shorter funding delay — never a policy as strict or stricter", () => {
    expect(looserThan("fastest", "balanced")).toBe(true);
    expect(looserThan("fastest", "fastest")).toBe(false);
    expect(looserThan("balanced", "best-privacy")).toBe(true);
    expect(looserThan("best-privacy", "balanced")).toBe(false);
    expect(looserThan("balanced", "balanced")).toBe(false);
  });

  it("a service answering a policy that is no string — an array whose property key reads as a known one — at the commit: the wallet's own journaled (ZF's critique)", async () => {
    answer.policy = ["best-privacy"];
    const r = await commit({ policy: "balanced", preference: "balanced" });
    expect(r.stored.policy).toBe("balanced");
  });

  for (const p of ["constructor", "toString", "__proto__"]) {
    it(`a service answering policy "${p}" at the commit: the wallet's own policy journaled, never the key`, async () => {
      answer.policy = p;
      const r = await commit({ policy: "balanced", preference: "balanced" });
      expect(r.stored.policy).toBe("balanced");
    });
  }

  it("a screen passing a prototype key as the policy, with no preference: the default balanced journaled", async () => {
    answer.policy = "constructor";
    const r = await commit({ policy: "constructor" });
    expect(r.stored.policy).toBe("balanced");
  });

  it("a known answer as strict as the preference is still taken (D11-11)", async () => {
    answer.policy = "best-privacy";
    const r = await commit({ policy: "balanced", preference: "balanced" });
    expect(r.stored.policy).toBe("best-privacy");
  });
});
