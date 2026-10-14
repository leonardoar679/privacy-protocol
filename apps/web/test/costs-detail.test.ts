// The detail's Advanced lines for what the network part cost (spec v2.0 §3; doc §43): Estimated, Actual, the Difference
// with its sign, and what the relayer charged in the fee's asset; nothing about costs on a record that has none.
import { describe, expect, it } from "vitest";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { detailModel } from "../src/features/activity/model";
import type { ActivityRow } from "../src/features/activity/rows";
import { t } from "../src/app/i18n/messages";

const rec = (costs?: OperationRecord["costs"]): OperationRecord => ({
  id: "op_send",
  kind: "send",
  state: "COMPLETED",
  createdAt: 1,
  updatedAt: 2,
  amounts: { asset: "ETH", decimals: 18, input: "1000000000000000000", delivered: "989000000000000000" },
  fees: [],
  destination: { kind: "fresh", display: "0x0000000000000000000000000000000000000001", chain: "ethereum" },
  refs: { txHashes: ["0xab"] },
  tier: "standard",
  history: [{ state: "COMPLETED", at: 2 }],
  ...(costs ? { costs } : {}),
});
const row = (r: OperationRecord): ActivityRow => ({
  id: r.id,
  kind: "send",
  at: 1,
  title: "",
  amount: "",
  status: "",
  tone: "ok",
  ref: "0xab",
  finished: true,
  icon: "send",
  record: r,
});

describe("the detail's cost lines (spec v2.0 §3)", () => {
  it("Estimated, Actual, the Difference and the relayer's charge", () => {
    const m = detailModel(
      row(rec({ estimatedWei: "1100000000000000", actualWei: "1300000000000000", charged: { amount: "1100000000000000", asset: "ETH", decimals: 18 } })),
      t,
    );
    expect(m.advanced).toEqual(
      expect.arrayContaining([
        { label: "Estimated network cost", value: "0.0011 ETH" },
        { label: "Actual network cost", value: "0.0013 ETH" },
        { label: "Difference", value: "−0.0002 ETH" },
        { label: "Relayer charged", value: "0.0011 ETH" },
      ]),
    );
  });
  it("a record without costs shows none of them", () => {
    const labels = detailModel(row(rec()), t).advanced.map((a) => a.label);
    expect(labels).not.toContain("Estimated network cost");
    expect(labels).not.toContain("Difference");
  });
});
