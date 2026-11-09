// The twelfth review round, 2026-11-06, F12-1: the API's resume and its restore-prepare rebuild an order from a fresh quote. Round 11 (D11-4)
// binds the committed route's refund target at the prepare, but the rebuild had stored a fresh quote that refunds elsewhere — an honest Mayan
// flip between Swift (refund to the escrow) and Fast-MCTP (refund at the destination) — and the next prepare bound that one: the wallet's
// signing gate then refused the call after the funding, or, the other way, its tracker read a Swift refund to the escrow as paid at the
// destination (it reads where a refund went from the quote it journaled at the commit). The rebuild now quotes on the committed target, both
// ways: the wallet's (unsigned — its gate refuses a destination refund its journal does not name), else the blob's. Mayan quoting only the other
// route type answers `refund_route_unavailable`, at a rebuild and at the prepare alike; a provider's quote of another type, or naming none, is its
// answer of the moment, a failure tried again (502); one that failed or quoted nothing at a rebuild, no quote.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubAdapter, harness, orderBody, sign, signedRestore, swapRequest, type Harness } from "./helpers";
import { RefundRouteUnavailable, type ProviderId, type Quote, type QuoteRequest } from "@privacy-wallet/swap-engine/types";
import { decodeBlob } from "../src/blob";

type Target = "escrow" | "destination";
/** A Mayan-like adapter: of the route types it `offers` now, the one the request names, else its `better` one — asked for a type it does not
 *  offer while it offers the other, Mayan's own refusal; `stubborn` (LI.FI's facets), its better one whatever it is asked; `namesNone`, a quote
 *  that does not say where it refunds; `down`, nothing at all; `failOnce`, one failure of the next ask. */
class FlipAdapter extends StubAdapter {
  better: Target = "escrow";
  offers: Target[] = ["escrow", "destination"];
  stubborn = false;
  namesNone = false;
  down = false;
  failOnce = false;
  asked: (string | undefined)[] = [];
  constructor(id: ProviderId = "mayan") {
    super(id);
  }
  async quote(req: QuoteRequest): Promise<Quote> {
    this.asked.push(req.refundTarget);
    if (this.down) throw new Error("mayan: HTTP 503");
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("mayan: HTTP 503");
    }
    if (this.namesNone) return super.quote(req);
    const preferred = this.offers.includes(this.better) ? this.better : this.offers[0];
    const pick = this.stubborn || !req.refundTarget ? preferred : req.refundTarget;
    if (!pick || !this.offers.includes(pick)) {
      const other = this.offers.find((t) => t !== pick);
      if (other) throw new RefundRouteUnavailable(`Mayan: no route refunding ${pick} quoted now`, other);
      throw new Error("mayan: no quote");
    }
    return { ...(await super.quote(req)), refundTarget: pick };
  }
}

let h: Harness;
let mayan: FlipAdapter;
beforeEach(async () => {
  mayan = new FlipAdapter();
  h = await harness({ extraAdapters: [mayan] });
});
afterEach(async () => {
  await h.close();
});
const committed = async (expected: Target = "escrow") => {
  mayan.better = expected;
  const c = await h.post("/v1/operations", orderBody({ provider: "mayan" }));
  expect(c.status).toBe(200);
  expect(c.body.order.quote.refundTarget).toBe(expected);
  return { id: c.body.operationId as string, params: c.body.order.params as Record<string, unknown> };
};
const journaled = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  signedRestore({ ...swapRequest(), provider: "mayan", params, ...extra });
/** what the adapter was asked from here on */
const askedSince = () => {
  const from = mayan.asked.length;
  return () => mayan.asked.slice(from);
};
const AT_DESTINATION = /mayan's route now refunds a failure at the destination, not to the pool as the order was committed/;
const TO_POOL = /mayan's route now refunds a failure to the pool, not at the destination as the order was committed/;
const SAYS_NOTHING = /mayan's route no longer says where it would refund a failure/;

