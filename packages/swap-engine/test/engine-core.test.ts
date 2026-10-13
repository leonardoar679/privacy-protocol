import { describe, it, expect } from "vitest";
import { MemoryJournal, TERMINAL, nextState, recoverState, transition, userStatus } from "../src/order";
import { chooseRoute, scoreRoutes } from "../src/scoring";
import { privacyScore } from "../src/privacyScore";
import { securityScore, BASELINE_SECURITY, INCIDENTS } from "../src/health";
import type { Health, Order, OrderState, Quote } from "../src/types";

describe("route state machine (spec §3)", () => {
  it("walks the happy path and lands in a terminal state", () => {
    let s: OrderState = "QUOTED";
    for (const ev of ["commit", "submit-source", "source-final", "executed", "destination-submitted", "destination-final", "completed"] as const) s = nextState(s, ev);
    expect(s).toBe("COMPLETED");
    expect(TERMINAL).toContain(s);
  });
  it("every failure branch reaches REFUND_PENDING -> REFUNDED", () => {
    for (const fail of ["PROVIDER_TIMEOUT", "PARTIAL", "DESTINATION_FAILED", "FAILED"] as OrderState[]) {
      expect(nextState(nextState(fail, "refund-window"), "refunded")).toBe("REFUNDED");
    }
  });
  it("rejects illegal transitions (e.g. completing without a destination)", () => {
    expect(() => nextState("SOURCE_FINAL", "completed")).toThrow(/illegal/);
    expect(() => nextState("COMPLETED", "refunded")).toThrow(/illegal/);
  });
  it("user-facing statuses never claim atomicity and cover every state", () => {
    const states: OrderState[] = ["QUOTED", "COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED", "EXPIRED", "CANCELLED", "SOURCE_FAILED", "PROVIDER_TIMEOUT", "PARTIAL", "DESTINATION_FAILED", "REFUND_PENDING", "REFUNDED", "FAILED"];
    const labels = new Set(states.map(userStatus));
    expect(labels).toEqual(new Set(["Pending", "Executing", "Completed", "Partial", "Refunding", "Refunded", "Failed"]));
  });
  it("journals every transition and recovers state from chain facts", async () => {
    const j = new MemoryJournal();
    const o = { orderId: "0x01", state: "QUOTED", history: [], params: { amount: 100n, executeDeadline: 1000, refundAfter: 2000 }, quote: { expiresAt: 900 } } as unknown as Order;
    await transition(o, "commit", j);
    await transition(o, "submit-source", j);
    expect((await j.load("0x01"))!.state).toBe("SOURCE_SUBMITTED");
    expect(recoverState(o, { now: 500, escrowBalance: 100n, executed: false, refunded: false })).toBe("SOURCE_FINAL");
    expect(recoverState(o, { now: 1500, escrowBalance: 100n, executed: false, refunded: false })).toBe("PROVIDER_TIMEOUT");
    expect(recoverState(o, { now: 2500, escrowBalance: 100n, executed: false, refunded: false })).toBe("REFUND_PENDING");
    expect(recoverState(o, { now: 2500, escrowBalance: 0n, executed: true, refunded: false, track: { state: "completed" } })).toBe("COMPLETED");
    expect(recoverState(o, { now: 2500, escrowBalance: 3n, executed: true, refunded: true })).toBe("REFUNDED");
  });
});

const q = (provider: Quote["provider"], toMin: bigint, eta: number, extra: Partial<Quote> = {}): Quote => ({
  provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: eta,
  expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], raw: null, obtainedAt: Date.now(), ...extra,
});
const ok = (provider: Quote["provider"]): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() });

describe("route scoring (spec §9)", () => {
  it("the best price does not win automatically under best-privacy", () => {
    const quotes = [q("near-intents", 1_000_000n, 60), q("chainflip", 980_000n, 60)]; // 2% price gap
    const health = { "near-intents": ok("near-intents"), chainflip: ok("chainflip") } as Record<Quote["provider"], Health>;
    const byPrice = chooseRoute(scoreRoutes(quotes, health, "best-price"));
    const byPrivacy = chooseRoute(scoreRoutes(quotes, health, "best-privacy"));
    expect(byPrice!.provider).toBe("near-intents");
    expect(byPrivacy!.provider).toBe("chainflip"); // higher privacy + security baseline beats 2% of price (not 5%: price −10/% × 0.10 weight)
  });
  it("a provider with a recent key-compromise incident loses even under best-privacy", () => {
    const quotes = [q("thorchain", 1_000_000n, 60), q("chainflip", 1_000_000n, 60)];
    const health = { thorchain: ok("thorchain"), chainflip: ok("chainflip") } as Record<Quote["provider"], Health>;
    const at = Date.parse("2026-06-15"); // one month after the THORChain GG20 exploit
    expect(chooseRoute(scoreRoutes(quotes, health, "best-privacy", at))!.provider).toBe("chainflip");
  });
  it("filters halted providers, expired quotes and routes without a limit", () => {
    const quotes = [q("thorchain", 1n, 10), q("lifi", 2n, 10, { expiresAt: 1 }), q("mayan", 3n, 10, { minOutEncoded: false })];
    const health = { thorchain: { ...ok("thorchain"), halted: true }, lifi: ok("lifi"), mayan: ok("mayan") } as Record<Quote["provider"], Health>;
    const scores = scoreRoutes(quotes, health, "best-price");
    expect(scores.map((s) => s.filtered)).toEqual(["provider halted", "quote expired", "no minimum-output protection"]);
    expect(chooseRoute(scores)).toBeUndefined();
  });
  it("the incident feed depresses THORChain's security score for a decaying window", () => {
    const inc = INCIDENTS.find((i) => i.provider === "thorchain")!;
    const at = Date.parse(inc.date) + 30 * 86_400_000;
    expect(securityScore("thorchain", at)).toBeLessThan(BASELINE_SECURITY.thorchain - 15);
    expect(securityScore("thorchain", Date.parse(inc.date) + 2 * inc.halfLifeDays * 86_400_000)).toBe(BASELINE_SECURITY.thorchain - 3); // the incident has decayed to nothing; by then the last published audit (Zellic, 2025-01) is over two years old: −3
    expect(securityScore("chainflip", at)).toBe(BASELINE_SECURITY.chainflip);
  });
});

