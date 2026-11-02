// The operation contract against its spec (Privacy Wallet Web spec v2.0 §12): the state list of §12.1 and its terminal
// states, every row of the §12.2 V5 → V6 table as the upgrade applies it, the invariants named in §12.3 and the
// settlement states of §12.4 — read from the document, so neither can change without the other.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { upgradeState, upgradeStateV7 } from "../src/operations/upgrade";
import { OPERATION_STATES, SETTLEMENT_STATES, TERMINAL_STATES, type OperationKind, type OperationPhase } from "../src/wallet/operationRecord";

const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v2.0.md"), "utf8");
// V7 Stage 15: the states and the V6 → V7 table are spec v3.0 §6's
const spec3 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/privacy-wallet-web-spec-v3.0.md"), "utf8");
const section6 = spec3.slice(spec3.indexOf("## 6. The operation states"), spec3.indexOf("\n## 7."));
function section(heading: string): string {
  const start = spec.indexOf(heading);
  expect(start, heading).toBeGreaterThan(0);
  const end = spec.indexOf("\n### ", start + heading.length);
  return spec.slice(start, end < 0 ? undefined : end);
}
const tokens = (s: string): string[] => [...s.matchAll(/\b[A-Z][A-Z_]{3,}\b/g)].map((m) => m[0]);

describe("spec v2.0 §12 ↔ the code", () => {
  it("spec v3.0 §6: the fifteen states in order and the four terminal ones (V7 Stage 15)", () => {
    const s = section6;
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
  it("spec v3.0 §6: every row of the V6 → V7 table is what the second upgrade step does; the signature's split and the expired quote by the record", () => {
    const rows = section6
      .split("\n")
      .filter((l) => /^\| [A-Z_, ]+ \| [A-Z_]+ \|$/.test(l))
      .map((l) => l.split("|").map((c) => c.trim()));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const [, v6s, v7] of rows)
      for (const v6 of v6s.split(",").map((x) => x.trim())) expect(upgradeStateV7(v6, { state: v6, history: [] }, true), v6).toBe(v7);
    const draft = { state: "AWAITING_SIGNATURE", history: [{ state: "AWAITING_SIGNATURE" }] };
    expect(upgradeStateV7("AWAITING_SIGNATURE", draft, true)).toBe("AWAITING_AUTHORIZATION");
    for (const step of ["witness", "proof", "local-verify"])
      expect(upgradeStateV7("AWAITING_SIGNATURE", { ...draft, progress: { step } }, true), step).toBe("PREPARING_PROOF");
    expect(upgradeStateV7("AWAITING_SIGNATURE", { ...draft, progress: { step: "submitting" }, refs: { relayerUrl: "http://relayer.test" } }, true)).toBe(
      "SUBMITTING",
    );
    expect(
      upgradeStateV7("AWAITING_SIGNATURE", { ...draft, progress: { step: "submitting" } }, true),
      "no relayer kept: the connected wallet's prompt, the authorization (the review round of 2026-11-02)",
    ).toBe("AWAITING_AUTHORIZATION");
    expect(
      upgradeStateV7("AWAITING_SIGNATURE", { ...draft, kind: "protect", progress: { step: "submitting" } }, true),
      "a Protect's prompt is the authorization",
    ).toBe("AWAITING_AUTHORIZATION");
    expect(upgradeStateV7("AWAITING_SIGNATURE", { ...draft, progress: { step: "proof" } }, false), "a history line keeps the plain name").toBe(
      "AWAITING_AUTHORIZATION",
    );
    expect(
      upgradeStateV7("QUOTE_EXPIRED", { state: "QUOTE_EXPIRED", history: [{ state: "AWAITING_SIGNATURE" }, { state: "QUOTE_EXPIRED" }] }, true),
      "before the funding",
    ).toBe("READY_TO_REVIEW");
    expect(
      upgradeStateV7("QUOTE_EXPIRED", { state: "QUOTE_EXPIRED", history: [{ state: "SUBMITTED" }, { state: "QUOTE_EXPIRED" }] }, true),
      "after the funding",
    ).toBe("RECOVERY_REQUIRED");
    for (const same of ["DRAFT", "QUOTING", "COMPLETED", "CANCELLED", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"])
      expect(upgradeStateV7(same, { state: same, history: [] }, true)).toBe(same);
  });
  it("§12.3 names I-O1 to I-O7; §12.4 lists the six settlement states", () => {
    const inv = section("### 12.3 Invariants");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(inv, `I-O${n}`).toContain(`I-O${n}`);
    const settle = section("### 12.4");
    const listed = tokens(settle.slice(settle.indexOf("derives one of"), settle.indexOf("from the legs")));
    expect(listed).toEqual([...SETTLEMENT_STATES]);
  });
});