describe("F12-1: the committed refund target through a resume and a restore-prepare", () => {
  it("a resume naming the committed target rebuilds on it — the adapter asked for it, the order and the next prepare refund there — and its restore signature verifies with the field beside it", async () => {
    const { id, params } = await committed();
    mayan.better = "destination"; // Mayan's Fast-MCTP now has the higher minimum
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
    expect(r.body.order.quote.refundTarget).toBe("escrow");
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(200);
    expect(p.body.quote.refundTarget).toBe("escrow");
  });

  it("a resume naming none (an older wallet) keeps the target this service recorded at the commit", async () => {
    const { id, params } = await committed();
    mayan.better = "destination";
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params));
    expect(r.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
    expect(r.body.order.quote.refundTarget).toBe("escrow");
  });

  it("the wallet's target comes before the blob's: a blob a restore naming none rebuilt elsewhere is rebuilt on the wallet's again", async () => {
    const { id, params } = await committed();
    mayan.better = "destination";
    // a restore naming none (an older wallet's, holding no operation id) is rebuilt on any route: the blob now refunds at the destination
    const flipped = await h.post("/v1/operations", journaled(params));
    expect(flipped.status).toBe(200);
    expect(flipped.body.operationId).toBe(id);
    expect(flipped.body.order.quote.refundTarget).toBe("destination");
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
    expect(r.body.order.quote.refundTarget).toBe("escrow");
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(200);
    expect(p.body.quote.refundTarget).toBe("escrow");
  });

  it("a re-sign after the finalize brings the target in its restore: the prepare refunds there", async () => {
    const { id, params } = await committed();
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
    mayan.better = "destination";
    const again = await h.post(`/v1/operations/${id}/prepare`, { restore: journaled(params, { refundTarget: "escrow" }) });
    expect(again.status).toBe(200);
    expect(again.body.quote.refundTarget).toBe("escrow");
  });

  it("a provider that answers its other route whatever it is asked (LI.FI's facets) is its answer of the moment, either way: 502, tried again, the order as committed kept — rebuilt once its route answers", async () => {
    const { id, params } = await committed();
    const before = h.store.blob(id);
    mayan.better = "destination";
    mayan.stubborn = true;
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(AT_DESTINATION) });
    expect(h.store.blob(id), "the blob as committed").toEqual(before);
    mayan.stubborn = false; // its next answer is the committed route: never stopped for good on one answer (ZC's critique)
    const next = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(next.status).toBe(200);
    expect(next.body.order.quote.refundTarget).toBe("escrow");
    // an order committed refunding at the destination, the provider answering its route to the pool
    const other = await committed("destination");
    const kept = h.store.blob(other.id);
    mayan.better = "escrow";
    mayan.stubborn = true;
    const back = await h.post(`/v1/operations/${other.id}/resume`, journaled(other.params, { refundTarget: "destination" }));
    expect(back.status).toBe(502);
    expect(back.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(TO_POOL) });
    expect(h.store.blob(other.id)).toEqual(kept);
  });

  it("a quote that does not say where it refunds, where a target is bound, is refused as one of another type: 502, never stored for the next prepare to bind nothing", async () => {
    const { id, params } = await committed();
    const before = h.store.blob(id);
    mayan.namesNone = true;
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(SAYS_NOTHING) });
    expect(h.store.blob(id)).toEqual(before);
  });

  it("Mayan quoting no Swift route now, its Fast-MCTP one still: its own refusal answers refund_route_unavailable, asked once — the order as committed kept", async () => {
    const { id, params } = await committed();
    const before = h.store.blob(id);
    mayan.offers = ["destination"];
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("refund_route_unavailable");
    expect(r.body.error).toMatch(AT_DESTINATION);
    expect(asked(), "never asked again unbound").toEqual(["escrow"]);
    expect(h.store.blob(id)).toEqual(before);
  });

  it("its refusals are the provider's answers, never an outage: its breaker stays closed, and the route rebuilds once Swift is quoted again", async () => {
    const { id, params } = await committed();
    mayan.offers = ["destination"];
    for (let i = 0; i < 4; i++)
      expect((await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }))).body.code).toBe("refund_route_unavailable");
    mayan.offers = ["escrow", "destination"];
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(200);
    expect(r.body.order.quote.refundTarget).toBe("escrow");
  });

  it("one failure of the bound ask is an outage, not a route refunding elsewhere: no quote, asked once — Swift still quoted, its Fast-MCTP better", async () => {
    const { id, params } = await committed();
    const before = h.store.blob(id);
    mayan.better = "destination";
    mayan.failOnce = true;
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("no_quote");
    expect(asked()).toEqual(["escrow"]);
    expect(h.store.blob(id)).toEqual(before);
  });

  it("both ways: an order committed refunding at the destination is rebuilt there while its route quotes, never on one refunding to the pool", async () => {
    const { id, params } = await committed("destination");
    mayan.better = "escrow"; // Swift is better now; Fast-MCTP still quotes
    const asked = askedSince();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "destination" }));
    expect(r.status).toBe(200);
    expect(asked()).toEqual(["destination"]);
    expect(r.body.order.quote.refundTarget).toBe("destination");
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(200);
    expect(p.body.quote.refundTarget).toBe("destination");
    // Fast-MCTP gone: a Swift rebuild would refund to the escrow, which the wallet's tracker, reading its journaled quote, reads as paid at the destination
    const before = h.store.blob(id);
    mayan.offers = ["escrow"];
    const gone = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "destination" }));
    expect(gone.status).toBe(400);
    expect(gone.body.code).toBe("refund_route_unavailable");
    expect(gone.body.error).toMatch(TO_POOL);
    expect(h.store.blob(id)).toEqual(before);
    // and a resume naming none binds the blob's destination too
    const older = await h.post(`/v1/operations/${id}/resume`, journaled(params));
    expect(older.body.code).toBe("refund_route_unavailable");
  });

  it("a provider that quotes nothing at all is an outage, as before, either way: no quote, retried later — the order as committed kept", async () => {
    for (const target of ["escrow", "destination"] as const) {
      mayan.down = false;
      const { id, params } = await committed(target);
      const before = h.store.blob(id);
      mayan.down = true;
      const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: target }));
      expect(r.status, target).toBe(400);
      expect(r.body.code, target).toBe("no_quote");
      expect(r.body.error).toMatch(/no quote from mayan right now/);
      expect(h.store.blob(id)).toEqual(before);
    }
  });

  it("a target this service does not know is refused", async () => {
    const { id, params } = await committed();
    const r = await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "elsewhere" }));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/refundTarget must be escrow or destination/);
  });
});

