// "Check this trade" (whale spec §22, plan V2 §77–§79): the summary that leaves the wallet carries no
// address, hash or identity (pinned against address shapes), amounts are rounded to one significant digit
// and the route and the competition are closed fields (the eighth review round, C-M3), the answer parses into
// the six lines even with prose around the JSON, and the AI module imports nothing that signs or submits (plan §78).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADDRESS_LIKE, assertSanitized, checkTrade, looksLikePhrase, maskAddresses, parseTradeCheck, reasonCode, roundSignificant, tradeCheckMessages, tradeSummary, type TradeSummary } from "../src/zkapi/tradeCheck";
import { wordlist } from "@scure/bip39/wordlists/english";
import type { InferenceAccess } from "../src/zkapi/policy";
import { onRequest, type RequestRecord } from "@privacy-wallet/privacy-engine/transport/http";

const score = { provider: "thorchain", total: 80, components: { price: 80, security: 90, privacy: 70, latency: 60, liquidity: 80, reliability: 90 } };
const summary = () => tradeSummary({
  from: { chain: "ethereum", symbol: "ETH", decimals: 18 }, to: { chain: "bitcoin", symbol: "BTC", decimals: 8 }, amountUnits: 1364_2n * 10n ** 17n, usd: 3_000_000, tier: "high-value", preference: "balanced",
  chosen: { provider: "thorchain", score, quote: { plan: { mode: "streaming", parts: 300, intervalBlocks: 1, expectedSeconds: 1800 }, etaSeconds: 3600, impactBps: 12, nativeAssets: true, toAmountMin: "4012345678" }, linkPublic: true },
  competition: [{ provider: "thorchain", outcome: "quoted", ms: 900 }, { provider: "chainflip", outcome: "refused", reason: "insufficient liquidity for 0x9858EfFD232B4033E47d90003D41EC34EcaEda94", ms: 1200 }],
  lint: [{ id: "destination-fresh", level: "ok", category: "Destination linkage", text: "Pays bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" } as any],
});

