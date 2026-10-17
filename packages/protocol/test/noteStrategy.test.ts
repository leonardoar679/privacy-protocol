// The housekeeping planner (plan V2 §73–§74, the whale UTXO lab): a single large note is split into the
// shipped alphabet's pieces (100-unit first, then 10-unit while the count allows), dust is merged, too many
// notes are merged, every action pays a fee, the budget bounds a run, and the plan is self-consistent.
import { describe, it, expect } from "vitest";
import { planHousekeeping, shapeFor, shapeSummary } from "../src/wallet/noteStrategy";

const E = 10n ** 18n;
const FEE = 2n * 10n ** 15n; // 0.002 ETH

describe("shape policy", () => {
  it("is 100 / 10 units with dust below the smallest bucket, for ETH and for USDC", () => {
    expect(shapeFor(18)).toEqual({ maxPiece: 100n * E, targetPiece: 10n * E, dustFloor: 10n ** 15n, maxNotes: 64 });
    expect(shapeFor(6)).toEqual({ maxPiece: 100_000n * 10n ** 6n, targetPiece: 10_000n * 10n ** 6n, dustFloor: 10n ** 6n, maxNotes: 64 });
  });
});

describe("planHousekeeping", () => {
  it("one 1,330 ETH note: 100-ETH pieces come off first, each split paying its fee; then 10-ETH pieces while under 64 notes; every step consistent with the last", () => {
    const { actions, shape } = planHousekeeping([{ id: "whale", amount: 1330n * E }], { decimals: 18, feePerTx: FEE });
    expect(shape.ok).toBe(false);
    expect(shape.oversized).toBe(1);
    const first = actions[0];
    expect(first.kind).toBe("split");
    if (first.kind !== "split") return;
    expect(first.input.id).toBe("whale");
    expect(first.outputs).toEqual([100n * E, 1330n * E - 100n * E - FEE]);
    // the first thirteen splits take 100 ETH each off the remainder
    const hundreds = actions.filter((a) => a.kind === "split" && a.outputs[0] === 100n * E);
    expect(hundreds.length).toBe(13);
    // then the 100-ETH pieces are split into 10-ETH pieces until the note cap
    const tens = actions.filter((a) => a.kind === "split" && a.outputs[0] === 10n * E);
    expect(tens.length).toBeGreaterThan(20);
    // replaying the plan on a working copy never spends a note twice and keeps the value minus fees
    const pool = new Map<string, bigint>([["whale", 1330n * E]]);
    for (const a of actions) {
      if (a.kind === "split") { expect(pool.has(a.input.id), a.input.id).toBe(true); expect(pool.get(a.input.id)).toBe(a.input.amount); pool.delete(a.input.id); pool.set(a.outputIds[0], a.outputs[0]); pool.set(a.outputIds[1], a.outputs[1]); expect(a.outputs[0] + a.outputs[1] + a.fee).toBe(a.input.amount); }
      else { for (const i of a.inputs) { expect(pool.get(i.id)).toBe(i.amount); pool.delete(i.id); } pool.set(a.outputId, a.inputs[0].amount + a.inputs[1].amount - a.fee); }
    }
    const total = [...pool.values()].reduce((s, v) => s + v, 0n);
    expect(total).toBe(1330n * E - BigInt(actions.length) * FEE);
    expect(pool.size).toBeLessThanOrEqual(64);
    expect([...pool.values()].every((v) => v <= 100n * E)).toBe(true);
    expect(shapeSummary(shape, actions.length)).toMatch(/maintenance steps planned \(1 note above the largest common size\)/);
  });

  it("dust is merged into the smallest neighbour; a dust note below the fee is left alone; too many notes merge the two smallest", () => {
    const SMALL = 2n * 10n ** 14n; // a 0.0002 ETH fee: a 0.0005 ETH dust note is worth merging
    const dust = planHousekeeping([{ id: "a", amount: 5n * E }, { id: "d", amount: 5n * 10n ** 14n }, { id: "b", amount: 2n * E }], { decimals: 18, feePerTx: SMALL });
    expect(dust.actions).toEqual([{ kind: "merge", inputs: [{ id: "d", amount: 5n * 10n ** 14n }, { id: "b", amount: 2n * E }], outputId: "m0", fee: SMALL, reason: "dust merged into its neighbour" }]);
    expect(dust.shape.dust).toBe(1);
    // at a 0.002 ETH fee the same dust note is worth less than the fee: left alone, said so
    expect(planHousekeeping([{ id: "a", amount: 5n * E }, { id: "d", amount: 5n * 10n ** 14n }], { decimals: 18, feePerTx: FEE }).actions).toEqual([]);
    const tiny = planHousekeeping([{ id: "a", amount: 5n * E }, { id: "d", amount: 10n ** 12n }], { decimals: 18, feePerTx: FEE });
    expect(tiny.actions).toEqual([]);
    expect(tiny.shape.reasons[0]).toMatch(/worth less than a fee/);
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, amount: E + BigInt(i) * 10n ** 15n }));
    const r = planHousekeeping(many, { decimals: 18, feePerTx: FEE });
    expect(r.actions.filter((a) => a.kind === "merge").length).toBe(6);
    expect(r.actions[0]).toMatchObject({ kind: "merge", inputs: [{ id: "n0" }, { id: "n1" }] });
  });

  it("a balance above 64 of the largest pieces converges: never merged into a note the next run would split again (the audit round of 2026-10-16, c54)", () => {
    const notes = Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, amount: 100n * E }));
    const r = planHousekeeping(notes, { decimals: 18, feePerTx: FEE });
    expect(r.actions, "nothing to do: each note is at the largest size, and a merge would make one above it").toEqual([]);
    expect(r.shape.reasons.join(" ")).toMatch(/more than 64 notes, each at most the largest common size/);
    // a whale above 64 × 100 ETH: the runs split it down and then stop
    let pool: { id: string; amount: bigint }[] = [{ id: "w", amount: 7_000n * E }];
    let runs = 0;
    for (; runs < 200; runs++) {
      pool = pool.map((n, i) => ({ id: `r${runs}n${i}`, amount: n.amount })); // a run's own ids start again at s0 / m0
      const plan = planHousekeeping(pool, { decimals: 18, feePerTx: FEE, maxActions: 50 });
      if (!plan.actions.length) break;
      for (const a of plan.actions) {
        if (a.kind === "split") pool = [...pool.filter((n) => n.id !== a.input.id), { id: a.outputIds[0], amount: a.outputs[0] }, { id: a.outputIds[1], amount: a.outputs[1] }];
        else pool = [...pool.filter((n) => !a.inputs.some((i) => i.id === n.id)), { id: a.outputId, amount: a.inputs[0].amount + a.inputs[1].amount - a.fee }];
      }
    }
    expect(runs, "it converges").toBeLessThan(200);
    expect(pool.every((n) => n.amount <= 100n * E)).toBe(true);
  });

  it("a budget or an action cap bounds a run and reports what was deferred; a well-shaped balance plans nothing", () => {
    const capped = planHousekeeping([{ id: "whale", amount: 1330n * E }], { decimals: 18, feePerTx: FEE, feeBudget: 5n * FEE });
    expect(capped.actions).toHaveLength(5);
    expect(capped.shape.deferred).toBe(1);
    const one = planHousekeeping([{ id: "whale", amount: 1330n * E }], { decimals: 18, feePerTx: FEE, maxActions: 1 });
    expect(one.actions).toHaveLength(1);
    const fine = planHousekeeping([{ id: "a", amount: 10n * E }, { id: "b", amount: 7n * E }, { id: "c", amount: 5n * 10n ** 17n }], { decimals: 18, feePerTx: FEE });
    expect(fine.actions).toEqual([]);
    expect(fine.shape.ok).toBe(true);
    expect(shapeSummary(fine.shape, 0)).toMatch(/common-sized pieces/);
    // USDC: 1,000,000 USDC → 100,000 pieces first
    const usdc = planHousekeeping([{ id: "u", amount: 1_000_000n * 10n ** 6n }], { decimals: 6, feePerTx: 10n ** 6n, maxActions: 1 });
    expect(usdc.actions[0]).toMatchObject({ kind: "split", outputs: [100_000n * 10n ** 6n, 1_000_000n * 10n ** 6n - 100_000n * 10n ** 6n - 10n ** 6n] });
  });
});
