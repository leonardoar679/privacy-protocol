// @vitest-environment happy-dom
// The fee policy statement (spec v3.0 §3; doc §6; V7 Stage 12): every Review says the 1 % is charged on each protect, send
// and swap, a swap's Review adds that protected funds pay again, a protected execution's relayer row counts its steps; the
// Fees & refunds page is reached from Settings and from the Privacy Center and says what docs/fee-policy.md publishes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { REVIEW_FIXTURES } from "../src/features/flowFixtures";
import { FEE_POLICY_SECTIONS, FeesAndRefunds } from "../src/features/privacy-center/FeesAndRefunds";
import { ReviewView, type ReviewModel } from "../src/features/review/View";
import { prefs } from "../src/storage/prefs";
import { renderApp } from "./helpers/render";

afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  prefs().reset();
});
const noop = () => {};
async function unlocked() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  prefs().update({ firstLaunchDone: true });
}

describe("the fee statement on the Review (spec v3.0 §3)", () => {
  it("every Review's fee section ends with the one sentence; a swap's adds that protected funds pay again", () => {
    for (const kind of ["protect", "send"] as const) {
      render(<ReviewView model={REVIEW_FIXTURES[kind] as ReviewModel} actions={{ onConfirm: noop, onEdit: noop }} />);
      const note = screen.getByTestId("review-fee-statement");
      expect(note.textContent).toContain("Privacy fee (1 %) — charged on each protect, send and swap.");
      expect(note.textContent).not.toContain("pays 1 % again");
      cleanup();
    }
    for (const kind of ["swap", "cross-chain"] as const) {
      render(<ReviewView model={REVIEW_FIXTURES[kind] as ReviewModel} actions={{ onConfirm: noop, onEdit: noop }} />);
      const note = screen.getByTestId("review-fee-statement");
      expect(note.textContent).toContain("charged on each protect, send and swap.");
      expect(note.textContent).toContain("Your funds paid 1 % when they were protected; this swap pays 1 % again.");
      cleanup();
    }
  });
  it("a send the connected wallet submits: the relayer row says the wallet pays, and the statement says no privacy fee is charged (the review round of 2026-11-03, W5)", () => {
    const model = {
      ...(REVIEW_FIXTURES.send as ReviewModel),
      fees: [{ kind: "relayer" as const, usdCents: null, note: "Paid by your connected wallet" }],
      feeStatement: "No privacy fee: your connected wallet submits this send and pays the network fee itself.",
    };
    render(<ReviewView model={model} actions={{ onConfirm: noop, onEdit: noop }} />);
    expect(screen.getByTestId("review-fee-relayer").textContent).toContain("Paid by your connected wallet");
    const note = screen.getByTestId("review-fee-statement").textContent ?? "";
    expect(note).toContain("No privacy fee");
    expect(note).not.toContain("charged on each");
    cleanup();
  });
  it("a protected execution's relayer row counts its steps (F × n); a single order's does not", () => {
    const large = REVIEW_FIXTURES.large as ReviewModel;
    const stepped: ReviewModel = { ...large, fees: large.fees.map((f) => (f.kind === "relayer" ? { ...f, count: 4 } : f)) };
    render(<ReviewView model={stepped} actions={{ onConfirm: noop, onEdit: noop }} />);
    expect(screen.getByTestId("review-fee-relayer").textContent).toContain("Relayer/network (4 steps)");
    cleanup();
    render(<ReviewView model={REVIEW_FIXTURES.send as ReviewModel} actions={{ onConfirm: noop, onEdit: noop }} />);
    expect(screen.getByTestId("review-fee-relayer").textContent).toContain("Relayer/network");
    expect(screen.getByTestId("review-fee-relayer").textContent).not.toContain("steps");
  });
});

describe("Fees & refunds (spec v3.0 §3)", () => {
  const policy = readFileSync(join(__dirname, "..", "..", "..", "docs", "fee-policy.md"), "utf8").replace(/\s+/g, " "); // the document wraps its lines
  it("the page says what the published policy says, in the same words", () => {
    render(<FeesAndRefunds onBack={noop} />);
    expect(screen.getByTestId("fees-and-refunds")).toBeInTheDocument();
    for (const s of FEE_POLICY_SECTIONS) expect(screen.getByTestId(s.testId)).toBeInTheDocument();
    expect(screen.getByTestId("fee-policy-classic")).toBeInTheDocument();
    // the statements the policy is known by appear in the catalog, on the page and in docs/fee-policy.md
    const phrases = [
      "charged on each protect, send and swap",
      "this swap pays 1 % again",
      "earned when",
      "returns the swapped amount",
      "never sent twice",
      "never a percentage and never a fixed gas price",
    ];
    const page = document.body.textContent ?? "";
    const review = `${en["screen.review.feeStatement"]} ${en["screen.review.feeAgain"]}`;
    for (const p of phrases) {
      expect(policy, p).toContain(p);
      expect(`${page} ${review}`, p).toContain(p);
    }
    // every sentence of the page has its Korean twin
    for (const s of FEE_POLICY_SECTIONS) for (const k of [s.title, ...s.lines]) expect(ko[k as keyof typeof ko], k).toBeTruthy();
    expect(ko["screen.review.feeStatement"]).toContain("1 %");
    expect(ko["screen.review.feeAgain"]).toContain("1 %");
  });
  it("is reached from Settings' trading section and from the Privacy Center's transaction section", async () => {
    await unlocked();
    await renderApp("/settings");
    await waitFor(() => expect(screen.getByTestId("settings")).toBeInTheDocument(), { timeout: 20_000 });
    fireEvent.click(screen.getByTestId("settings-fees"));
    await waitFor(() => expect(screen.getByTestId("fees-and-refunds")).toBeInTheDocument(), { timeout: 20_000 });
    cleanup();
    await renderApp("/privacy");
    await waitFor(() => expect(screen.getByTestId("privacy-center")).toBeInTheDocument(), { timeout: 20_000 });
    fireEvent.click(screen.getByTestId("fees-and-refunds-link"));
    await waitFor(() => expect(screen.getByTestId("fees-and-refunds")).toBeInTheDocument(), { timeout: 20_000 });
  });
});
