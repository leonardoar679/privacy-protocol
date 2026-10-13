// @vitest-environment happy-dom
// The patterns (spec v2.0 §5): the flow card's two sides and its switch, the fee lines with the receive line first and
// the total last, the review's amount, rows and one action — the way back a text button apart from it, never a
// destructive button beside the confirmation (doc §57) —, the four screen states, the address chip and its copy, the
// amount text, and the sticky action that rises above the keyboard (doc §56).
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AddressChip, AmountText, Button, FeeLines, FlowCard, ReviewLayout, StateScreen, StickyAction, TextButton } from "../src/index";

describe("the patterns (spec v2.0 §5)", () => {
  it("FlowCard: the source above, the destination below, the assets selectable, the direction switchable", () => {
    const onFrom = vi.fn();
    const onSwitch = vi.fn();
    render(
      <FlowCard
        from={{
          label: "You pay",
          asset: { symbol: "USDC" },
          network: "Protected balance",
          onAsset: onFrom,
          children: "8,000.00",
          sub: "Balance 12,400 USDC",
          testId: "from",
        }}
        to={{ label: "You receive", asset: { symbol: "ETH" }, network: "Protected balance", children: "≈ 2.31", testId: "to" }}
        onSwitch={onSwitch}
      />,
    );
    const flow = screen.getByTestId("flow");
    const [from, to] = [screen.getByTestId("from"), screen.getByTestId("to")];
    expect(from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(from).toHaveTextContent("You pay");
    expect(from).toHaveTextContent("Balance 12,400 USDC");
    expect(to).toHaveTextContent("≈ 2.31");
    fireEvent.click(screen.getByTestId("from-asset"));
    expect(onFrom).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("to-asset")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch direction" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(flow.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
  });

  it("FeeLines: the receive line first, every fee on its own line, the total last", () => {
    render(
      <FeeLines
        receive={{ label: "Recipient receives", value: "2,470.90 USDC", testId: "receive" }}
        lines={[
          { label: "Privacy fee", value: "25.00 USDC", hint: "1 % of the amount" },
          { label: "Relayer / network", value: "4.10 USDC" },
        ]}
        total={{ label: "Total", value: "2,500.00 USDC", testId: "total" }}
      />,
    );
    const rows = [...screen.getByTestId("fee-lines").querySelectorAll(".ds-fee-row")];
    expect(rows.map((r) => r.querySelector("dt span")?.textContent)).toEqual(["Recipient receives", "Privacy fee", "Relayer / network", "Total"]);
    expect(screen.getByTestId("receive")).toHaveClass("ds-fee-row-receive");
    expect(screen.getByTestId("total")).toHaveClass("ds-fee-row-total");
    expect(rows[1]).toHaveTextContent("1 % of the amount");
  });

  it("ReviewLayout: the amount, the sections, one primary action, the way back apart from it and never destructive", () => {
    render(
      <ReviewLayout
        amount={{ label: "You pay", primary: "$10,000.00", secondary: "10,000 USDC" }}
        sections={[
          {
            title: "You receive",
            rows: [
              { label: "At least", value: "2.857 ETH", testId: "min" },
              { label: "Destination", value: "Your protected balance", tone: "positive" },
            ],
          },
          { title: "Fees", rows: [{ label: "Total", value: "$114.00" }] },
        ]}
        action={
          <Button size="lg" full data-testid="confirm">
            Confirm
          </Button>
        }
        secondaryAction={<TextButton data-testid="edit">Edit</TextButton>}
      />,
    );
    const review = screen.getByTestId("review");
    expect(screen.getByTestId("review-amount")).toHaveTextContent("$10,000.00");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["You receive", "Fees"]);
    expect(screen.getByTestId("min")).toHaveTextContent("2.857 ETH");
    expect(review.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(review.querySelectorAll('[data-variant="destructive"]')).toHaveLength(0);
    // the confirmation sits alone in its sticky area; the way back is outside it
    const action = screen.getByTestId("review-action");
    expect(action).toContainElement(screen.getByTestId("confirm"));
    expect(action).not.toContainElement(screen.getByTestId("edit"));
    expect(screen.getByTestId("edit")).toHaveAttribute("data-variant", "text");
  });

  it("StateScreen: empty, loading, error and done — a mark, a title, a sentence, the actions", () => {
    const { rerender } = render(
      <StateScreen kind="empty" title="Nothing here yet" body="Protect assets to start." actions={<Button>Protect Assets</Button>} />,
    );
    expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "empty");
    expect(screen.getByRole("heading", { name: "Nothing here yet" })).toBeInTheDocument();
    rerender(<StateScreen kind="loading" title="Securing your transaction…" />);
    expect(screen.getByTestId("state")).toHaveAttribute("aria-busy", "true");
    rerender(<StateScreen kind="error" title="We stopped this transaction" body="Your funds have not moved." />);
    expect(screen.getByTestId("state")).toHaveTextContent("Your funds have not moved.");
    rerender(<StateScreen kind="done" title="Protected" />);
    expect(screen.getByTestId("state")).toHaveClass("ds-state-done");
  });

  it("AddressChip: 0x43…82C1 on screen, the whole address as its name, copied whole", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AddressChip address="0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1" label="Recipient" copyable />);
    const text = screen.getByTestId("address-chip").querySelector(".ds-address-chip-text")!;
    expect(text.textContent).toBe("0x43…82C1");
    expect(text).toHaveAttribute("aria-label", "Recipient: 0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("address-chip-copy"));
    });
    expect(writeText).toHaveBeenCalledWith("0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1");
    expect(screen.getByTestId("address-chip-copy")).toHaveAttribute("aria-label", "Copied");
  });

  it("AmountText: base units with display decimals and the symbol; USD from cents; approximate when said", () => {
    render(
      <>
        <AmountText value={3_251_795_247_999_961_984_000n} decimals={18} displayDecimals={4} symbol="ETH" testId="eth" />
        <AmountText usdCents={1_000_000n} approx size="large" testId="usd" />
      </>,
    );
    expect(screen.getByTestId("eth")).toHaveTextContent(/^3,251\.7952 ETH$/);
    expect(screen.getByTestId("usd")).toHaveTextContent(/^≈ \$10,000\.00$/);
    expect(screen.getByTestId("usd")).toHaveClass("ds-amount-text-large");
  });

  it("StickyAction: rises above the on-screen keyboard (visualViewport) and scrolls into view when an input takes focus", async () => {
    const listeners: Record<string, () => void> = {};
    const vv = { height: 844, offsetTop: 0, addEventListener: (e: string, l: () => void) => (listeners[e] = l), removeEventListener: () => undefined };
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <>
        <input data-testid="amount" />
        <StickyAction>
          <Button full>Review Swap</Button>
        </StickyAction>
      </>,
    );
    const sticky = screen.getByTestId("sticky-action");
    expect(sticky.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    vv.height = 508; // the keyboard opens
    act(() => listeners.resize());
    expect(sticky.style.getPropertyValue("--keyboard-inset")).toBe("336px");
    vi.useFakeTimers();
    fireEvent.focusIn(screen.getByTestId("amount"));
    vi.advanceTimersByTime(60);
    vi.useRealTimers();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });
});
