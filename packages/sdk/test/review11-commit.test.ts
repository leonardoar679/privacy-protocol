// The eleventh review round (2026-11-04), the commit: the route the user reviewed is the one committed (D11-4) — the provider asked for, a
// failure refunding where its quote said —; a destination the service is told is marked used before it is asked (A11-5), so a commit refused
// after the answer never leaves it on offer as fresh, and the order it became takes the use over — one use, never two; the policy journaled is
// never Fastest unless the wallet asked for it (D11-11).
// Offline: the service, the order check and the gas ceilings are stubs (as in review10-commit.test.ts); the commit is the real code.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { Deployment } from "../src/chain";

const answer: { provider: string; refundTarget?: string; policy?: string; reject?: Error } = { provider: "thorchain" };
const seen: { bodies: unknown[] } = { bodies: [] };
vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async (body: unknown) => {
        seen.bodies.push(body);
        if (answer.reject) throw answer.reject;
        return {
          operationId: "op_" + "c".repeat(26),
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
            quote: { provider: answer.provider, toAmount: "990", toAmountMin: "980", ...(answer.refundTarget ? { refundTarget: answer.refundTarget } : {}) },
            ...(answer.policy ? { policy: answer.policy } : {}),
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
import { consumeFreshAddress, lastUnusedFreshAddress } from "../src/keys/chainKeys";

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
const commit = (
  destination: string,
  o: {
    provider?: string;
    policy?: string;
    preference?: string;
    shown?: Record<string, unknown>;
    shield?: { shieldTip: bigint; fallbackRecipient: string };
    deployment?: Deployment;
  } = {},
) =>
  commitOrder({
    masterSeed: session.state().seed!,
    deployment: o.deployment ?? deployment,
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: "1000000000000000000",
      destination,
      slippageBps: 50,
      destinationKind: "fresh",
    },
    policy: o.policy ?? "balanced",
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.shown ? { shown: o.shown } : {}),
    ...(o.preference ? { preference: o.preference } : {}),
    ...(o.shield ? { shield: o.shield } : {}),
    fromAsset: { symbol: "ETH", decimals: 18, vault: "0x00000000000000000000000000000000000000e1" },
  } as never).catch((e: unknown) => e as { code?: string; field?: string; message?: string });

beforeEach(async () => {
  const store = memoryStorage();
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  session.lock();
  await session.create("a strong password", undefined, { replace: true });
  session.acknowledgePhrase();
  seen.bodies = [];
  Object.assign(answer, { provider: "thorchain", refundTarget: undefined, policy: undefined, reject: undefined });
});

describe("the route the user reviewed is the one committed (D11-4)", () => {
  it("a service that commits another provider than the one asked for is refused: journaled nowhere", async () => {
    const dest = consumeFreshAddress(session.state().seed!, "bitcoin").address;
    answer.provider = "mayan";
    const r = await commit(dest, { provider: "thorchain" });
    expect((r as { message?: string }).message).toMatch(/not on the thorchain you reviewed/);
    expect(session.journal().swaps).toEqual([]);
  });

  it("the provider shown on the Review counts when none is named, and a refund elsewhere than its quote said is refused", async () => {
    const dest = consumeFreshAddress(session.state().seed!, "bitcoin").address;
    answer.provider = "mayan";
    answer.refundTarget = "destination";
    const shown = { provider: "mayan", toAmount: "990", toAmountMin: "980" };
    const r = await commit(dest, { shown });
    expect((r as { message?: string }).message).toMatch(/refunds a failure at your destination address/);
    const ok = await commit(dest, { shown: { ...shown, refundTarget: "destination" } });
    expect((ok as { stored?: { provider: string } }).stored?.provider).toBe("mayan");
    // a move toward the pool is no refusal: the Review showed Fast-MCTP, the service committed Swift (the correctness critic)
    answer.refundTarget = "escrow";
    const better = await commit(consumeFreshAddress(session.state().seed!, "bitcoin").address, { shown: { ...shown, refundTarget: "destination" } });
    expect((better as { stored?: { provider: string } }).stored?.provider).toBe("mayan");
  });
});

