// The twelfth review round, 2026-11-06, F12-1 and the critiques ZB, ZC: Mayan asked for the committed route type (a Swift order refunds a failure to
// the escrow, a Fast-MCTP one at the destination) and quoting none of it while it quotes the other is its own answer to the request, never an outage:
// RefundRouteUnavailable, naming where the route it quotes refunds. A rebuild and a prepare answer it refund_route_unavailable; before, the adapter threw
// a plain error, and the API asked every provider again unbound to tell it from an outage (ZB). The price API answers its single best route unless asked
// for the full list (fullList=true), so a bound type behind the best one had read as not offered (ZC): asked for a type, the adapter asks for the list.
import { describe, it, expect } from "vitest";
import { MayanAdapter } from "../src/adapters/mayan";
import { AdapterRefusal, RefundRouteUnavailable, type QuoteRequest } from "../src/types";

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" } as const;
const SOL = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" } as const;
const ask = (refundTarget?: "escrow" | "destination"): QuoteRequest => ({ from: ETH, to: SOL, amount: 10n ** 18n, destination: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", slippageBps: 50, ...(refundTarget ? { refundTarget } : {}) });
/**
 * Mayan's price API as it answers (read live, 2026-11-09): of the types it `offers` and the query asks for, the single best one (the first offered)
 * with fullList=false, every one with fullList=true. A quote's own checks come after the type is chosen, so a bare `{ type }` reaches them.
 */
async function answering<T>(offers: string[], run: () => Promise<T>, o: { listsUnasked?: boolean } = {}): Promise<{ result: T; queries: URLSearchParams[] }> {
  const real = globalThis.fetch;
  const queries: URLSearchParams[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const q = new URL(String(url)).searchParams;
    queries.push(q);
    const asked = o.listsUnasked ? offers : offers.filter((t) => (t === "SWIFT" ? q.get("swift") === "true" : t === "FAST_MCTP" ? q.get("fastMctp") === "true" : false));
    const listed = q.get("fullList") === "true" ? asked : asked.slice(0, 1);
    return new Response(JSON.stringify({ quotes: listed.map((type) => ({ type })) }), { status: 200 });
  }) as typeof fetch;
  try {
    return { result: await run(), queries };
  } finally {
    globalThis.fetch = real;
  }
}
const both = () => new MayanAdapter({ orderTypes: ["FAST_MCTP", "SWIFT"] });
const settle = (p: Promise<unknown>) => p.catch((x: unknown) => x);

describe("F12-1 (ZB, ZC): Mayan's own answer when the committed route type is not quoted", () => {
  it("asked for Fast-MCTP while Swift is its best and both are offered: the full list is asked for, and the Fast-MCTP quote is the one checked — never a refusal", async () => {
    const { result: e, queries } = await answering(["SWIFT", "FAST_MCTP"], () => settle(both().quote(ask("destination"))));
    expect(queries[0]?.get("fullList")).toBe("true");
    expect(e).not.toBeInstanceOf(RefundRouteUnavailable);
    expect(e, "the bare quote fails the Fast-MCTP checks: it was the one taken").toBeInstanceOf(AdapterRefusal);
    expect((e as Error).message).toMatch(/^FAST_MCTP: /);
  });

  it("and the other way, every wallet commit's and requote's ask: asked for Swift while Fast-MCTP is its best and both are offered, the Swift quote is the one checked (ZD's critique)", async () => {
    const { result: e, queries } = await answering(["FAST_MCTP", "SWIFT"], () => settle(both().quote(ask("escrow"))));
    expect(queries[0]?.get("fullList")).toBe("true");
    expect(e).not.toBeInstanceOf(RefundRouteUnavailable);
    expect(e, "the bare quote fails the Swift checks: it was the one taken").toBeInstanceOf(AdapterRefusal);
    expect((e as Error).message).toMatch(/^SWIFT: /);
  });

  it("asked for Swift while it quotes Fast-MCTP only: RefundRouteUnavailable, its route refunding at the destination", async () => {
    const { result: e } = await answering(["FAST_MCTP"], () => settle(both().quote(ask("escrow"))));
    expect(e).toBeInstanceOf(RefundRouteUnavailable);
    expect(e).toBeInstanceOf(AdapterRefusal); // a refusal: never counted as the provider's outage
    expect((e as RefundRouteUnavailable).refundsAt).toBe("destination");
    expect((e as Error).message).toMatch(/no SWIFT quote now, only FAST_MCTP/);
  });

  it("asked for Fast-MCTP while it quotes Swift only: RefundRouteUnavailable, its route refunding to the escrow", async () => {
    const { result: e } = await answering(["SWIFT"], () => settle(both().quote(ask("destination"))));
    expect(e).toBeInstanceOf(RefundRouteUnavailable);
    expect((e as RefundRouteUnavailable).refundsAt).toBe("escrow");
  });

  it("quoting nothing at all is not it: the outage it was (a plain error)", async () => {
    const { result: e } = await answering([], () => settle(both().quote(ask("escrow"))));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AdapterRefusal);
    expect((e as Error).message).toMatch(/no FAST_MCTP\/SWIFT quote/);
  });

  it("nor is a route type this adapter does not take: with Swift alone configured, a Fast-MCTP quote is no route of its own — listed or not", async () => {
    for (const listsUnasked of [false, true]) {
      const { result: e } = await answering(["FAST_MCTP"], () => settle(new MayanAdapter({ orderTypes: ["SWIFT"] }).quote(ask("escrow"))), { listsUnasked });
      expect(e, `listed unasked: ${listsUnasked}`).not.toBeInstanceOf(RefundRouteUnavailable);
    }
  });

  it("asked for no type (a Review's quote), it asks for Mayan's single best route, as before", async () => {
    const { queries } = await answering(["SWIFT", "FAST_MCTP"], () => settle(both().quote(ask())));
    expect(queries[0]?.get("fullList")).toBe("false");
  });
});
