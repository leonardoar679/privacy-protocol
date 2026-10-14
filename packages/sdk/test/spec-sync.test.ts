// The operation contract against its spec (Privacy Wallet Web spec v2.0 §12): the state list of §12.1 and its terminal
// states, every row of the §12.2 V5 → V6 table as the upgrade applies it, the invariants named in §12.3 and the
// settlement states of §12.4 — read from the document, so neither can change without the other.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { upgradeState } from "../src/operations/upgrade";
import { OPERATION_STATES, SETTLEMENT_STATES, TERMINAL_STATES, type OperationKind, type OperationPhase } from "../src/wallet/operationRecord";

const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v2.0.md"), "utf8");
function section(heading: string): string {
  const start = spec.indexOf(heading);
  expect(start, heading).toBeGreaterThan(0);
  const end = spec.indexOf("\n### ", start + heading.length);
  return spec.slice(start, end < 0 ? undefined : end);
}
const tokens = (s: string): string[] => [...s.matchAll(/\b[A-Z][A-Z_]{3,}\b/g)].map((m) => m[0]);

describe("spec v2.0 §12 ↔ the code", () => {
  it("§12.1: the sixteen states in order and the four terminal ones", () => {
    const s = section("### 12.1 States");
    const block = s.slice(s.indexOf("```") + 3, s.indexOf("```", s.indexOf("```") + 3));
    expect(tokens(block).filter((x) => x !== "OperationState")).toEqual([...OPERATION_STATES]);
    const terminal = /Terminal: ([^.]+)\./.exec(s)![1];
    expect(tokens(terminal)).toEqual([...TERMINAL_STATES]);
  });
  it("§12.2: every row of the V5 → V6 table is what the upgrade does", () => {
    const rows = section("### 12.2")
      .split("\n")
      .filter((l) => /^\| [A-Z_]+ \|/.test(l) && !l.startsWith("| V5"));
    const kinds: OperationKind[] = ["protect", "send", "withdraw", "swap", "cross-chain"];
    const phases: (OperationPhase | undefined)[] = ["funding", "execution", "settlement", undefined];
    const seen: string[] = [];
    for (const row of rows) {
      const [, v5, v6] = row.split("|").map((c) => c.trim());
      seen.push(v5);
      const allowed = new Set(tokens(v6));
      for (const k of kinds)
        for (const p of phases) {
          const failure = { code: "bad_fee", fundsClass: "not-moved" as const };
          const got = upgradeState(v5, k, p, failure, true);
          if (v5 === "SIGNATURE_REJECTED")
            expect(["CANCELLED", "REVIEW"], row).toContain(got); // stored: CANCELLED; live: REVIEW
          else expect(allowed.has(got), `${row} → ${got} (${k}, ${p})`).toBe(true);
        }
    }
    expect(seen).toEqual([
      "QUOTE_READY",
      "RELAYER_EXECUTING",
      "NETWORK_CONFIRMING",
      "SETTLEMENT_VERIFYING",
      "SIGNATURE_REJECTED",
      "SUBMISSION_FAILED",
      "NETWORK_DELAYED",
      "PROVIDER_FAILED",
    ]);
    expect(upgradeState("SIGNATURE_REJECTED", "send", undefined, undefined, true), "a stored rejection").toBe("CANCELLED");
    expect(upgradeState("SUBMISSION_FAILED", "send", undefined, { code: "send_failed", fundsClass: "unknown" }, true), "§12.3 I-O6").toBe("RECOVERY_REQUIRED");
  });
  it("§12.3 names I-O1 to I-O7; §12.4 lists the six settlement states", () => {
    const inv = section("### 12.3 Invariants");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(inv, `I-O${n}`).toContain(`I-O${n}`);
    const settle = section("### 12.4");
    const listed = tokens(settle.slice(settle.indexOf("derives one of"), settle.indexOf("from the legs")));
    expect(listed).toEqual([...SETTLEMENT_STATES]);
  });
});
