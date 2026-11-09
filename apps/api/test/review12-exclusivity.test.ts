// The twelfth review round, 2026-11-06, F12-4 and its critique ZE: a route naming an exclusive relayer for longer than the wallet signs (600 s,
// D11-10) is set aside at the competition — never ranked, chosen, committed and funded, the wallet then refusing its call at signing. Only at the
// competition: an order committed before Across named one is rebuilt and prepared as before, and the wallet's own check before a delayed
// one-confirm funding stops it unfunded — refused here, its prepare had answered a 502 that check reads as an outage, and the order was funded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubAdapter, harness, orderBody, signedRestore, swapRequest, type Harness } from "./helpers";
import type { Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";

/** An Across-like route: its quote carries the exclusive relayer's window, when one is named. */
class ExclusiveAdapter extends StubAdapter {
  window: number | undefined = undefined;
  scale = 101n; // a better route than THORChain's, so it is the one chosen unless set aside
  constructor() {
    super("uniswap-across");
  }
  async quote(req: QuoteRequest): Promise<Quote> {
    return { ...(await super.quote(req)), ...(this.window !== undefined ? { exclusivitySeconds: this.window } : {}) };
  }
}

let h: Harness;
let across: ExclusiveAdapter;
beforeEach(async () => {
  across = new ExclusiveAdapter();
  h = await harness({ extraAdapters: [across] });
});
afterEach(async () => {
  await h.close();
});
const scoreOf = (body: { scores: { provider: string; filtered?: string }[] }) => body.scores.find((s) => s.provider === "uniswap-across");

describe("F12-4: a route the wallet would refuse at signing is set aside at the competition", () => {
  it("an exclusive relayer for an hour: filtered with its reason, never chosen", async () => {
    across.window = 3600;
    const q = await h.post("/v1/quotes", swapRequest());
    expect(q.status).toBe(200);
    expect(scoreOf(q.body)?.filtered).toMatch(/only one relayer may fill the deposit for 3600 s \(at most 600 s, as the wallet signs\)/);
    expect(q.body.chosen?.provider).toBe("thorchain");
  });

  it("the wallet's 600 s, 601 s and none: taken, set aside, taken — the better route chosen when taken", async () => {
    for (const [window, filtered] of [
      [600, false],
      [601, true],
      [undefined, false],
    ] as const) {
      across.window = window;
      const q = await h.post("/v1/quotes", swapRequest());
      expect(!!scoreOf(q.body)?.filtered, String(window)).toBe(filtered);
      expect(q.body.chosen?.provider, String(window)).toBe(filtered ? "thorchain" : "uniswap-across");
    }
  });

  it("a commit naming it while it names one for an hour is refused", async () => {
    across.window = 3600;
    const c = await h.post("/v1/operations", orderBody({ provider: "uniswap-across" }));
    expect(c.status).toBe(400);
    expect(c.body.code).toBe("route_filtered");
  });

  it("an order committed before the relayer was named is rebuilt and prepared as before — the wallet's refusal at signing stops it, never a 502 that funds it", async () => {
    const c = await h.post("/v1/operations", orderBody({ provider: "uniswap-across" }));
    expect(c.status).toBe(200);
    across.window = 3600;
    const r = await h.post(
      `/v1/operations/${c.body.operationId}/resume`,
      signedRestore({ ...swapRequest(), provider: "uniswap-across", params: c.body.order.params }),
    );
    expect(r.status, "the rebuild takes the route it was committed on").toBe(200);
    const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
    expect(p.status, "the call is returned, for the wallet's own check").toBe(200);
  });
});
