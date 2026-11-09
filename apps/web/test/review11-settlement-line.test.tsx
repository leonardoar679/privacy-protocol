// @vitest-environment happy-dom
// The settlement line in the reader's words (the eleventh review round, the critique of slice 2b): the order card reaches a Simple reader
// from the swap's own page, and the tracker's own sentence is English in the protocol's terms — shown under Advanced only; the label, the
// four steps and a partial fill's amounts are the catalog's words, never "escrow", in English and in Korean.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { SettlementLine } from "../src/components/SettlementLine";
import { OrderPanel } from "../src/features/swap/OrderPanel";

afterEach(() => {
  cleanup();
  setLocale("en");
});

const partial: Tracked = {
  state: "PARTIAL",
  label: "Partial",
  steps: [true, true, true, false],
  detail: "Part of the order was filled; the rest came back to the escrow and is re-shielded to your private balance.",
  deliveredAmount: "0.5 BTC",
  refundedAmount: "10,000 USDC",
};

describe("the order card of a relayer's 'refunded' over an escrow that still holds the order (the twelfth review round, XH)", () => {
  const panel = (tracked: Tracked, jobState = "refunded") =>
    render(
      <OrderPanel
        order={{ orderId: "0x" + "0e".repeat(32), state: "funded", endpoint: "0x" + "ee".repeat(20), params: { refundAfter: 1_800_000_000, executorTip: "0" }, quote: { provider: "thorchain", toAmount: "1000000" }, privacy: { score: 80, delaySeconds: [0, 0] } } as never}
        stored={{ orderId: "0x" + "0e".repeat(32), state: "executing", fundedTx: "0x" + "fa".repeat(32), jobId: "j", params: { refundAfter: 1_800_000_000 } } as never}
        orderAsset={{ symbol: "ETH", decimals: 18 } as never}
        target={{ id: "BTC", ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, network: "Bitcoin" } as never}
        destination="bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        destinationEdited={false}
        job={{ id: "j", escrow: "0x" + "ee".repeat(20), state: jobState, updatedAt: 1 } as never}
        tracked={tracked}
        record={
          {
            id: "swap:0x" + "0e".repeat(32),
            kind: "swap",
            state: "RECOVERY_REQUIRED",
            phase: "execution",
            reason: { code: "execution_window_closed", source: "wallet" },
            settlement: "REFUND_AVAILABLE",
            refs: { orderId: "0x" + "0e".repeat(32) },
            createdAt: 1,
            updatedAt: 1,
          } as never
        }
        signed={null}
        checked={null}
        moved={null}
        refundLine=""
        signLint={null}
        advanced={false}
        busy=""
        submission={{ kind: "relayer", url: "http://relayer.test" }}
        holdActive={false}
        canExport={false}
        onFundNow={() => {}}
        onSign={() => {}}
        onReturn={() => {}}
        onExport={() => {}}
        onMonitor={() => {}}
      />,
    );
  it("DROPPED: Return funds on the card and on its recovery; any other reading with that job: neither", () => {
    panel({ state: "DROPPED", label: "Needs attention", steps: [true, true, false, false], detail: "…" } as Tracked);
    expect(screen.getByTestId("order-return")).toBeTruthy();
    // its hint by the reading: what is held returned, never "The order is not executed" (the twelfth review round, XI's critique)
    expect(screen.getByTestId("order-return").getAttribute("title")).toBe(t("order.returnHintHeld"));
    expect(screen.getByTestId("recovery-refund")).toBeTruthy();
    cleanup();
    panel({ state: "PROVIDER_EXECUTING", label: "Executing", steps: [true, true, false, false], detail: "…" } as Tracked);
    expect(screen.queryByTestId("order-return")).toBeNull();
    expect(screen.queryByTestId("recovery-refund")).toBeNull();
  });

  it("the Return hint by the reading: a late refund's and a failed re-shield's say what is held is returned, never 'The order is not executed' (XJ)", () => {
    for (const state of ["LATE_REFUND", "FAILED"] as const) {
      panel({ state, label: "Needs attention", steps: [true, true, false, false], detail: "…" } as Tracked);
      expect(screen.getByTestId("order-return").getAttribute("title"), state).toBe(t("order.returnHintHeld"));
      cleanup();
    }
  });
});

