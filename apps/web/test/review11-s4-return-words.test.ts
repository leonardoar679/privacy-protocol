// The eleventh review round's critique of E11-10 (2026-11-05): Return funds, Start refund and Cancel before it is funded say what happened in
// their own words. A relayer that did not answer had read as the catalog's "The transaction was secured and ready, but the relayer did not
// answer. The wallet checks the chain…" — a return secures no transaction and nothing looks for one; a return the wallet cannot make itself (a
// wallet set to send its own transactions, a relayer that closed the order's job, a record without the refund's payload) had fallen to "try
// again in a moment", and a retry never succeeds; a funding already sent, or on its way, is said as such.
import { describe, expect, it } from "vitest";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { ApiError } from "@privacy-wallet/sdk/api/client";
import { RelayerRefusal, RelayerTimeout } from "@privacy-wallet/sdk/relayer";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { FundingAlreadySent, FundingUnderWay } from "@privacy-wallet/sdk/swapFunding";
import { RefundRefusal, returnOrderToBalance } from "@privacy-wallet/sdk/swapExecute";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { errorWords, returnFundsWords } from "../src/features/operations/errorWords";
import { deployment } from "./helpers/swapWorld";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { t } from "../src/app/i18n/messages";
import { en } from "../src/app/i18n/en";

const words = (e: unknown, advanced = false, fallback?: Parameters<typeof returnFundsWords>[3]) =>
  returnFundsWords((k, v) => t(k, v), e, advanced, fallback);

describe("the catalog's words a one-line message shows (the eleventh review round's second critique of slice 4)", () => {
  it("every reason names its subject — a line that shows the reason alone had read 'It holds too many open orders'", () => {
    for (const [k, v] of Object.entries(en)) if (/^op\.error\..*\.reason$/.test(k)) expect(v, k).not.toMatch(/^It /);
    expect(en["op.error.service_capacity.reason"]).toMatch(/^The swap service holds too many open orders/);
    expect(en["op.error.capacity.reason"]).toMatch(/^The relayer has too many open swap jobs/);
  });

  it("a delayed swap asks the reader to open and unlock the wallet at the drawn time — keeping it open does not keep it unlocked", () => {
    expect(en["screen.swap.fundingAt"]).toContain("so open and unlock it then");
    expect(en["screen.swap.fundingAt"]).not.toContain("keep it open");
  });

  it("a private transfer's lines say what is public, as Receive's does — never 'nothing is public'", () => {
    for (const k of ["screen.send.private", "review.amountFixedPrivate"] as const) expect(en[k], k).not.toMatch(/nothing (about this transfer )?is public/i);
    expect(en["screen.send.private"]).toContain("only that a transfer took place, when, and the account that submitted it are public");
  });
});

