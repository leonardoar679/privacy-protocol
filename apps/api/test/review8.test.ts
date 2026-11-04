// The eighth review round (2026-11-03): the swap service. What a finalized order leaves in the database file, the commits' capacity and
// each caller's budget, the stored order without the provider's raw answer, the API's state on the paths it had read against the wallet
// and the chain, a re-sign's prepare that a later one overtook, the edge's types, the reconcile throttle under concurrency, a newer
// schema refused, the registry's assets, a Base route's record, the stall floor and the price guard that never runs unguarded.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STALL_FLOOR_SECONDS } from "@privacy-wallet/protocol/wallet/campaign";
import type { Capabilities, Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";
import { riskDb } from "@privacy-wallet/swap-engine/risk/riskDb";
import { MIGRATIONS, SchemaTooNew, migrate, openDb } from "../src/db";
import { stateFrom } from "../src/reconcile";
import { DEST, ORDER_SIGNER, REFUND_SECRET, StubAdapter, harness, orderBody, sign, signedRestore, swapRequest, type Harness } from "./helpers";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** An operation committed, prepared and finalized. */
async function finalized(x: Harness, over: Record<string, unknown> = {}): Promise<{ id: string; body: Record<string, any> }> {
  const c = await x.post("/v1/operations", orderBody(over));
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const id = c.body.operationId as string;
  const p = await x.post(`/v1/operations/${id}/prepare`, {});
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  expect((await x.post(`/v1/operations/${id}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
  return { id, body: c.body };
}

describe("a finalized order leaves nothing of its destination, refund material or signer in the database file (A-M1)", () => {
  it("after finalize and after the purge, neither the file nor its WAL holds them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "api-at-rest-"));
    const file = join(dir, "api.sqlite");
    try {
      h = await harness({ dbPath: file });
      const markers = { destination: DEST, refundNoteSecret: REFUND_SECRET, orderSigner: ORDER_SIGNER.toLowerCase().slice(2) };
      const found = () => {
        const out: string[] = [];
        for (const f of [file, `${file}-wal`]) {
          if (!existsSync(f)) continue;
          const text = readFileSync(f).toString("latin1").toLowerCase();
          for (const [k, v] of Object.entries(markers)) if (text.includes(v.toLowerCase())) out.push(`${k} in ${f.endsWith("-wal") ? "the WAL" : "the file"}`);
        }
        return out;
      };
      const c = await h.post("/v1/operations", orderBody());
      expect(found(), "the blob is there before finalize: the scan sees it").not.toEqual([]);
      const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
      expect((await h.post(`/v1/operations/${c.body.operationId}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
      expect(found(), "after finalize").toEqual([]);
      h.store.updateState(c.body.operationId, { state: "COMPLETED", settlement: null });
      h.clock.now += 8 * 86_400_000;
      expect(h.store.purge().operations).toBe(1);
      expect(found(), "after the purge").toEqual([]);
    } finally {
      await h?.close();
      (h?.store as unknown as { db?: { close(): void } } | undefined)?.db?.close(); // Windows removes no open file
      h = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the commits are bounded and the stored order is slim (A-M2)", () => {
  it("past MAX_OPEN_OPERATIONS a commit is refused with 503 service_capacity, nothing stored", async () => {
    h = await harness({ maxOpenOperations: 2 });
    expect((await h.post("/v1/operations", orderBody())).status).toBe(200);
    expect((await h.post("/v1/operations", orderBody())).status).toBe(200);
    const third = await h.post("/v1/operations", orderBody());
    expect(third.status).toBe(503);
    expect(third.body.code).toBe("service_capacity");
    expect(h.store.openOperations()).toBe(2);
  });

  it("a caller's commits have their own budget: past it, 429 rate_limited with Retry-After", async () => {
    h = await harness({ commitsPerMinute: 1, commitBurst: 2 });
    expect((await h.post("/v1/operations", orderBody())).status).toBe(200);
    expect((await h.post("/v1/operations", orderBody())).status).toBe(200);
    const third = await h.post("/v1/operations", orderBody());
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.post("/v1/quotes", swapRequest())).status, "quotes are not commits").toBe(200);
  });

  it("the blob keeps neither the provider's raw answer nor its hops", async () => {
    class Verbose extends StubAdapter {
      async quote(req: QuoteRequest): Promise<Quote> {
        return { ...(await super.quote(req)), raw: { answer: "x".repeat(14_000) }, hops: ["one", "two"] };
      }
    }
    h = await harness({ extraAdapters: [new Verbose("chainflip")] });
    const c = await h.post("/v1/operations", orderBody({ provider: "chainflip" }));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const blob = h.store.blob(c.body.operationId)!;
    expect(blob).not.toContain("xxxxxxxx");
    expect(blob.length).toBeLessThan(6_000);
    const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
    expect(p.status).toBe(200);
    expect(h.store.blob(c.body.operationId)!, "nor after its prepare").not.toContain("xxxxxxxx");
  });
});

describe("the API's state agrees with the wallet and the chain (A-L1)", () => {
  const row = { state: "SOURCE_CONFIRMING" as const, executeDeadline: 1_000, refundAfter: 2_000, amount: "100" };
  it("an executed job whose rest came back is a partial delivery, never refunded in full", () => {
    const job = { state: "refunded" as const, executed: true };
    expect(stateFrom(row, job, { state: "partial" }, false, 500)).toEqual({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
    expect(stateFrom(row, job, { state: "completed" }, false, 500)).toEqual({ state: "RECOVERY_REQUIRED", code: "partial_delivery" });
    expect(stateFrom(row, job, { state: "refunded" }, false, 500), "nothing delivered").toEqual({ state: "REFUNDED" });
    expect(stateFrom(row, job, null, false, 500), "the provider unread: nothing final").toEqual({ state: "REFUNDING" });
    expect(stateFrom(row, { state: "refunded" }, null, false, 500), "never executed").toEqual({ state: "REFUNDED" });
  });
  it("an empty escrow that is deployed was executed (finalized here) or refunded: never a reorg", () => {
    expect(stateFrom(row, null, null, false, 500, false, true, { finalized: true, deployed: true })).toEqual({ state: "PROVIDER_EXECUTING" });
    expect(stateFrom(row, null, null, false, 500, false, true, { finalized: false, deployed: true })).toEqual({ state: "REFUNDING" });
    expect(stateFrom(row, null, null, false, 500, false, true, { deployed: false }), "undeployed: the funding pending again").toEqual({
      state: "SOURCE_CONFIRMING",
    });
  });
  it("an order this API finalized is never closed as one that moved nothing", () => {
    const pre = { ...row, state: "AWAITING_AUTHORIZATION" as const };
    expect(stateFrom(pre, null, null, false, 3_000, false, true, { finalized: false, deployed: false })).toEqual({
      state: "CANCELLED",
      code: "order_expired",
    });
    expect(stateFrom(pre, null, null, false, 3_000, false, true, { finalized: true, deployed: false })).toEqual({
      state: "RECOVERY_REQUIRED",
      code: "order_expired",
    });
    expect(stateFrom(pre, null, null, false, 3_000, false, true, { finalized: true, deployed: true })).toEqual({ state: "PROVIDER_EXECUTING" });
  });
  it("the reconcile reads the escrow's code only with no job and an empty escrow, and reads the relayer's executed flag", async () => {
    h = await harness();
    const { id } = await finalized(h);
    let codeReads = 0;
    h.deps.reads.deployed = async () => {
      codeReads++;
      return true;
    };
    h.script.job = "none";
    h.script.balance = 0n;
    const r = await h.post(`/v1/operations/${id}/reconcile`, {});
    expect(r.body.state, "executed through another relayer").toBe("PROVIDER_EXECUTING");
    expect(codeReads).toBe(1);
  });
  it("a reconcile that ends an order drops its blob", async () => {
    h = await harness();
    const c = await h.post("/v1/operations", orderBody());
    expect(h.store.blob(c.body.operationId)).not.toBeNull();
    h.store.updateState(c.body.operationId, { state: "CANCELLED", settlement: null });
    expect(h.store.blob(c.body.operationId)).toBeNull();
  });
});

describe("a re-sign's prepare overtaken by a later one writes nothing (A-L2)", () => {
  it("the blob is written only while the finalize it started from stands: 409 prepare_superseded", async () => {
    h = await harness();
    const { id, body } = await finalized(h);
    const journaled = signedRestore({ ...swapRequest(), provider: "thorchain", params: body.order.params });
    // the first re-sign is held inside the provider's quote while a second one prepares and finalizes
    const quote = h.adapter.quote.bind(h.adapter);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.adapter.quote = async (req) => {
      if (++calls === 1) await gate;
      return quote(req);
    };
    const slow = h.post(`/v1/operations/${id}/prepare`, { restore: journaled });
    await new Promise((r) => setTimeout(r, 50));
    const fast = await h.post(`/v1/operations/${id}/prepare`, { restore: journaled });
    expect(fast.status, JSON.stringify(fast.body)).toBe(200);
    h.clock.now += 1_000;
    expect((await h.post(`/v1/operations/${id}/finalize`, { signature: sign(fast.body.digest) })).status).toBe(200);
    release();
    const late = await slow;
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(late.body.code).toBe("prepare_superseded");
    expect(h.store.blob(id), "the finalized row keeps no blob").toBeNull();
  });
  it("store: written only with no blob, unended, and the same finalize", async () => {
    h = await harness();
    const { id } = await finalized(h);
    const at = h.store.execution(id)!.finalizedAt;
    expect(h.store.setRestoredBlob(id, "{}", at + 1), "another finalize").toBe(false);
    expect(h.store.setRestoredBlob(id, "{}", at)).toBe(true);
    expect(h.store.setRestoredBlob(id, "{}", at), "a blob is there").toBe(false);
  });
});

describe("the edge holds every number and name to its type (A-L3)", () => {
  it("an amount past uint256 is a 400; an approved minimum past uint256 is no minimum; a provider must be one of the service's", async () => {
    h = await harness();
    const huge = (1n << 256n).toString();
    for (const path of ["/v1/quotes", "/v1/operations"]) {
      const r = await h.post(path, orderBody({ amount: huge }));
      expect(r.status, path).toBe(400);
      expect(r.body.code, path).toBe("invalid_request");
    }
    expect((await h.post("/v1/operations", orderBody({ grossAmount: huge }))).status).toBe(400);
    for (const provider of [123, "nope", ""]) expect((await h.post("/v1/operations", orderBody({ provider }))).status, String(provider)).toBe(400);
    const c = await h.post("/v1/operations", orderBody());
    const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, { approvedMin: "9".repeat(60_000) });
    expect(p.status, "not a uint256: no minimum asked").toBe(200);
  });
});

describe("the reconcile throttle serves the read in flight (A-I1)", () => {
  it("concurrent reconciles of one operation read the relayer once", async () => {
    h = await harness();
    const { id } = await finalized(h);
    let reads = 0;
    const job = h.deps.reads.job;
    h.deps.reads.job = async (orderId) => {
      reads++;
      await new Promise((r) => setTimeout(r, 30));
      return job(orderId);
    };
    const answers = await Promise.all(Array.from({ length: 12 }, () => h!.post(`/v1/operations/${id}/reconcile`, {})));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("a database a newer build migrated is refused (A-I3)", () => {
  it("SchemaTooNew, nothing run", () => {
    const db = openDb(":memory:");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
    expect(() => migrate(db)).toThrow(SchemaTooNew);
    const again = openDb(":memory:");
    expect(() => migrate(again), "a current one: nothing to do").not.toThrow();
  });
});

describe("a wallet's request names the registry's assets (D-M2)", () => {
  it("an asset under another symbol or decimals, or one this service does not swap, is refused before any provider is asked", async () => {
    h = await harness();
    let asked = 0;
    const quote = h.adapter.quote.bind(h.adapter);
    h.adapter.quote = async (req) => {
      asked++;
      return quote(req);
    };
    const baseEth = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
    for (const to of [
      { ...baseEth, symbol: "USDC" },
      { ...baseEth, decimals: 17 },
      { chain: "bitcoin", asset: "native", decimals: 8, symbol: "ETH" },
      { chain: "ethereum", asset: "0x000000000000000000000000000000000000dead", decimals: 18, symbol: "DEAD" },
    ]) {
      const r = await h.post("/v1/quotes", swapRequest({ to }));
      expect(r.status, JSON.stringify(to)).toBe(400);
      expect(r.body.code, JSON.stringify(to)).toBe("asset_mismatch");
    }
    expect(asked, "no provider was asked").toBe(0);
    expect((await h.post("/v1/quotes", swapRequest())).status, "the registry's BTC").toBe(200);
  });
});

describe("a Base route's record is found (D-L1)", () => {
  it("the quote's route qualification reads the measured limit of ETH → ETH on Base", async () => {
    class BaseStub extends StubAdapter {
      capabilities(): Capabilities {
        return { ...super.capabilities(), chains: ["ethereum", "base"] };
      }
    }
    h = await harness({ extraAdapters: [new BaseStub("uniswap-across")] });
    const db = riskDb();
    const lookup = db.routeRisk.bind(db);
    const found: (number | undefined)[] = [];
    db.routeRisk = (pair: string, provider: string) => {
      const r = lookup(pair, provider);
      found.push(r?.servedUpToUsd);
      return r;
    };
    try {
      const r = await h.post(
        "/v1/quotes",
        swapRequest({ to: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" }, destination: "0x" + "ab".repeat(20) }),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(found, "the record of ETH → ETH (Base) on Across, under the lab's own key").toEqual([2_000_000]);
    } finally {
      db.routeRisk = lookup;
    }
  });
});

describe("a settlement stall is never read under the floor (D-L2)", () => {
  it("a route of seconds stalls only past ten minutes after the hand-over", async () => {
    class Fast extends StubAdapter {
      async quote(req: QuoteRequest): Promise<Quote> {
        return { ...(await super.quote(req)), etaSeconds: 8 };
      }
    }
    h = await harness({ extraAdapters: [new Fast("chainflip")] });
    const tx = "0x" + "f1".repeat(32);
    const { id } = await finalized(h, { provider: "chainflip" });
    expect(h.store.execution(id)!.expectedSeconds).toBe(8);
    h.script.job = { state: "executed", executionTx: tx };
    h.clock.now += 27_000; // a poll and a block
    expect((await h.get(`/v1/track/chainflip?tx=${tx}&operation=${id}`)).body.stalled).toBeUndefined();
    h.clock.now += STALL_FLOOR_SECONDS * 1000;
    expect((await h.get(`/v1/track/chainflip?tx=${tx}&operation=${id}`)).body.stalled).toBe(true);
  });
});

describe("the price guard never runs unguarded (D-L3)", () => {
  it("its competition is quoted net of the order's tip — no tip priced — and one that cannot run is 503 guard_unavailable", async () => {
    let priced = 0;
    h = await harness({
      tipFor: async () => {
        priced++;
        if (priced > 1) throw Object.assign(new Error("the RPC endpoints are down"), {});
        return 25n * 10n ** 14n;
      },
    });
    const c = await h.post("/v1/operations", orderBody());
    expect(c.status).toBe(200);
    expect(priced).toBe(1);
    const p = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
    expect(p.status, "the guard's competition priced nothing").toBe(200);
    expect(priced).toBe(1);
    const engine = h.deps.engine;
    const quoteAll = engine.quoteAll.bind(engine);
    engine.quoteAll = async () => {
      throw new Error("the competition is down");
    };
    const down = await h.post(`/v1/operations/${c.body.operationId}/prepare`, {});
    engine.quoteAll = quoteAll;
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("guard_unavailable");
  });
});
