// @vitest-environment jsdom
// Sheets, dialogs, the confirmation and toasts (spec §2, §3.9, §5): a sheet is a dialog the back button closes,
// a dangerous dialog is marked, the confirmation is a tap or a hold and never fires twice, a toast announces.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssetSelector, BottomSheet, Button, ConfirmSheet, Modal, ToastProvider, useToast } from "@privacy-wallet/ui";

function ToastButton() {
  const toast = useToast();
  return <Button onClick={() => toast({ kind: "success", title: "Quote updated", body: "Still the same minimum." })}>Notify</Button>;
}

describe("sheets, dialogs, confirmation, toasts (spec §2, §3.9, §5)", () => {
  it("BottomSheet: a dialog with its title, closed by Escape, by the close control and by the back button", async () => {
    const onClose = vi.fn();
    render(<BottomSheet open onClose={onClose} title="A sheet" description="Closes on back."><p>Content</p></BottomSheet>);
    const dialog = await screen.findByRole("dialog", { name: "A sheet" });
    expect(dialog).toHaveAttribute("data-variant", "sheet");
    expect(dialog).toHaveTextContent("Content");
    expect((history.state as { dsSheet?: string })?.dsSheet).toBe("sheet");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it("closing a sheet from the app pops the history entry it pushed", async () => {
    const before = history.length;
    const { rerender } = render(<BottomSheet open onClose={() => undefined} title="A sheet" id="two"><p>x</p></BottomSheet>);
    await screen.findByRole("dialog");
    expect((history.state as { dsSheet?: string })?.dsSheet).toBe("two");
    const back = vi.spyOn(history, "back");
    rerender(<BottomSheet open={false} onClose={() => undefined} title="A sheet" id="two"><p>x</p></BottomSheet>);
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
    expect(history.length).toBeGreaterThanOrEqual(before);
  });
  it("Modal: centered, marked dangerous, with an accessible description when none is given", async () => {
    render(<Modal open onClose={() => undefined} title="Forget this wallet?" danger><p>Gone.</p></Modal>);
    const dialog = await screen.findByRole("dialog", { name: "Forget this wallet?" });
    expect(dialog).toHaveAttribute("data-danger");
    expect(dialog).toHaveAttribute("data-variant", "center");
    expect(dialog).toHaveAttribute("aria-describedby");
  });
  it("ConfirmSheet (tap): one confirmation per tap; cancel closes", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmSheet open mode="tap" title="Review Send" summary={<p>2,500 USDC</p>} onConfirm={onConfirm} onCancel={onCancel} />);
    await screen.findByRole("dialog", { name: "Review Send" });
    fireEvent.click(screen.getByTestId("confirm-tap"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("ConfirmSheet (hold): releasing early cancels; a full hold confirms once; a reason disables it", async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<ConfirmSheet open mode="hold" holdMs={40} title="Review Swap" summary={<p>$80,000</p>} onConfirm={onConfirm} onCancel={() => undefined} />);
    await screen.findByRole("dialog", { name: "Review Swap" });
    const hold = screen.getByTestId("hold-to-confirm");
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    await new Promise((r) => setTimeout(r, 70));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<ConfirmSheet open mode="hold" holdMs={40} title="Review Swap" summary={<p>$80,000</p>} onConfirm={onConfirm} onCancel={() => undefined} disabledReason="The quote expired." />);
    expect(screen.getByTestId("hold-to-confirm")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("The quote expired.");
  });
  it("Toast: pushed from anywhere below the provider, announced with its title", async () => {
    render(<ToastProvider><ToastButton /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    const toast = await screen.findByTestId("toast");
    expect(toast).toHaveTextContent("Quote updated");
    expect(toast).toHaveTextContent("Still the same minimum.");
  });
  it("AssetSelector (plan §53): a searchable list of monogram, symbol, name and balance; choosing closes", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<AssetSelector open onClose={onClose} onChange={onChange} assets={[{ id: "eth", symbol: "ETH", name: "Ethereum", balance: "4.82", address: "0xeeee" }, { id: "usdc", symbol: "USDC", name: "USD Coin", balance: "12,400" }, { id: "btc", symbol: "BTC", name: "Bitcoin", chain: "Bitcoin" }]} />);
    await screen.findByRole("dialog", { name: "Choose asset" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("dialog")).not.toHaveTextContent("0xeeee");
    fireEvent.change(screen.getByTestId("asset-selector-search"), { target: { value: "bit" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option"));
    expect(onChange).toHaveBeenCalledWith("btc");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
