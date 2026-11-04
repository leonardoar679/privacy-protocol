// @vitest-environment happy-dom
// The ninth review round (2026-11-04), reviewer B: the zkAPI SDK's provider is revoked by a lock, never swapped for the user's public wallet
// (F2, F3); Forget takes every key the SDK keeps (F6); the trade summary carries the score's total without its components, and its steps
// as a band (F9). The reviewer's probes (scratchpad review9/B p7, p8, p9) became these cases.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { resetPrefsStore } from "../src/storage/prefs";
import { refusingProvider, revocableProvider } from "../src/zkapi/creditWallet";
import { ZKAPI_DEPLOYMENT_KEY, forgetEverything, restartAfterForget } from "../src/platform/forget";
import { stepsBand, tradeSummary } from "../src/zkapi/tradeCheck";

beforeEach(() => {
  resetPrefsStore();
  localStorage.clear();
});
afterEach(() => {
  session.forget();
  connection.reset();
  localStorage.clear();
});

describe("the credit wallet's provider (F2, F3)", () => {
  it("answers while the session that enabled Private AI stays open, refuses everything after — never the public wallet", async () => {
    let live = true;
    const calls: string[] = [];
    const inner = {
      request: async ({ method }: { method: string }) => (calls.push(method), "0x1"),
      on(event: string) {
        calls.push(`on:${event}`);
        return this;
      },
    };
    const p = revocableProvider(inner, () => live);
    expect(await p.request({ method: "eth_chainId" })).toBe("0x1");
    p.on("accountsChanged");
    live = false;
    await expect(p.request({ method: "eth_getTransactionReceipt" })).rejects.toMatchObject({ code: 4100 });
    await expect(p.request({ method: "eth_sendTransaction" })).rejects.toMatchObject({ code: 4100 });
    expect(calls, "nothing reached the wallet after the lock").toEqual(["eth_chainId", "on:accountsChanged"]);
    await expect(refusingProvider.request({ method: "eth_accounts" })).rejects.toMatchObject({ code: 4100 });
  });
});

describe("Forget takes every key of the zkAPI SDK (F6)", () => {
  it("its withdrawal in flight, its exit RPC, its bundler and its deployment go; nothing of anyone else's", async () => {
    await session.create("pw");
    localStorage.setItem("zkapi-withdrawal-v2", JSON.stringify({ phase: "sent", destination: "0x" + "ab".repeat(20), transactionHash: "0x" + "cd".repeat(32) }));
    localStorage.setItem("zkapi-exit-rpc-url", "https://rpc.example");
    localStorage.setItem("zkapi-bundler-url", "https://bundler.example");
    localStorage.setItem(ZKAPI_DEPLOYMENT_KEY, "{}");
    localStorage.setItem("unrelated", "stays");
    await forgetEverything({ caches: null, indexedDB: null, localStorage });
    for (const k of ["zkapi-withdrawal-v2", "zkapi-exit-rpc-url", "zkapi-bundler-url", ZKAPI_DEPLOYMENT_KEY]) expect(localStorage.getItem(k), k).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("stays");
    restartAfterForget(false); // a development build keeps its page; a production one starts again
  });
});

describe("the trade summary (F9)", () => {
  it("carries the score's total without its components — they re-encode the ETA and the impact — and its steps as a band", () => {
    const s = tradeSummary({
      from: { chain: "ethereum", symbol: "ETH", decimals: 18 },
      to: { chain: "bitcoin", symbol: "BTC", decimals: 8 },
      amountUnits: 3n * 10n ** 18n,
      tier: "high-value",
      chosen: {
        provider: "thorchain",
        score: { provider: "thorchain", total: 80.4, components: { price: 80, security: 90, privacy: 70, latency: 27, liquidity: 96, reliability: 90 } },
        quote: { etaSeconds: 900, impactBps: 37, nativeAssets: true, toAmountMin: "4012345678" },
      },
      protection: {
        riskClass: "R2", custody: "tss-vaults", bandBps: [200, 250], capBps: 250, estimatedTranches: 600, gate: "destination-final", concurrency: "sequential",
        elpf: { perCampaignUsd: 1234 }, concentration: { singleVenue: true, providers: [], capBps: 10000 }, staged: false,
      } as never,
    });
    expect(s.chosen).not.toHaveProperty("components");
    expect(s.chosen?.total).toBe(80);
    expect(JSON.stringify(s)).not.toMatch(/"latency"|"liquidity"/);
    expect(s.protection?.steps).toBe("over 100");
    expect([1, 3, 12, 60, 600].map(stepsBand)).toEqual(["1", "2-5", "6-20", "21-100", "over 100"]);
  });
});
