// The seventh review round (2026-11-03): a commit is built on the executor tip the wallet's Review showed — never priced again at the
// commit, where a fresh price had paid the escrow up to three times what the Review said — at most the escrow's 1 % of the amount; any
// other value is no hint (the wallet refuses an order whose tip is above the one it showed).
import { describe, expect, it } from "vitest";
import { TIP, harness, orderBody, swapRequest } from "./helpers";

describe("the commit's tip hint", () => {
  it("builds the order on the tip the Review showed; a hint above 1 %, zero or not a number is no hint", async () => {
    const h = await harness();
    try {
      await h.post("/v1/quotes", swapRequest());
      const built = await h.post("/v1/operations", orderBody({ executorTip: "123456789" }));
      expect(built.status).toBe(200);
      expect(String(built.body.order.params.executorTip)).toBe("123456789");
      for (const bad of [(10n ** 17n).toString(), "0", "-1", "abc"]) {
        const r = await h.post("/v1/operations", orderBody({ executorTip: bad }));
        expect(r.status, bad).toBe(200);
        expect(String(r.body.order.params.executorTip), bad).toBe(TIP.toString());
      }
    } finally {
      await h.close();
    }
  });
});