describe("the trade summary", () => {
  it("rounds to one significant digit and carries the assets, the tier, the route's kind, closed answer codes and lint ids — never an address (the eighth review round, C-M3)", () => {
    const s = summary();
    expect(s.kind).toBe("privacy-protocol/trade-check/v2");
    expect(s.amount).toBe("1000");
    // the value of the rounded amount (1,000 ETH at ≈ $2,199), never the exact one's ($3M), and no minimum nor expected loss beside it: four
    // one-digit figures of one amount had pinned it to a few percent (the tenth review round, B10-12)
    expect(s.usd).toBe("2000000");
    expect(s.chosen).not.toHaveProperty("receiveMinRounded");
    expect(s.chosen?.plan, "the mode only: never the parts, the interval, the ETA or the impact the memo carries").toEqual({ mode: "streaming" });
    expect(s.chosen).not.toHaveProperty("etaSeconds");
    expect(s.chosen).not.toHaveProperty("impactBps");
    expect(s.competition[1], "the provider's words never leave: a code, no time").toEqual({ provider: "chainflip", outcome: "refused", reason: "liquidity" });
    expect(JSON.stringify(s)).not.toMatch(/1364|3410|40\.1|3600|1200|"3000000"/);
    expect(s.lint).toEqual([{ id: "destination-fresh", level: "ok", category: "Destination linkage" }]);
    expect(JSON.stringify(s)).not.toMatch(ADDRESS_LIKE);
    expect(reasonCode("LI.FI calldata: first swap amount 1364237891000000000000 != 1364237891000000000000")).toBe("other");
    expect(reasonCode("THORChain refused: trading halted")).toBe("halted");
    expect(reasonCode("quote timed out after 25000 ms")).toBe("timeout");
    expect(reasonCode("toAmountMin below the floor")).toBe("minimum");
    expect(roundSignificant("0.030012")).toBe("0.03");
    expect(roundSignificant(1234567)).toBe("1230000");
    expect(roundSignificant(0)).toBe("0");
  });

  it("the shapes the wallet itself accepts are refused too, and every one is masked (the eighth review round, C-L4)", () => {
    for (const bad of [
      "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ", // uppercase bech32, the QR code's form
      "PP1QYGQXQ8ZZ5RF5J5S4LP9KQ3SVG4X3MWCV7J4DMNQH9X0ZR0", // an uppercase privacy address
      "9858EfFD232B4033E47d90003D41EC34EcaEda94", // an EVM address without 0x
      "a".repeat(64), // a txid without 0x
      "4".repeat(77), // a note secret in decimal
      "5" + "Kq".repeat(43), // a Solana signature's length
    ])
      expect(ADDRESS_LIKE.test(bad), bad).toBe(true);
    expect(maskAddresses("from 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 to bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("from [address] to [address]");
    const phrase = wordlist.slice(0, 24).join(" ");
    expect(looksLikePhrase(`check these: ${phrase}`, wordlist)).toBe(true);
    expect(looksLikePhrase("is this swap a good idea at this size today or should I wait for the market", wordlist)).toBe(false);
  });

  it("assertSanitized refuses every address shape wherever it hides", () => {
    const base = summary();
    for (const bad of ["0x9858EfFD232B4033E47d90003D41EC34EcaEda94", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", "pp1qqqqqqqqqqqqqqqqqqqqqqqqqq", "0x" + "ab".repeat(32)]) {
      const poisoned = { ...base, competition: [{ provider: "x", outcome: "refused", reason: `see ${bad}`, ms: 1 }] } as TradeSummary;
      expect(() => assertSanitized(poisoned)).toThrow(/address-like value at summary\.competition\[0\]\.reason/);
    }
    expect(() => assertSanitized(base)).not.toThrow();
  });

  it("parses the six lines from JSON, from JSON inside prose, and keeps bare text as the best-route line", () => {
    const j = { bestRoute: "THORChain streaming", alternative: "none", estimatedSavings: "n/a", privacy: "good", execution: "300 parts", risk: "low" };
    expect(parseTradeCheck(JSON.stringify(j))).toEqual(j);
    expect(parseTradeCheck(`Sure! Here it is:\n${JSON.stringify(j)}\nAnything else?`)).toEqual(j);
    expect(parseTradeCheck("Just prose.")).toMatchObject({ bestRoute: "Just prose.", risk: "" });
    expect(parseTradeCheck(JSON.stringify({ bestRoute: 42 })).bestRoute).toBe("42");
  });

  it("checkTrade posts only the sanitized summary to the session's provider with its short-lived key, and reads the streamed answer", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const sse = ['data: {"choices":[{"delta":{"content":"{\\"bestRoute\\":\\"THORChain\\","}}]}', 'data: {"choices":[{"delta":{"content":"\\"alternative\\":\\"Chainflip\\",\\"estimatedSavings\\":\\"0.1%\\",\\"privacy\\":\\"Good\\",\\"execution\\":\\"stream\\",\\"risk\\":\\"low\\"}"}}]}', "data: [DONE]"].join("\n\n") + "\n\n";
    const fetchImpl = (async (url: any, init: any) => { seen.push({ url: String(url), init }); return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch;
    const access: InferenceAccess = { mode: "ephemeral-key", apiKey: "k", baseUrl: "https://inference.example/v1", spendingLimitUsd: 1, headers: { authorization: "Bearer k" }, release: () => {} };
    const r = await checkTrade(access, "openai/gpt-4o-mini", summary(), undefined, fetchImpl);
    expect(r).toEqual({ bestRoute: "THORChain", alternative: "Chainflip", estimatedSavings: "0.1%", privacy: "Good", execution: "stream", risk: "low" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://inference.example/v1/chat/completions");
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.messages).toEqual(tradeCheckMessages(summary()));
    expect(JSON.stringify(body)).not.toMatch(ADDRESS_LIKE);
    expect(seen[0].init.credentials).toBe("omit");
    expect(seen[0].init.redirect).toBe("error");
    for (const text of [body.messages[0].content]) expect(text.toLowerCase()).toMatch(/never use the words atomic or anonymous/);
  });

  it("without a fetch of the caller's it goes through the inference transport: announced, under the policy (audit round 2, n51/n73)", async () => {
    const heard: RequestRecord[] = [];
    const off = onRequest((r) => heard.push(r));
    const real = globalThis.fetch;
    const asked: RequestInit[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      asked.push(init ?? {});
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const access: InferenceAccess = { mode: "ephemeral-key", apiKey: "k", baseUrl: "https://inference.example/v1", spendingLimitUsd: 1, headers: { authorization: "Bearer k" }, release: () => {} };
      await checkTrade(access, "openai/gpt-4o-mini", summary());
      expect(heard.map((r) => [r.purpose, r.host])).toEqual([["inference", "inference.example"]]);
      expect(asked[0]).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    } finally {
      globalThis.fetch = real;
      off();
    }
  });
  it("the AI module imports nothing that signs or submits (plan §78)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/zkapi/tradeCheck.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2] }));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      if (!i.typeOnly) expect(i.from, "a value import").toBe("./policy");
      expect(i.from).not.toMatch(/swapKeys|privateTx|relayer|prover|privacyProtocol|chain|session|notes|keys|viem|simulate|swapFunding|swapSign/);
    }
    expect(src).not.toMatch(/signExecutionDigest|privateWithdrawal|privateTransfer|relayerSwapExecute|sendViaInjectedWallet|finalize\(/);
    const aiSession = readFileSync(fileURLToPath(new URL("../src/zkapi/aiSession.ts", import.meta.url)), "utf8");
    expect([...aiSession.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith("react"))).toEqual(["./policy"]);
  });
});
