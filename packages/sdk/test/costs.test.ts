// Actual against estimated (Privacy Wallet Web spec v2.0 §3; doc §43): the deviation rules (a real cost above 1.5 × the
// estimate; a relayer charge of at least 3 × the real cost; a token charge not compared), the reducer keeping the costs
// and noting a deviation on the history, the costs arriving before the completion freezes the record (I-O1), and the
// engine's typed event mapped onto the record's.
import { describe, expect, it } from "vitest";
import { costDifference, costNotes } from "../src/operations/costs";
import { fromEngineEvent } from "../src/operations/engineEvents";
import { transition } from "../src/operations/reducer";
import type { OperationRecord } from "../src/wallet/operationRecord";

const GWEI = 10n ** 9n;
const record = (state: OperationRecord["state"]): OperationRecord => ({
  id: "op_test",
  kind: "send",
  state,
  createdAt: 1_000,
  updatedAt: 1_000,
  amounts: { asset: "ETH", decimals: 18, input: "1000000000000000000" },
  fees: [],
  destination: { kind: "fresh", display: "0x01", chain: "ethereum" },
  refs: { txHashes: [] },
  tier: "standard",
  history: [{ state, at: 1_000 }],
});

describe("the deviation rules", () => {
  it("a real cost above 1.5 × the estimate is noted; up to it, nothing", () => {
    expect(costNotes({ estimatedWei: String(1_000_000n * GWEI), actualWei: String(1_600_000n * GWEI) })).toEqual([
      "the network cost was more than 1.5 × the estimate",
    ]);
    expect(costNotes({ estimatedWei: String(1_000_000n * GWEI), actualWei: String(1_500_000n * GWEI) })).toEqual([]);
  });
  it("a relayer charge of at least 3 × the real cost is noted; a charge in a token is not compared", () => {
    expect(costNotes({ actualWei: String(1_000_000n * GWEI), charged: { amount: String(3_000_000n * GWEI), asset: "ETH", decimals: 18 } })).toEqual([
      "the relayer charged at least 3 × the network cost",
    ]);
    expect(costNotes({ actualWei: String(1_000_000n * GWEI), charged: { amount: String(2_999_999n * GWEI), asset: "ETH", decimals: 18 } })).toEqual([]);
    expect(costNotes({ actualWei: "1", charged: { amount: "4100000", asset: "USDC", decimals: 6 } })).toEqual([]);
  });
  it("the difference is the estimate less the real cost", () => {
    expect(costDifference({ estimatedWei: "100", actualWei: "130" })).toBe(-30n);
    expect(costDifference({ actualWei: "130" })).toBeNull();
  });
});

describe("the record keeps its costs (the reducer)", () => {
  it("merges them while the operation is open and notes a deviation on the current line", () => {
    const r = transition(record("SOURCE_CONFIRMING"), { type: "costs", costs: { estimatedWei: "100", actualWei: "200" } }, 2_000);
    expect(r.ok).toBe(true);
    expect(r.record.costs).toEqual({ estimatedWei: "100", actualWei: "200" });
    expect(r.record.state, "a field event: the state stays").toBe("SOURCE_CONFIRMING");
    expect(r.record.history.at(-1)!.note).toBe("the network cost was more than 1.5 × the estimate");
  });
  it("a completed record is frozen (I-O1): the costs come before the completion", () => {
    const r = transition(record("COMPLETED"), { type: "costs", costs: { actualWei: "200" } }, 2_000);
    expect(r).toMatchObject({ ok: false, reason: "terminal" });
  });
});

describe("the engine's typed event", () => {
  it("maps onto the record's in decimal strings; a nested merge's costs are its own", () => {
    expect(fromEngineEvent({ type: "costs", estimatedWei: 5n, actualWei: 7n, charged: { amount: 5n, asset: "ETH", decimals: 18 } })).toEqual({
      type: "costs",
      costs: { estimatedWei: "5", actualWei: "7", charged: { amount: "5", asset: "ETH", decimals: 18 } },
    });
    expect(fromEngineEvent({ type: "costs", actualWei: 7n }, { nested: true })).toBeNull();
  });
});
