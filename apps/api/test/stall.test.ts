// A settlement stall counts against a provider (V3 §10: two in an hour open its breaker, which steers every user's quotes
// away from it). A V6 follow-up of 2026-10-14: the track route had taken the caller's `since` and `expected` on trust, so
// two requests about made-up transactions opened a provider's breaker for everyone. A stall now counts only for an
// execution the API knows: the operation the wallet names (an opaque id only it holds), executed by the relayer as exactly
// this transaction, and timed by the API's own records — the hand-over and the plan's seconds recorded at finalize.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALL_FACTOR } from "@privacy-wallet/protocol/wallet/campaign";
import { harness, orderBody, sign, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.close());

const TX1 = "0x" + "e1".repeat(32);
const TX2 = "0x" + "e2".repeat(32);
const breaker = () => h.deps.engine.tracker.breakerOpen("thorchain", h.clock.now);
const track = async (query: string) => (await h.get(`/v1/track/thorchain?${query}`)).body;

/** An operation committed, prepared and finalized; the relayer executed it as `tx`, which a reconcile recorded. */
async function executed(tx: string): Promise<string> {
  const op = (await h.post("/v1/operations", orderBody())).body.operationId as string;
  const p = await h.post(`/v1/operations/${op}/prepare`, {});
  expect((await h.post(`/v1/operations/${op}/finalize`, { signature: sign(p.body.digest) })).status).toBe(200);
  h.script.job = { state: "executed", executionTx: tx };
  expect((await h.post(`/v1/operations/${op}/reconcile`, {})).status).toBe(200);
  return op;
}

describe("a settlement stall, from the API's own records", () => {
  it("a caller's own timing about made-up transactions counts nothing: the breaker stays closed", async () => {
    for (const tx of [TX1, TX2, "0x" + "e3".repeat(32)]) {
      const body = await track(`tx=${tx}&since=1&expected=1`);
      expect(body.stalled, tx).toBeUndefined();
    }
    expect(breaker()).toBeNull();
  });

  it("finalize records the plan's seconds; an execution past three times them by the API's clock stalls, and two open the breaker", async () => {
    const a = await executed(TX1);
    const seconds = h.store.execution(a)!.expectedSeconds!;
    expect(seconds, "the prepared quote's plan").toBeGreaterThan(0);
    // the caller's timing changes nothing: before the API's own threshold, no stall
    h.clock.now += STALL_FACTOR * seconds * 1000 - 1_000;
    expect((await track(`tx=${TX1}&operation=${a}&since=1&expected=1`)).stalled).toBeUndefined();
    h.clock.now += 2_000;
    expect((await track(`tx=${TX1}&operation=${a}`)).stalled).toBe(true);
    expect((await track(`tx=${TX1}&operation=${a}`)).stalled, "polled again: the same operation counts once").toBe(true);
    expect(breaker(), "one stalled operation").toBeNull();
    // another transaction under this operation, or an operation id that is not one: nothing
    expect((await track(`tx=${TX2}&operation=${a}`)).stalled).toBeUndefined();
    expect((await track(`tx=${TX1}&operation=op_aaaaaaaaaaaaaaaaaaaaaaaaaa`)).stalled).toBeUndefined();
    // a second operation of this provider, executed and stalled: the breaker opens
    const b = await executed(TX2);
    h.clock.now += STALL_FACTOR * seconds * 1000 + 1_000;
    expect((await track(`tx=${TX2}&operation=${b}`)).stalled).toBe(true);
    expect(breaker()).toMatch(/2 settlement stalls/);
  });

  it("an execution a reconcile has not recorded yet is read from the relayer: only its own transaction counts", async () => {
    const op = (await h.post("/v1/operations", orderBody())).body.operationId as string;
    const p = await h.post(`/v1/operations/${op}/prepare`, {});
    await h.post(`/v1/operations/${op}/finalize`, { signature: sign(p.body.digest) });
    const seconds = h.store.execution(op)!.expectedSeconds!;
    h.clock.now += STALL_FACTOR * seconds * 1000 + 1_000;
    h.script.job = "none"; // the relayer has no execution for it: nothing counts
    expect((await track(`tx=${TX1}&operation=${op}`)).stalled).toBeUndefined();
    h.script.job = { state: "executed", executionTx: TX1 };
    expect((await track(`tx=${TX2}&operation=${op}`)).stalled, "another transaction").toBeUndefined();
    expect((await track(`tx=${TX1}&operation=${op}`)).stalled).toBe(true);
  });
});
