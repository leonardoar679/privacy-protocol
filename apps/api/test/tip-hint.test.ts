// The commit's tip hint. The seventh review round (2026-11-03): a commit is built on the executor tip the wallet's Review showed —
// a fresh price had paid the escrow up to three times what the Review said. The eighth review round (H1): the commit prices the tip
// all the same, and the shown one is kept only between half of today's price and the price: below half the API answers 409
// tip_moved, above it builds on today's, and the price's own refusals stand. A shown tip had replaced the price outright, so any
// caller got a vouched order at a 1-wei tip — one the relayer then ran and refunded at its own cost.
import { describe, expect, it } from "vitest";
import { TipError } from "@privacy-wallet/swap-engine/tips";
import { TIP, harness, orderBody, swapRequest } from "./helpers";

describe("the commit's tip hint", () => {
  it("keeps a shown tip between half of today's price and the price; above it, today's; zero, negative or not a number is no hint", async () => {
    const h = await harness({ vouchKey: `0x${"11".repeat(32)}` });
    try {
      await h.post("/v1/quotes", swapRequest());
      for (const shown of [TIP / 2n, TIP - 1n, TIP]) {
        const built = await h.post("/v1/operations", orderBody({ executorTip: shown.toString() }));
        expect(built.status, String(shown)).toBe(200);
        expect(String(built.body.order.params.executorTip), String(shown)).toBe(shown.toString());
        expect(built.body.vouch?.order, "vouched: the service valued this tip").toBeTruthy();
      }
      for (const bad of [(TIP + 1n).toString(), (10n ** 17n).toString(), "0", "-1", "abc"]) {
        const r = await h.post("/v1/operations", orderBody({ executorTip: bad }));
        expect(r.status, bad).toBe(200);
        expect(String(r.body.order.params.executorTip), bad).toBe(TIP.toString());
      }
    } finally {
      await h.close();
    }
  });

  it("refuses a shown tip below half of today's price with 409 tip_moved: no order, no vouch", async () => {
    const h = await harness({ vouchKey: `0x${"11".repeat(32)}` });
    try {
      for (const shown of ["1", (TIP / 2n - 1n).toString(), "123456789"]) {
        const r = await h.post("/v1/operations", orderBody({ executorTip: shown }));
        expect(r.status, shown).toBe(409);
        expect(r.body.code, shown).toBe("tip_moved");
        expect(r.body.vouch, shown).toBeUndefined();
        expect(r.body.order, shown).toBeUndefined();
      }
    } finally {
      await h.close();
    }
  });

  it("a shown tip never skips the price's refusals: an amount too small or an unpriced token is refused with or without one", async () => {
    for (const code of ["amount_too_small", "tip_unpriced"] as const) {
      const h = await harness({
        tipFor: async () => {
          throw new TipError(code, `the tip cannot be paid (${code})`);
        },
      });
      try {
        for (const hint of [undefined, "1"]) {
          const r = await h.post("/v1/operations", orderBody(hint ? { executorTip: hint } : {}));
          expect(r.status, `${code} ${hint}`).toBe(400);
          expect(r.body.code, `${code} ${hint}`).toBe(code);
        }
      } finally {
        await h.close();
      }
    }
  });
});