describe("F12-1 (ZB, ZC): the prepare on a standing blob answers as a rebuild does", () => {
  it("Mayan quoting none of the committed type now: refund_route_unavailable, never the 502 a delayed funding's check had funded the order on", async () => {
    const { id } = await committed();
    mayan.offers = ["destination"];
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(400);
    expect(p.body.code).toBe("refund_route_unavailable");
    expect(p.body.error).toMatch(AT_DESTINATION);
  });

  it("a provider answering its other route at the prepare, either way, or a quote saying nothing of it: the provider's failure, 502, in words that never name the escrow", async () => {
    const one = await committed();
    mayan.stubborn = true;
    mayan.better = "destination";
    const p = await h.post(`/v1/operations/${one.id}/prepare`, {});
    expect(p.status).toBe(502);
    expect(p.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(AT_DESTINATION) });
    mayan.stubborn = false;
    const two = await committed("destination");
    mayan.stubborn = true;
    mayan.better = "escrow";
    const q = await h.post(`/v1/operations/${two.id}/prepare`, {});
    expect(q.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(TO_POOL) });
    mayan.stubborn = false;
    const three = await committed();
    mayan.namesNone = true;
    const n = await h.post(`/v1/operations/${three.id}/prepare`, {});
    expect(n.body).toMatchObject({ code: "provider_unavailable", error: expect.stringMatching(SAYS_NOTHING) });
    for (const answer of [p, q, n]) expect(String(answer.body.error)).not.toMatch(/escrow/);
  });

  it("an outage at the prepare stays the provider's failure: 502 provider_unavailable", async () => {
    const { id } = await committed();
    mayan.down = true;
    const p = await h.post(`/v1/operations/${id}/prepare`, {});
    expect(p.status).toBe(502);
    expect(p.body.code).toBe("provider_unavailable");
  });
});

