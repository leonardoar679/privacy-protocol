// @vitest-environment happy-dom
// The component inventory (spec v2.0 §5; doc §9–§10): each component renders its states with the right roles and names
// — the three button levels and the text button, the cards, the inputs (decimal amounts, addresses without
// autocorrection), the bottom bar's four items, one protection mark —, the fee summary collapsed by default.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AddressInput,
  AmountInput,
  BalanceCard,
  BottomNavigation,
  Button,
  Collapsible,
  FeeSummary,
  Field,
  Input,
  ProgressIndicator,
  ProtectionBadge,
  QuoteCard,
  Segmented,
  StatusBadge,
  SuccessCard,
  TextButton,
  TransactionTimeline,
  WarningCard,
  cleanAmount,
} from "../src/index";

describe("the design-system components (spec v2.0 §5)", () => {
  it("Button: a label, a busy state that disables it, an icon; three levels only, and a text button", () => {
    const { rerender } = render(<Button icon="send">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("data-variant", "primary");
    rerender(<Button loading>Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "true");
    rerender(
      <>
        <Button variant="secondary">View Details</Button>
        <Button variant="destructive">Remove Data</Button>
        <TextButton>Compare routes</TextButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "View Details" })).toHaveClass("ds-btn-secondary");
    expect(screen.getByRole("button", { name: "Remove Data" })).toHaveClass("ds-btn-destructive");
    expect(screen.getByRole("button", { name: "Compare routes" })).toHaveAttribute("data-variant", "text");
    expect(screen.getByRole("button", { name: "Compare routes" })).not.toHaveClass("ds-btn");
  });

  it("WarningCard and SuccessCard: a titled region, the body, the actions", () => {
    render(
      <>
        <WarningCard title="This route takes longer" body="About 40 minutes." action={<TextButton>Why?</TextButton>} />
        <SuccessCard
          title="Swap completed"
          body="2.31 ETH is protected."
          details={<span>Details</span>}
          actions={<Button variant="secondary">View details</Button>}
        />
      </>,
    );
    expect(screen.getByTestId("warning")).toHaveTextContent("This route takes longer");
    expect(screen.getByTestId("warning")).toHaveTextContent("About 40 minutes.");
    expect(screen.getByRole("heading", { name: "Swap completed" })).toBeInTheDocument();
    expect(screen.getByTestId("success")).toHaveTextContent("Details");
  });

  it("ProtectionBadge draws one mark, whatever the label carries (V5 drew the shield twice)", () => {
    render(
      <>
        <ProtectionBadge level="High" label={"\u{1F6E1}️ Protected"} testId="a" />
        <ProtectionBadge level="High" label="Protected ✓" testId="b" />
        <QuoteCard
          quote={{ pay: "1", receive: "2", minimum: "1.9", fees: "$1", time: "2 min", protection: "High", route: "Best" }}
          labels={{ pay: "Pay", receive: "Receive", minimum: "Minimum", fees: "Fees", time: "Time", protection: "Protected" }}
        />
      </>,
    );
    expect(screen.getByTestId("a")).toHaveTextContent(/^Protected$/);
    expect(screen.getByTestId("b")).toHaveTextContent(/^Protected$/);
    for (const badge of [screen.getByTestId("a"), screen.getByTestId("b"), screen.getByTestId("protection-badge")])
      expect(badge.querySelectorAll("svg")).toHaveLength(1);
  });

  it("FeeSummary: one number by default, the lines behind View fee details", () => {
    render(
      <FeeSummary
        receive={{ label: "You'll receive", value: "$9,886" }}
        pay={{ label: "You pay", value: "$10,000" }}
        total="$114"
        lines={[
          { label: "Privacy fee (1.00 %)", value: "$100.00" },
          { label: "Relayer / network", value: "$5.80", hint: "included" },
          { label: "Swap / provider", value: "$8.20" },
        ]}
      />,
    );
    expect(screen.getByTestId("fees-receive")).toHaveTextContent("$9,886");
    expect(screen.getByTestId("fees-total")).toHaveTextContent("$114");
    const toggle = screen.getByTestId("fees-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("fees-lines")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("fees-lines").querySelectorAll("dt")).toHaveLength(3);
    expect(screen.getByTestId("fees-lines")).toHaveTextContent("included");
  });

  it("AmountInput: a decimal string in the asset's precision, inputmode decimal (never type=number), the common sizes, Max", () => {
    const onChange = vi.fn();
    const onMax = vi.fn();
    render(
      <AmountInput
        id="a"
        label="Amount"
        asset={{ symbol: "USDC", decimals: 2 }}
        value=""
        onChange={onChange}
        buckets={[{ label: "1,000", value: "1000" }]}
        onMax={onMax}
        usd="≈ $0"
      />,
    );
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).not.toHaveAttribute("type", "number");
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(onChange).toHaveBeenLastCalledWith("1.5");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.change(input, { target: { value: "1.555" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("amount-bucket"));
    expect(onChange).toHaveBeenLastCalledWith("1000");
    fireEvent.click(screen.getByTestId("amount-max"));
    expect(onMax).toHaveBeenCalledTimes(1);
    expect(cleanAmount("1,234.5", 6)).toBe("1234.5");
    expect(cleanAmount(".5", 6)).toBe(".5");
    expect(cleanAmount("1.", 6)).toBe("1.");
    expect(cleanAmount("1e5", 6)).toBeNull();
    expect(cleanAmount("", 6)).toBe("");
  });

  it("AddressInput: inputmode text without autocorrection, the four checks with their state, paste, the address book", async () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(
      <AddressInput
        id="to"
        label="To"
        value=""
        onChange={onChange}
        onPaste={() => "0xabc"}
        checks={[
          { label: "Valid address", state: "ok" },
          { label: "Correct network", state: "fail", detail: "this is a Bitcoin address" },
          { label: "Token supported", state: "pending" },
          { label: "Not your address", state: "idle" },
        ]}
        book={[{ id: "b1", label: "Savings", address: "0xdef" }]}
        onPickEntry={onPick}
      />,
    );
    const field = screen.getByTestId("address-input");
    for (const [attr, value] of [
      ["inputmode", "text"],
      ["autocapitalize", "off"],
      ["autocorrect", "off"],
      ["spellcheck", "false"],
    ])
      expect(field).toHaveAttribute(attr, value);
    const items = screen.getByTestId("address-checks").querySelectorAll("li");
    expect([...items].map((li) => li.getAttribute("data-state"))).toEqual(["ok", "fail", "pending", "idle"]);
    expect(items[1]).toHaveTextContent("this is a Bitcoin address");
    fireEvent.click(screen.getByTestId("address-paste"));
    await screen.findByTestId("address-input");
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith("0xabc");
    fireEvent.click(screen.getByTestId("address-book-entry"));
    expect(onPick).toHaveBeenCalledWith("b1");
  });

  it("Field links its label to the control and announces an error", () => {
    render(
      <Field label="Password" htmlFor="pw" error="Too short">
        <Input id="pw" invalid />
      </Field>,
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
  });

  it("TransactionTimeline: one item per step with its state, the active one current", () => {
    render(
      <TransactionTimeline
        steps={[
          { label: "Quote locked", state: "done" },
          { label: "Source confirmed", state: "active", detail: "12:04" },
          { label: "Destination sent", state: "waiting" },
          { label: "Destination finalized", state: "failed" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "active", "waiting", "failed"]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[1]).toHaveTextContent("12:04");
  });

  it("Collapsible and ProgressIndicator: aria-expanded and aria-valuenow", () => {
    render(
      <>
        <Collapsible summary="View details">
          <p>Hidden</p>
        </Collapsible>
        <ProgressIndicator value={0.6} label="Securing your transaction" />
        <ProgressIndicator value={null} label="Preparing" testId="indeterminate" />
      </>,
    );
    const toggle = screen.getByRole("button", { name: "View details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Hidden")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Hidden")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Securing your transaction" })).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByTestId("indeterminate")).not.toHaveAttribute("aria-valuenow");
  });

  it("BalanceCard: a live region, a dash while unknown, the status badge", () => {
    const { rerender } = render(<BalanceCard label="Protected balance" amountUsd={null} status="loading" />);
    expect(screen.getByTestId("balance-amount")).toHaveTextContent("—");
    expect(screen.getByTestId("balance-amount")).toHaveAttribute("aria-live", "polite");
    rerender(<BalanceCard label="Protected balance" amountUsd="$24,382.41" status="protected" statusLabel="Protected" onStatus={() => undefined} />);
    expect(screen.getByTestId("balance-amount")).toHaveTextContent("$24,382.41");
    expect(screen.getByTestId("protection-badge")).toHaveAttribute("data-level", "High");
  });

  it("Segmented is a radio group; StatusBadge carries its tone", () => {
    const onChange = vi.fn();
    render(
      <>
        <Segmented
          value="asset"
          onChange={onChange}
          ariaLabel="Amount in"
          options={[
            { value: "asset", label: "USDC" },
            { value: "usd", label: "USD" },
          ]}
        />
        <StatusBadge tone="warn" testId="s">
          Needs attention
        </StatusBadge>
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Amount in" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "USDC" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "USD" }));
    expect(onChange).toHaveBeenCalledWith("usd");
    expect(screen.getByTestId("s")).toHaveAttribute("data-tone", "warn");
  });

  it("BottomNavigation: four links, the current one marked, selection handled in the app — never a fifth", () => {
    const onSelect = vi.fn();
    render(
      <BottomNavigation
        current="/swap/review"
        onSelect={onSelect}
        items={[
          { to: "/", label: "Home", icon: "home" },
          { to: "/swap", label: "Swap", icon: "swap" },
          { to: "/activity", label: "Activity", icon: "activity" },
          { to: "/more", label: "More", icon: "more" },
          { to: "/extra", label: "Extra", icon: "gear" },
        ]}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Swap", "Activity", "More"]);
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(links[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(links[2]);
    expect(onSelect).toHaveBeenCalledWith("/activity");
  });
});
