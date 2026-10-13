// @vitest-environment happy-dom
// The component inventory (spec §5): each component renders its states with the right roles and names, the fee
// summary is collapsed by default, the amount input keeps a decimal string, the address input shows its checks.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddressInput, AmountInput, BalanceCard, BottomNav, Button, Collapsible, FeeSummary, Field, Progress, Segmented, StatusBadge, TextInput, TransactionTimeline, cleanAmount } from "@privacy-wallet/ui";

describe("the design-system components (spec §5)", () => {
  it("Button: a label, a busy state that disables it, an icon", () => {
    const { rerender } = render(<Button icon="send">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    rerender(<Button loading>Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-busy", "true");
  });
  it("FeeSummary (plan §22): one number by default, the lines behind View fee details", () => {
    render(<FeeSummary receive={{ label: "You'll receive", value: "$9,886" }} pay={{ label: "You pay", value: "$10,000" }} total="$114" lines={[{ label: "Privacy fee (1.00 %)", value: "$100.00" }, { label: "Relayer / network", value: "$5.80", hint: "included" }, { label: "Swap / provider", value: "$8.20" }]} />);
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
  it("AmountInput: a decimal string in the asset's precision, the common sizes, Max", () => {
    const onChange = vi.fn();
    const onMax = vi.fn();
    render(<AmountInput id="a" label="Amount" asset={{ symbol: "USDC", decimals: 2 }} value="" onChange={onChange} buckets={[{ label: "1,000", value: "1000" }]} onMax={onMax} usd="≈ $0" />);
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
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
  it("AddressInput (plan §16): the four checks with their state, paste, the address book", async () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(<AddressInput id="to" label="To" value="" onChange={onChange} onPaste={() => "0xabc"} checks={[{ label: "Valid address", state: "ok" }, { label: "Correct network", state: "fail", detail: "this is a Bitcoin address" }, { label: "Token supported", state: "pending" }, { label: "Destination format valid", state: "idle" }]} book={[{ id: "b1", label: "Savings", address: "0x43" }]} onPickEntry={onPick} />);
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
    render(<Field label="Password" htmlFor="pw" error="Too short"><TextInput id="pw" invalid /></Field>);
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
  });
  it("TransactionTimeline: one item per step with its state, the active one current", () => {
    render(<TransactionTimeline steps={[{ label: "Quote locked", state: "done" }, { label: "Source confirmed", state: "active", detail: "12:04" }, { label: "Destination sent", state: "waiting" }, { label: "Destination finalized", state: "failed" }]} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "active", "waiting", "failed"]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[1]).toHaveTextContent("12:04");
  });
  it("Collapsible and Progress: aria-expanded and aria-valuenow", () => {
    render(<><Collapsible summary="View details"><p>Hidden</p></Collapsible><Progress value={0.6} label="Generating proof" /><Progress value={null} label="Preparing" testId="indeterminate" /></>);
    const toggle = screen.getByRole("button", { name: "View details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Hidden")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Hidden")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Generating proof" })).toHaveAttribute("aria-valuenow", "60");
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
    render(<><Segmented value="asset" onChange={onChange} ariaLabel="Amount in" options={[{ value: "asset", label: "USDC" }, { value: "usd", label: "USD" }]} /><StatusBadge tone="warn" testId="s">Needs attention</StatusBadge></>);
    expect(screen.getByRole("radiogroup", { name: "Amount in" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "USDC" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "USD" }));
    expect(onChange).toHaveBeenCalledWith("usd");
    expect(screen.getByTestId("s")).toHaveAttribute("data-tone", "warn");
  });
  it("BottomNav: four links, the current one marked, selection handled in the app", () => {
    const onSelect = vi.fn();
    render(<BottomNav current="/swap/review" onSelect={onSelect} items={[{ to: "/", label: "Home", icon: "home" }, { to: "/swap", label: "Swap", icon: "swap" }, { to: "/activity", label: "Activity", icon: "activity" }, { to: "/more", label: "More", icon: "more" }]} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Swap", "Activity", "More"]);
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(links[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(links[2]);
    expect(onSelect).toHaveBeenCalledWith("/activity");
  });
});