describe("the destination is marked used before the service is asked (A11-5)", () => {
  it("a commit refused after the service answered leaves no fresh address on offer that the service holds", async () => {
    const seed = session.state().seed!;
    const dest = consumeFreshAddress(seed, "bitcoin").address;
    expect(lastUnusedFreshAddress(seed, "bitcoin")?.address, "reserved, not used yet: Receive would offer it").toBe(dest);
    answer.provider = "chainflip";
    const r = await commit(dest, { provider: "thorchain" });
    expect((r as { field?: string }).field, "the commit was refused after the answer").toBe("provider");
    expect(session.journal().swaps, "nothing journaled").toEqual([]);
    expect(seen.bodies).toHaveLength(1); // the service was told the destination
    expect(lastUnusedFreshAddress(seed, "bitcoin"), "never offered again").toBeNull();
    const entry = (session.journal().addressBook ?? []).find((e) => e.address === dest);
    expect(entry?.lifecycle).toBe("used");
  });

  it("a commit the service itself refuses (its tip moved) after receiving the destination never leaves it on offer", async () => {
    const seed = session.state().seed!;
    const dest = consumeFreshAddress(seed, "bitcoin").address;
    answer.reject = Object.assign(new Error("the executor tip moved: quote again"), { code: "tip_moved", status: 409 });
    const r = await commit(dest, { provider: "thorchain" });
    expect((r as { code?: string }).code).toBe("tip_moved");
    expect(JSON.stringify(seen.bodies[0])).toContain(dest);
    expect(lastUnusedFreshAddress(seed, "bitcoin"), "the service has it: never offered again").toBeNull();
  });

  it("a protected-balance commit refused after the answer leaves its shield fallback used, never on offer", async () => {
    const seed = session.state().seed!;
    const fallback = consumeFreshAddress(seed, "evm").address;
    answer.provider = "chainflip";
    const r = await commit("", {
      provider: "thorchain",
      shield: { shieldTip: 1_000n, fallbackRecipient: fallback },
      deployment: { ...deployment, shieldFactory: "0x00000000000000000000000000000000000000f2" } as Deployment,
    });
    expect((r as { field?: string }).field).toBe("provider");
    expect(session.journal().swaps).toEqual([]);
    expect((session.journal().addressBook ?? []).find((e) => e.address.toLowerCase() === fallback.toLowerCase())?.lifecycle).toBe("used");
    expect(lastUnusedFreshAddress(seed, "evm"), "never offered again").toBeNull();
  });

  it("a commit journaled: the order takes the attempt's use over — the address book counts one operation, never two", async () => {
    const dest = consumeFreshAddress(session.state().seed!, "bitcoin").address;
    const r = (await commit(dest, { provider: "thorchain" })) as { stored?: { orderId: string } };
    const entry = (session.journal().addressBook ?? []).find((e) => e.address === dest);
    expect(entry?.usedBy).toEqual([r.stored!.orderId]);
  });
});

describe("the policy journaled (D11-11)", () => {
  it("is never Fastest unless the wallet asked for it — Fastest alone accepts a call that binds no minimum", async () => {
    const dest = consumeFreshAddress(session.state().seed!, "bitcoin").address;
    answer.policy = "fastest";
    const r = (await commit(dest, { provider: "thorchain", policy: "best-privacy" })) as { stored?: { policy: string } };
    expect(r.stored?.policy).toBe("best-privacy");
    answer.policy = "best-price";
    const s = (await commit(consumeFreshAddress(session.state().seed!, "bitcoin").address, { provider: "thorchain", policy: "balanced" })) as {
      stored?: { policy: string };
    };
    expect(s.stored?.policy, "any other answer of the service stands").toBe("best-price");
  });

  it("is bounded by the wallet's own reading of the preference: a service saying Fastest at the quote and the commit gets Balanced for a Balanced user, and never a shorter delay", async () => {
    answer.policy = "fastest";
    const a = (await commit(consumeFreshAddress(session.state().seed!, "bitcoin").address, {
      provider: "thorchain",
      policy: "fastest",
      preference: "balanced",
    })) as { stored?: { policy: string } };
    expect(a.stored?.policy, "the screens pass the quote-time policy: Fastest here").toBe("balanced");
    answer.policy = "balanced";
    const b = (await commit(consumeFreshAddress(session.state().seed!, "bitcoin").address, {
      provider: "thorchain",
      policy: "balanced",
      preference: "best-privacy",
    })) as { stored?: { policy: string } };
    expect(b.stored?.policy, "1–24 h is shorter than Best privacy's 6–72 h").toBe("best-privacy");
    answer.policy = "fastest";
    const c = (await commit(consumeFreshAddress(session.state().seed!, "bitcoin").address, {
      provider: "thorchain",
      policy: "fastest",
      preference: "fastest",
    })) as { stored?: { policy: string } };
    expect(c.stored?.policy, "the user chose Fastest").toBe("fastest");
  });
});
