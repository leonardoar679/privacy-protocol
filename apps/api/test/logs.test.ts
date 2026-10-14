// The log gate (doc §67; spec v2.0 §15, §19): through a whole flow — a quote, a commit, the prepare, the finalize, the
// reconciles, a refusal of every kind (404, 413, 415, 429, a bad request, a 500) — every line the API writes is JSON whose
// keys are a subset of the eight, and no line holds an address, a transaction hash, an amount, a Bitcoin or a Solana
// string, the destination or the refund secret; the system_events rows say the same; and apps/api/src calls no console.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOG_KEYS } from "@privacy-wallet/server-kit";
import { DEST, REFUND_SECRET, harness, orderBody, sign, swapRequest } from "./helpers";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const LEAKS: [string, RegExp][] = [
  ["an address", /0x[0-9a-fA-F]{40}/],
  ["a hash", /0x[0-9a-fA-F]{64}/],
  ["an amount", /\b\d{6,}\b/],
  ["a Bitcoin string", /\b(bc1|tb1)[02-9ac-hj-np-z]{20,}/i],
  ["a base58 string", /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/],
];

describe("the log gate", () => {
  it("every line of a whole flow is JSON with known keys and nothing that identifies money or a person", async () => {
    const h = await harness({ ratePerMinute: 30 });
    try {
      await h.post("/v1/quotes", swapRequest());
      const c = await h.post("/v1/operations", orderBody());
      const id = c.body.operationId as string;
      const p = await h.post(`/v1/operations/${id}/prepare`, {});
      await h.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) });
      h.script.job = { state: "executed", executionTx: "0x" + "e1".repeat(32), actualNetworkWei: (10n ** 17n).toString() };
      h.clock.now += 6_000;
      await h.post(`/v1/operations/${id}/reconcile`, {});
      h.script.job = { state: "completed", executionTx: "0x" + "e1".repeat(32) };
      h.adapter.track_ = { state: "completed" };
      h.clock.now += 6_000;
      await h.post(`/v1/operations/${id}/reconcile`, {});
      await h.get(`/v1/operations/${c.body.order.orderId}`);
      await h.post("/v1/quotes", { ...swapRequest(), padding: "x".repeat(70_000) });
      await h.post("/v1/quotes", "a=1", { "content-type": "text/plain" });
      await h.post("/v1/operations", { ...orderBody(), refundNoteSecret: "not a number" });
      h.adapter.quote = async () => {
        throw new Error(`provider exploded near ${DEST} with 0x${"ab".repeat(20)}`);
      };
      const crashed = await h.post("/v1/operations", orderBody());
      expect(crashed.status).toBeGreaterThanOrEqual(400);
      for (let i = 0; i < 40; i++) await h.get("/v1/assets");
      expect(h.lines.length).toBeGreaterThan(5);
      const events = new Set<string>();
      for (const line of h.lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        for (const k of Object.keys(parsed)) expect(LOG_KEYS, `${k} in ${line}`).toContain(k);
        for (const [what, re] of LEAKS) expect(line, `${what} in ${line}`).not.toMatch(re);
        expect(line).not.toContain(DEST);
        expect(line).not.toContain(REFUND_SECRET);
        events.add(String(parsed.event));
      }
      expect([...events].sort()).toEqual(
        expect.arrayContaining(["fee.deviation", "operation.created", "operation.finalized", "operation.reconciled", "rate.limited"]),
      );
      const rows = JSON.stringify(h.store.db.prepare("SELECT * FROM system_events").all());
      for (const [what, re] of LEAKS.filter(([w]) => w !== "an amount")) expect(rows, what).not.toMatch(re);
      expect(rows).not.toContain(DEST);
    } finally {
      await h.close();
    }
  });
  it("apps/api/src writes nothing but through the typed logger: no console", () => {
    for (const f of files(SRC)) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bconsole\./);
  });
});