describe("cross-chain privacy score (spec §10)", () => {
  const best = { sourceIsPool: true, destinationFresh: true, amountIsBucket: true, delaySeconds: 8 * 3600, providerKind: "deposit-address" as const, nativeAssets: true, oneTimeEndpoints: true, privateSubmission: true };
  it("the pool + fresh endpoints + buckets + delay score high; a public wallet immediate swap scores low", () => {
    expect(privacyScore(best)).toBeGreaterThanOrEqual(90);
    const worst = { ...best, sourceIsPool: false, destinationFresh: false, amountIsBucket: false, amountUniqueness: 1, delaySeconds: 0, nativeAssets: false, oneTimeEndpoints: false, privateSubmission: false };
    expect(privacyScore(worst)).toBeLessThan(40);
  });
  it("each channel moves the score monotonically", () => {
    expect(privacyScore({ ...best, amountIsBucket: false, amountUniqueness: 0.9 })).toBeLessThan(privacyScore(best));
    expect(privacyScore({ ...best, delaySeconds: 0 })).toBeLessThan(privacyScore({ ...best, delaySeconds: 3600 }));
    expect(privacyScore({ ...best, nativeAssets: false })).toBeLessThan(privacyScore(best));
  });
  it("a public escrow → destination link (every adapter today) leaves the pool-side score exactly as it is, whatever the provider's traffic", () => {
    const arbitrary = { ...best, amountIsBucket: false, amountUniqueness: 0.9, delaySeconds: 600 };
    for (const base of [best, arbitrary])
      for (const throughputPerHour of [0, 5, 100, 10_000])
        expect(privacyScore({ ...base, crossChain: { throughputPerHour, etaSeconds: 600, linkPublic: true } })).toBe(privacyScore(base));
  });
  it("a provider that kept the link private would add a second hurdle: never lower, higher with more cover traffic", () => {
    const arbitrary = { ...best, amountIsBucket: false, amountUniqueness: 0.9, delaySeconds: 600 };
    const at = (base: typeof best, throughputPerHour: number) => privacyScore({ ...base, crossChain: { throughputPerHour, etaSeconds: 1800, linkPublic: false } });
    for (const base of [{ ...best, delaySeconds: 600 }, arbitrary]) {
      expect(at(base, 0)).toBe(privacyScore(base));
      let last = privacyScore(base);
      for (const r of [5, 20, 100, 1000, 100_000]) {
        expect(at(base, r)).toBeGreaterThanOrEqual(last);
        last = at(base, r);
      }
      expect(last).toBeGreaterThan(privacyScore(base));
    }
  });
  it("every adapter states whether it publishes the escrow → destination link, and where; orders and quote sets carry it", async () => {
    const { defaultEngine } = await import("../src/config");
    const engine = defaultEngine();
    for (const a of engine.cfg.adapters) {
      const c = a.capabilities();
      expect(typeof c.destinationLinkPublic, a.id).toBe("boolean");
      expect(c.linkEvidence.length, a.id).toBeGreaterThan(20);
      expect(engine.linkPublic(a.id)).toBe(c.destinationLinkPublic);
    }
    const quote: Quote = { provider: "thorchain", category: "A", toAmount: 1n, toAmountMin: 1n, fees: [], etaSeconds: 600, expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], raw: {}, obtainedAt: Date.now() };
    const order = engine.buildOrder({ from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: 10n ** 18n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 }, "best-privacy", quote, { orderSigner: "0x000000000000000000000000000000000000a11c", refundOwnerCommitment: 1n, refundNoteSecret: 2n, refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}` });
    expect(order.privacy.destinationLinkPublic).toBe(true);
    expect(order.privacy.score).toBe(privacyScore({ sourceIsPool: true, destinationFresh: true, amountIsBucket: true, amountUniqueness: 0.5, delaySeconds: order.privacy.delaySeconds[0], providerKind: "deposit-address", nativeAssets: true, oneTimeEndpoints: true, privateSubmission: true }));
  });
});

describe("routes that cannot be executed from the escrow", () => {
  it("are scored for information but never chosen", () => {
    const quotes = [q("near-intents", 1_000_000n, 60), q("thorchain", 900_000n, 60)];
    const health = { "near-intents": ok("near-intents"), thorchain: ok("thorchain") } as Record<Quote["provider"], Health>;
    const scores = scoreRoutes(quotes, health, "best-price", Date.now(), { "near-intents": "ingress from a contract sender unconfirmed by the provider" });
    expect(scores.find((s) => s.provider === "near-intents")!.filtered).toMatch(/contract sender/);
    expect(chooseRoute(scores)!.provider).toBe("thorchain");
  });
});
