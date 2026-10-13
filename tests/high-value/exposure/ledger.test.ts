// The exposure ledger (plan §25–§27, §65–§68; contract §3.5): the plan's own examples — $100K + $80K + $70K under a
// $250K cap is admitted, $250K × 3 is refused; a settled tranche's exposure is zero (§27); a provider's share is
// bounded (I6). Pins I-HV 1 (inFlight ≤ maxExternalExposure), 2 (providerExposure ≤ providerLimit), 10 (completed
// value is never counted as in-flight) and 11 (failed value is not assumed settled).
import { describe, it, expect } from "vitest";
import { canRelease, exposure, ledger, providerLimit, withTrancheState, type TrancheState } from "../../../packages/protocol/src/wallet/campaign";
import { campaign, USDC, sum } from "../helpers";

const K = 1_000n * USDC;

describe("the ledger (plan §25–§27)", () => {
  it("§25: $100K + $80K + $70K in flight under a $250K cap is accepted; $250K each from three providers is not", () => {
    const pieces = [100n * K, 80n * K, 70n * K, ...Array.from({ length: 39 }, () => 250n * K)]; // $10M: the cap is $250K
    let c = campaign(pieces, [], {}, { capBps: 250, concurrency: "parallel", maxParallel: 3, providerShareCapBps: 3000 });
    c = withTrancheState(c, 0, "settled", 1); // the first tranche settled alone (progressive confidence)
    c = withTrancheState(c, 0, "executing", 2, { provider: "thorchain" });
    c = withTrancheState(c, 1, "executing", 3, { provider: "chainflip" });
    c = withTrancheState(c, 2, "executing", 4, { provider: "mayan" });
    const e = exposure(c);
    expect(e.cap).toBe((sum(pieces) * 250n) / 10000n);
    expect(e.inFlight).toBe(250n * K);
    expect(e.inFlight <= e.cap).toBe(true);
    expect(e.byProvider).toEqual({ thorchain: 100n * K, chainflip: 80n * K, mayan: 70n * K });
    expect(canRelease(c, 250n * K, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I1") });
    const l = ledger(c);
    expect(l.inFlight).toBe((250n * K).toString());
    expect(BigInt(l.remaining) + BigInt(l.inFlight) + BigInt(l.completed) + BigInt(l.pending)).toBe(BigInt(l.totalOrderValue));
  });
  it("§27: a tranche fully settled exposes nothing — the next one may begin", () => {
    const T = 250n * K;
    let c = campaign([T, T, T, T], ["executing", "planned", "planned", "planned"], {}, { capBps: 2500 });
    expect(canRelease(c, T, "thorchain")).toMatchObject({ ok: false });
    c = withTrancheState(c, 0, "settled", 2);
    expect(exposure(c).inFlight).toBe(0n);
    expect(canRelease(c, T, "thorchain")).toEqual({ ok: true });
  });
  it("I-HV 10 and 11: completed is never counted in flight; a failed step is pending in its escrow, never settled", () => {
    const T = 250n * K;
    const c = campaign([T, T, T, T], ["settled", "failed", "executing", "planned"], {}, { capBps: 2500 });
    const e = exposure(c);
    expect(e.completed).toBe(T);
    expect(e.inFlight).toBe(T);
    expect(e.prepared, "the failed step's funds sit in its escrow").toBe(T);
    expect(e.remaining).toBe(T);
    expect(e.completed + e.inFlight + e.prepared + e.remaining).toBe(4n * T);
    const l = ledger(c);
    expect(l.completed).toBe(T.toString());
    expect(l.pending).toBe(T.toString());
  });
  it("I-HV 2: a provider's in-flight amount never exceeds its limit; a single venue has no limit of its own", () => {
    const T = 250n * K;
    const shared = campaign([T, T, T, T], ["settled", "planned", "planned", "planned"], {}, { capBps: 10000, concurrency: "parallel", maxParallel: 3, providerShareCapBps: 3000 });
    expect(providerLimit(shared)).toBe(300n * K);
    const one = withTrancheState(shared, 1, "executing", 2, { provider: "thorchain" });
    expect(canRelease(one, T, "thorchain")).toMatchObject({ ok: false, reason: expect.stringContaining("I6") });
    expect(canRelease(one, T, "chainflip")).toEqual({ ok: true });
    const single = campaign([T, T, T, T], ["settled", "planned", "planned", "planned"], {}, { capBps: 10000, concurrency: "parallel", maxParallel: 3, providerShareCapBps: 10000 });
    expect(providerLimit(single)).toBe(4n * T);
    expect(canRelease(withTrancheState(single, 1, "executing", 2, { provider: "thorchain" }), T, "thorchain")).toEqual({ ok: true });
  });
  it("every in-flight state counts, including delivered-but-not-final (I3), and a partial fill splits its amount", () => {
    const T = 250n * K;
    for (const s of ["executing", "source-confirmed", "destination-submitted", "destination-confirmed"] as TrancheState[]) {
      const c = campaign([T, T], ["settled", s], {}, { capBps: 5000 });
      expect(exposure(c).inFlight, s).toBe(T);
    }
    const partial = withTrancheState(campaign([T, T], ["settled", "executing"], {}, { capBps: 5000 }), 1, "partial", 3, { outcome: { delivered: (100n * K).toString() } });
    expect(exposure(partial)).toMatchObject({ completed: T + 100n * K, inFlight: 150n * K });
  });
});
