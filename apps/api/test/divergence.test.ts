// A quote divergence counts against a provider (V3 §10: three in an hour open its breaker, which steers every user's quotes
// away from it). A V6 follow-up of 2026-10-16 (audit c02, c06, c08): the price guard compared the hard quote with every live
// quote, the routes the scoring would not execute too, and each refusal counted, on a provider the caller had picked, for an
// order nobody funded: anyone's own orders could keep any provider's breaker open for every user. The guard now compares with
// the routes the engine would execute, and a refusal counts only for the route the engine itself chose at the commit, once per
// operation, for an order the service values from the enhanced tier by its own read, its escrow funded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubAdapter, harness, orderBody, type Harness } from "./helpers";

let h: Harness;
let other: StubAdapter;
beforeEach(async () => {
  other = new StubAdapter("chainflip");
  h = await harness({ extraAdapters: [other] });
});
afterEach(() => h.close());

const divergences = (p: "thorchain" | "chainflip") => h.deps.engine.tracker.state(p, h.clock.now).divergences;
const prepare = async (op: string) => h.post(`/v1/operations/${op}/prepare`, {});
/** A commit at the best price (thorchain 10 % above chainflip), the provider named by the caller or chosen by the engine. */
async function committed(over: Record<string, unknown> = {}): Promise<string> {
  h.adapter.scale = 110n;
  other.scale = 100n;
  const c = await h.post("/v1/operations", orderBody({ policy: "best-price", ...over }));
  expect(c.status).toBe(200);
  return c.body.operationId as string;
}

describe("a quote divergence, only where no caller's choice makes it", () => {
  it("the route the engine chose, funded: the guard refuses its fallen quote, and it counts once per operation", async () => {
    h.script.balance = 10n ** 18n; // the escrow holds the order
    const op = await committed();
    h.adapter.scale = 90n; // thorchain's hard quote falls below chainflip's
    const p = await prepare(op);
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("price_guard");
    expect(divergences("thorchain")).toBe(1);
    expect((await prepare(op)).status).toBe(409);
    expect(divergences("thorchain"), "prepared again: the same operation counts once").toBe(1);
  });

  it("an unfunded order counts nothing, nor a provider the caller named", async () => {
    h.script.balance = 0n;
    const unfunded = await committed();
    h.adapter.scale = 90n;
    expect((await prepare(unfunded)).status).toBe(409);
    expect(divergences("thorchain"), "nobody funded it").toBe(0);
    h.script.balance = 10n ** 18n;
    const picked = await committed({ provider: "chainflip" });
    other.scale = 80n; // the caller's pick, below thorchain's quote
    expect((await prepare(picked)).status).toBe(409);
    expect(divergences("chainflip"), "the caller named it").toBe(0);
  });

  it("a route the scoring would not execute is no alternative: the guard passes the hard quote", async () => {
    h.script.balance = 10n ** 18n;
    other.verified = false; // a minimum this service cannot read: filtered under a strict policy
    const op = await committed();
    h.adapter.scale = 90n;
    other.scale = 100n;
    expect((await prepare(op)).status).toBe(200);
    expect(divergences("thorchain")).toBe(0);
  });
});