describe("the settlement line (the eleventh review round, the critique of slice 2b)", () => {
  it("a Simple reader sees the label, the four steps and a partial fill's amounts in the catalog's words — never the tracker's sentence, never 'escrow'", () => {
    render(<SettlementLine tracked={partial} />);
    const line = screen.getByTestId("settlement");
    expect(line.textContent).toContain("Status");
    expect(line.textContent).toContain("Partial");
    expect(screen.getByTestId("settlement-steps").textContent).toBe("✓ Quote locked✓ Source confirmed✓ Destination sent○ Destination finalized");
    expect(screen.getByTestId("settlement-partial").textContent).toBe("Delivered: 0.5 BTC · Came back: 10,000 USDC");
    expect(screen.queryByTestId("settlement-detail"), "the tracker's own sentence is Advanced's").toBeNull();
    expect(line.textContent).not.toMatch(/escrow|re-shielded/i);
  });

  it("under Advanced the tracker's own sentence follows", () => {
    render(<SettlementLine tracked={partial} advanced />);
    expect(screen.getByTestId("settlement-detail").textContent).toBe(partial.detail);
  });

  it("the order card passes the reader's experience: the tracker's sentence under Advanced only (the third critique: the card's half was untested)", () => {
    const card = (advanced: boolean) =>
      render(
        <OrderPanel
          order={{ orderId: "0x" + "0e".repeat(32), state: "funded", endpoint: "0x" + "ee".repeat(20), params: { refundAfter: 1_800_000_000, executorTip: "0" }, quote: { provider: "thorchain", toAmount: "1000000" }, privacy: { score: 80, delaySeconds: [0, 0] } } as never}
          stored={null}
          orderAsset={{ symbol: "ETH", decimals: 18 } as never}
          target={{ id: "BTC", ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, network: "Bitcoin" } as never}
          destination="bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
          destinationEdited={false}
          job={null}
          tracked={partial}
          record={null}
          signed={null}
          checked={null}
          moved={null}
          refundLine=""
          signLint={null}
          advanced={advanced}
          busy=""
          submission={{ kind: "relayer", url: "http://relayer.test" }}
          holdActive={false}
          canExport={false}
          onFundNow={() => {}}
          onSign={() => {}}
          onReturn={() => {}}
          onExport={() => {}}
          onMonitor={() => {}}
        />,
      );
    card(false);
    expect(screen.getByTestId("settlement")).toBeTruthy();
    expect(screen.queryByTestId("settlement-detail"), "Simple: never the tracker's English").toBeNull();
    cleanup();
    card(true);
    expect(screen.getByTestId("settlement-detail").textContent).toBe(partial.detail);
  });

  it("in Korean: the label, the steps and the amounts are the catalog's, none of the English ones", async () => {
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    render(<SettlementLine tracked={partial} />);
    const line = screen.getByTestId("settlement");
    expect(line.textContent).toContain(t("order.status", undefined, "ko"));
    expect(line.textContent).toContain(t("settlement.partial", undefined, "ko"));
    expect(screen.getByTestId("settlement-steps").textContent).toContain(t("settlement.step.destinationFinalized", undefined, "ko"));
    expect(screen.getByTestId("settlement-partial").textContent).toBe(
      t("settlement.partialAmounts", { delivered: "0.5 BTC", returned: "10,000 USDC" }, "ko"),
    );
    expect(line.textContent).not.toMatch(/Status|Partial|Quote locked|Destination|Delivered|Came back/);
  });
});