describe("Return funds' words (the eleventh review round's critique of E11-10)", () => {
  it("a relayer that did not answer: nothing was returned yet — never the catalog's secured transaction looked for on chain", () => {
    for (const e of [new TypeError("Failed to fetch"), new RelayerTimeout(30_000)]) {
      expect(classify(e).code).toBe("relayer_unreachable");
      expect(words(e)).toBe(en["screen.swap.returnNoAnswer"]);
      expect(words(e, false, "screen.swap.cancelFailed"), "the cancel too").toBe(en["screen.swap.returnNoAnswer"]);
      expect(words(e)).not.toContain("secured");
    }
    expect(words(new TypeError("Failed to fetch"), true), "under Advanced, the thrown text after the words").toBe(`${en["screen.swap.returnNoAnswer"]} (Failed to fetch)`);
  });

  it("a relayer that could not take the return now — a 5xx (a proxy's while it restarts), its own failure, a rate limit, its capacity —: nothing returned yet, never another step's words (the second critique)", () => {
    for (const e of [
      new RelayerRefusal("relayer: <html>502 Bad Gateway</html>", undefined, 502),
      new RelayerRefusal("relayer: internal error (internal)", "internal", 500),
      new RelayerRefusal("too many requests", undefined, 429),
      new RelayerRefusal("full", undefined, 503),
    ]) {
      expect(words(e), e.message).toBe(en["screen.swap.returnNoAnswer"]);
      expect(words(e)).not.toMatch(/Nothing left your protected balance|operation's history|checks where your funds are|confirm again/);
    }
  });

  it("a relayer that runs no swaps (a coded 503): the return's own words — the way to a relayer that runs swaps —, never 'try again in a moment' (the third critique and its fourth pass)", () => {
    const e = new RelayerRefusal("the relayer at http://relayer.test runs no swap executor", "swap_unavailable", 503);
    expect(words(e)).toBe(en["screen.swap.returnNoSwaps"]);
    expect(words(e)).toContain("choose a relayer that runs swaps under Advanced → Submission of private transactions");
    expect(words(e)).not.toMatch(/try again in a moment|Nothing was executed/);
  });

  it("a relayer that refused the return: refused, its funds held for the swap — never 'confirm again or return them', never 'Nothing left your protected balance' (the second critique)", () => {
    for (const e of [
      new RelayerRefusal("the committed refund payload is unreadable", "bad_refund_payload", 400),
      new RelayerRefusal("the order differs", "order_mismatch", 400),
      new RelayerRefusal("a refusal this wallet has no row for", "something_new", 400),
    ]) {
      expect(words(e), e.message).toBe(en["screen.swap.returnRefused"]);
      expect(words(e)).not.toMatch(/confirm again|return them|Nothing left your protected balance|operation's history|try again/);
    }
    expect(words(new RelayerRefusal("the committed refund payload is unreadable", "bad_refund_payload", 400), true), "under Advanced, the relayer's own text after them").toBe(
      `${en["screen.swap.returnRefused"]} (the committed refund payload is unreadable)`,
    );
  });

  it("a relayer that keeps the order's job completed: refused with its code before anything is patched (refund_not_watched)", async () => {
    const submission = settings.get().submission;
    if (submission.kind !== "relayer") throw new Error("the default submission is the relayer's");
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname.endsWith("/swap/refund")
        ? new Response(JSON.stringify({ id: "j", state: "completed" }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 })) as typeof fetch;
    try {
      const stored = { orderId: "0x01", params: { refundAfter: 1_800_000_000 }, refundNoteData: "0x00" } as unknown as StoredSwap;
      await expect(returnOrderToBalance({ deployment, stored, submission })).rejects.toMatchObject({ name: "RefundRefusal", code: "refund_not_watched" });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("before the commit, a service's own failure, a rate limit and a route filtered at the commit read as the caller's words (the second critique)", () => {
    for (const e of [new ApiError(500, "internal", "internal error"), new ApiError(429, "rate_limited", "slow down"), new ApiError(400, "route_filtered", "filtered")]) {
      expect(errorWords((k, v) => t(k, v), e, { advanced: false, fallback: "screen.swap.quoteFailed", beforeCommit: true }), e.message).toBe(en["screen.swap.quoteFailed"]);
      expect(errorWords((k, v) => t(k, v), e, { advanced: false, fallback: "screen.swap.notConfirmed", beforeCommit: true })).toBe(en["screen.swap.notConfirmed"]);
    }
  });

  it("a return the wallet cannot make itself: its code's words, which say what to do — never 'try again in a moment'", () => {
    for (const code of ["refund_needs_relayer", "refund_not_watched", "refund_payload_missing"] as const) {
      const e = new RefundRefusal("the runner's English", code);
      expect(classify(e).code).toBe(code);
      expect(words(e)).toBe(en[`op.error.${code}.reason`]);
      expect(words(e)).not.toMatch(/try again in a moment/);
    }
    // a path that exists in Simple too (the second critique: Simple's Settings has no Advanced row until the experience is Advanced)
    expect(en["op.error.refund_needs_relayer.reason"]).toContain("In Settings, set Experience to Advanced");
    expect(en["op.error.refund_needs_relayer.reason"]).toContain("Advanced → Submission of private transactions");
  });

  it("the wallet's own return under connected-wallet submission is refused with its code, before anything is asked of anyone", async () => {
    const stored = { orderId: "0x01", params: { refundAfter: 1_800_000_000 }, refundNoteData: "0x00" } as unknown as StoredSwap;
    await expect(returnOrderToBalance({ deployment: null, stored, submission: { kind: "wallet" } })).rejects.toMatchObject({
      name: "RefundRefusal",
      code: "refund_needs_relayer",
    });
    await expect(
      returnOrderToBalance({ deployment: null, stored: { ...stored, refundNoteData: undefined } as StoredSwap, submission: { kind: "relayer", url: "http://127.0.0.1:1" } }),
    ).rejects.toMatchObject({ code: "refund_payload_missing" });
  });

  it("a funding already sent, or on its way: said as such — never 'never landed', never 'still in your protected balance'", () => {
    const sent = words(new FundingAlreadySent("pending"), false, "screen.swap.cancelFailed");
    expect(sent).toBe(en["screen.swap.fundingAlreadySent"]);
    expect(words(new FundingUnderWay())).toBe(en["op.error.funding_under_way.reason"]);
    for (const w of [sent, words(new FundingUnderWay())]) expect(w).not.toMatch(/never landed|still in your protected balance/);
  });

  it("a failure the catalog has no code for: the caller's own words — the return's, or the cancel's", () => {
    expect(words(new Error("escrow read failed"))).toBe(en["screen.swap.returnFailed"]);
    expect(words(new Error("escrow read failed"), false, "screen.swap.cancelFailed")).toBe(en["screen.swap.cancelFailed"]);
  });

  it("in Korean: the no-answer words and a refusal's are the catalog's", async () => {
    await loadCatalog("ko");
    const ko = (e: unknown) => returnFundsWords((k, v) => t(k, v, "ko"), e, false);
    expect(ko(new TypeError("Failed to fetch"))).toBe(t("screen.swap.returnNoAnswer", undefined, "ko"));
    expect(ko(new RefundRefusal("x", "refund_needs_relayer"))).toBe(t("op.error.refund_needs_relayer.reason", undefined, "ko"));
    expect(ko(new TypeError("Failed to fetch"))).not.toMatch(/[A-Za-z]{4,}/);
  });
});
