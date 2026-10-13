// The frozen lists equal what the spec writes (spec v2.0 §12.1, §12.4, §13.4, §14.1): a change to one without the other fails.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCKER_CODES, OPERATION_STATES, SETTLEMENT_STATES, TERMINAL_STATES, privacyLevelOf } from "../src";

const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v2.0.md"), "utf8");
const block = (from: string, to: string): string => spec.slice(spec.indexOf(from), spec.indexOf(to, spec.indexOf(from)));

describe("protocol-types == spec v2.0", () => {
  it("the operation states of §12.1, in order, and the terminal ones", () => {
    const states = block("OperationState = DRAFT", "```")
      .replace("OperationState = ", "")
      .split("|")
      .map((s) => s.trim());
    expect(states).toEqual([...OPERATION_STATES]);
    expect(spec).toContain("Terminal: `COMPLETED`, `REFUNDED`, `CANCELLED`, `FAILED`.");
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