describe("F12-1 (ZB, ZC): another provider's route is never this order's", () => {
  it("during a Mayan outage, another provider refusing the escrow, or quoting a route refunding at the destination whatever it is asked, leaves Mayan's escrow-committed order an outage: no quote", async () => {
    for (const stubborn of [false, true]) {
      const other = new FlipAdapter("lifi");
      other.offers = ["destination"]; // asked for the escrow: its own refusal, or (stubborn) a route refunding at the destination
      other.stubborn = stubborn;
      const own = new FlipAdapter();
      const h2 = await harness({ extraAdapters: [own, other] });
      try {
        const c = await h2.post("/v1/operations", orderBody({ provider: "mayan" }));
        expect(c.status).toBe(200);
        own.down = true;
        const r = await h2.post(
          `/v1/operations/${c.body.operationId}/resume`,
          signedRestore({ ...swapRequest(), provider: "mayan", params: c.body.order.params, refundTarget: "escrow" }),
        );
        expect(other.asked.at(-1), "the other provider asked for the escrow").toBe("escrow");
        expect(r.status, `stubborn: ${stubborn}`).toBe(400);
        expect(r.body.code, `stubborn: ${stubborn}`).toBe("no_quote");
      } finally {
        await h2.close();
      }
    }
  });
});

describe("F12-1 (ZD): the target on every route the wallet sends it on, and the blob's where the wallet names none", () => {
  it("a restore (POST /v1/operations with params, a resume's fallback) naming the target rebuilds on it: Mayan asked for it, the same operation", async () => {
    const { id, params } = await committed();
    mayan.better = "destination";
    const asked = askedSince();
    const r = await h.post("/v1/operations", journaled(params, { refundTarget: "escrow" }));
    expect(r.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
    expect(r.body.operationId).toBe(id);
    expect(r.body.order.quote.refundTarget).toBe("escrow");
  });

  it("a quote set asked with the target (the campaign's requote) asks Mayan for it", async () => {
    mayan.better = "destination";
    const asked = askedSince();
    const q = await h.post("/v1/quotes", { ...swapRequest(), refundTarget: "escrow" });
    expect(q.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
  });

  it("a resume naming none binds the blob's target for a provider's other route, or a quote naming none, too: 502, the blob as committed", async () => {
    for (const flip of ["stubborn", "namesNone"] as const) {
      mayan.stubborn = false;
      mayan.namesNone = false;
      const { id, params } = await committed();
      const before = h.store.blob(id);
      mayan.better = "destination";
      mayan[flip] = true;
      const r = await h.post(`/v1/operations/${id}/resume`, journaled(params));
      expect(r.status, flip).toBe(502);
      expect(r.body.code, flip).toBe("provider_unavailable");
      expect(h.store.blob(id), flip).toEqual(before);
    }
  });

  it("a rebuilt order's request carries no target, as a committed one: the price guard's competition at the next prepare asks unbound, before the bound re-quote", async () => {
    const { id, params } = await committed();
    expect((await h.post(`/v1/operations/${id}/resume`, journaled(params, { refundTarget: "escrow" }))).status).toBe(200);
    const stored = decodeBlob<{ order: { request: Record<string, unknown> } }>(h.store.blob(id)!);
    expect("refundTarget" in stored.order.request).toBe(false);
    const asked = askedSince();
    expect((await h.post(`/v1/operations/${id}/prepare`, {})).status).toBe(200);
    expect(asked()).toEqual([undefined, "escrow"]);
    // and a commit that asked for it
    const c = await h.post("/v1/operations", orderBody({ provider: "mayan", refundTarget: "escrow" }));
    const next = askedSince();
    expect((await h.post(`/v1/operations/${c.body.operationId}/prepare`, {})).status).toBe(200);
    expect(next()).toEqual([undefined, "escrow"]);
  });
});

describe("F12-2: a commit naming the reviewed refund target", () => {
  it("asks the provider for that route type: a route reviewed refunding to the escrow is committed so, Fast-MCTP better or not", async () => {
    mayan.better = "destination";
    const asked = askedSince();
    const c = await h.post("/v1/operations", orderBody({ provider: "mayan", refundTarget: "escrow" }));
    expect(c.status).toBe(200);
    expect(asked()).toEqual(["escrow"]);
    expect(c.body.order.quote.refundTarget).toBe("escrow");
  });

  it("the order is built on the request without it, as a rebuilt one is (ZC's critique: kept, it had bound the price guard's competition at every prepare)", async () => {
    const c = await h.post("/v1/operations", orderBody({ provider: "mayan", refundTarget: "escrow" }));
    const stored = decodeBlob<{ order: { request: { refundTarget?: string }; quote: { refundTarget?: string } } }>(h.store.blob(c.body.operationId)!);
    expect(stored.order.quote.refundTarget, "the committed route's target, in its quote").toBe("escrow");
    expect("refundTarget" in stored.order.request).toBe(false);
  });
});
