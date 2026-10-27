// The frozen lists equal what the spec writes (spec v2.0 §12.1, §12.4, §13.4, §14.1): a change to one without the other fails.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCKER_CODES, OPERATION_STATES, SETTLEMENT_STATES, STATE_CROSSWALK_V2, TERMINAL_STATES, privacyLevelOf } from "../src";

const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v2.0.md"), "utf8");
const block = (from: string, to: string): string => spec.slice(spec.indexOf(from), spec.indexOf(to, spec.indexOf(from)));
// V7 Stage 15: the states are spec v3.0 §6's (the settlement states and the blocker codes stay v2.0's)
const spec3 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v3.0.md"), "utf8");
const block3 = (from: string, to: string): string => spec3.slice(spec3.indexOf(from), spec3.indexOf(to, spec3.indexOf(from)));

describe("protocol-types == spec v2.0", () => {
  it("the operation states of spec v3.0 §6 (V7 Stage 15: the document's fifteen), in order, and the terminal ones", () => {
    const states = block3("OperationState = DRAFT", "```")
      .replace("OperationState = ", "")
      .split("|")
      .map((s) => s.trim());
    expect(states).toEqual([...OPERATION_STATES]);
    expect(states).toHaveLength(15);
    expect(spec3).toContain("Terminal: `COMPLETED`, `REFUNDED`, `CANCELLED`, `FAILED`.");
    // the V6 → V7 table of §6: every plain rename is the crosswalk's (the two the record decides are prose)
    const rows = block3("| V6 (v2.0 §12.1) | V7 |", "\n\n")
      .split("\n")
      .filter((l) => /^\| [A-Z_, ]+ \| [A-Z_]+ \|$/.test(l))
      .map((l) => l.split("|").map((c) => c.trim()));
    const expected: Record<string, string> = {};
    for (const [, v6s, v7] of rows) for (const v6 of v6s.split(",").map((x) => x.trim())) expected[v6] = v7;
    // the signature's plain rename is in the crosswalk (the history lines without a step); its split by the progress step is the upgrade's
    expect({ ...expected, AWAITING_SIGNATURE: "AWAITING_AUTHORIZATION" }).toEqual({ ...STATE_CROSSWALK_V2 });
    expect([...TERMINAL_STATES].sort()).toEqual(["CANCELLED", "COMPLETED", "FAILED", "REFUNDED"]);
  });

  it("the settlement states of §12.4", () => {
    for (const s of SETTLEMENT_STATES) expect(block("### 12.4", "### 12.5")).toContain(`\`${s}\``);
    expect(SETTLEMENT_STATES).toHaveLength(6);
  });

  it("the blocker codes of §13.4", () => {
    const listed = [...block("type BlockerCode =", "```").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual([...BLOCKER_CODES]);
  });

  it("the privacy levels of §14.1: high ≥ 75, medium ≥ 50, low below", () => {
    expect([privacyLevelOf(100), privacyLevelOf(75), privacyLevelOf(74.9), privacyLevelOf(50), privacyLevelOf(49.9), privacyLevelOf(0)]).toEqual([
      "high",
      "high",
      "medium",
      "medium",
      "low",
      "low",
    ]);
  });
});
