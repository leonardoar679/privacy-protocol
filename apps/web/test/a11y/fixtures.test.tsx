// @vitest-environment jsdom
// Accessibility of every fixture state (spec v2.0 §18; doc §77; V6 Stage 16): axe on each (colour contrast, the 200 %
// text and the forced colours are the browser harness's — jsdom has no layout); the keyboard alone through Protect,
// Send and Swap to their Review; the hold held from the keyboard, and its alternative — "Confirm without holding", a
// dialog: the same deliberate second step, never one tap — for a reader who cannot hold; a sheet keeps the focus
// inside and gives it back; the state changes are live regions.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { BottomSheet, Button } from "@privacy-wallet/ui";
import { FIXTURES } from "../../src/fixtures/registry";
import { ProtectView } from "../../src/features/protect/View";
import { SendView } from "../../src/features/send/View";
import { SwapView } from "../../src/features/swap/View";
import { ReviewView } from "../../src/features/review/View";
import { PROTECT_FIXTURES, REVIEW_FIXTURES, SEND_FIXTURES, SWAP_FIXTURES } from "../../src/features/flowFixtures";

afterEach(() => cleanup());
const RULES = { rules: { "color-contrast": { enabled: false } } };
async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, RULES);
  return results.violations.map(
    (v) =>
      `${v.id}: ${v.help} — ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(", ")}`,
  );
}
/** Presses Tab until `target` has the focus (at most 40 times): the keyboard alone reaches it. */
async function tabTo(user: UserEvent, target: Element): Promise<void> {
  for (let i = 0; i < 40 && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement, `${target.getAttribute("data-testid") ?? target.tagName} is reachable with Tab`).toBe(target);
}

describe("accessibility of every fixture state (doc §77)", () => {
  it("axe finds no violation on any fixture state", async () => {
    const found: string[] = [];
    const states = FIXTURES.filter((f) => f.kind === "screen");
    expect(states.length).toBeGreaterThan(30);
    for (const f of states) {
      const { unmount } = render(<>{f.render()}</>);
      const v = await violations();
      if (v.length) found.push(`${f.id}: ${v.join("; ")}`);
      unmount();
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("Protect with the keyboard alone: Tab reaches the amount and Review; typing sets the amount; Enter reviews", async () => {
    const user = userEvent.setup();
    const a = { onAmount: vi.fn(), onAsset: vi.fn(), onMax: vi.fn(), onReview: vi.fn(), onBack: vi.fn() };
    render(<ProtectView model={PROTECT_FIXTURES.filled} actions={a} />);
    await tabTo(user, screen.getByTestId("amount-input"));
    await user.keyboard("1");
    expect(a.onAmount).toHaveBeenCalled();
    await tabTo(user, screen.getByTestId("protect-review"));
    await user.keyboard("{Enter}");
    expect(a.onReview).toHaveBeenCalledTimes(1);
  });

  it("Send with the keyboard alone: the amount, the recipient, Review", async () => {
    const user = userEvent.setup();
    const a = { onAmount: vi.fn(), onTo: vi.fn(), onExact: vi.fn(), onReview: vi.fn(), onBack: vi.fn() };
    render(<SendView model={SEND_FIXTURES.evm} actions={a} />);
    await tabTo(user, screen.getByLabelText("Amount"));
    await user.keyboard("2");
    expect(a.onAmount).toHaveBeenCalled();
    await tabTo(user, screen.getByLabelText("To"));
    await user.keyboard("0");
    expect(a.onTo).toHaveBeenCalled();
    await tabTo(user, screen.getByTestId("send-review"));
    await user.keyboard(" ");
    expect(a.onReview).toHaveBeenCalledTimes(1);
  });

  it("Swap with the keyboard alone: the amount, the assets, Review Swap", async () => {
    const user = userEvent.setup();
    const a = { onAmount: vi.fn(), onPayAsset: vi.fn(), onReceiveAsset: vi.fn(), onSwitch: vi.fn(), onReview: vi.fn(), onNewQuote: vi.fn() };
    render(<SwapView model={SWAP_FIXTURES["same-chain"]} actions={a} />);
    await tabTo(user, screen.getByTestId("amount-input"));
    await user.keyboard("5");
    expect(a.onAmount).toHaveBeenCalled();
    await tabTo(user, screen.getByRole("button", { name: /Choose the asset you receive/ }));
    await user.keyboard("{Enter}");
    expect(a.onReceiveAsset).toHaveBeenCalledTimes(1);
    await tabTo(user, screen.getByTestId("swap-review"));
    await user.keyboard("{Enter}");
    expect(a.onReview).toHaveBeenCalledTimes(1);
  });

  it("the hold from the keyboard: Space held for the hold's length confirms once; released early, nothing", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReviewView model={REVIEW_FIXTURES.large} actions={{ onConfirm, onEdit: vi.fn() }} holdMs={60} />);
    const hold = screen.getByTestId("hold-to-confirm");
    await tabTo(user, hold);
    await user.keyboard("[Space>]");
    await user.keyboard("[/Space]");
    expect(onConfirm, "released at once").not.toHaveBeenCalled();
    await user.keyboard("[Space>]");
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await user.keyboard("[/Space]");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a reader who cannot hold confirms through a dialog: Confirm without holding → the dialog's Confirm; Escape or Cancel confirms nothing", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ReviewView model={REVIEW_FIXTURES.large} actions={{ onConfirm, onEdit: vi.fn() }} holdMs={60} />);
    const alternative = screen.getByTestId("hold-to-confirm-alternative");
    expect(alternative).toHaveTextContent("Confirm without holding");
    // Escape: closed, nothing confirmed, the focus back where it was
    await tabTo(user, alternative);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Confirm without holding?" });
    expect(dialog).toHaveTextContent("This does the same as holding the button.");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement, "the focus goes back to what opened the dialog").toBe(alternative));
    // Cancel
    await user.keyboard("{Enter}");
    await user.click(within(await screen.findByRole("dialog")).getByTestId("hold-to-confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    // the dialog's Confirm, from the keyboard: once
    await user.keyboard("{Enter}");
    await tabTo(user, within(await screen.findByRole("dialog")).getByTestId("hold-to-confirm-dialog-confirm"));
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a sheet keeps the focus inside while it is open and gives it back when it closes", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)} data-testid="open-sheet">
            Open
          </Button>
          <Button data-testid="outside">Outside</Button>
          <BottomSheet open={open} onClose={() => setOpen(false)} title="Choose asset" testId="sheet">
            <Button data-testid="inside-1">One</Button>
            <Button data-testid="inside-2">Two</Button>
          </BottomSheet>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByTestId("open-sheet");
    await tabTo(user, trigger);
    await user.keyboard("{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Choose asset" });
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(sheet, `Tab ${i + 1} stays in the sheet`).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 3; i++) {
      await user.tab({ shift: true });
      expect(sheet, `Shift+Tab ${i + 1} stays in the sheet`).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement, "the focus goes back to what opened the sheet").toBe(trigger));
  });

  it("the state changes are live regions: the balance, the quote's figures, a search in progress, an error, the progress", () => {
    const home = render(<>{FIXTURES.find((f) => f.id === "home-funded")!.render()}</>);
    expect(screen.getByTestId("private-usd")).toHaveAttribute("aria-live", "polite");
    home.unmount();
    const swap = render(
      <SwapView
        model={SWAP_FIXTURES["same-chain"]}
        actions={{ onAmount: vi.fn(), onPayAsset: vi.fn(), onReceiveAsset: vi.fn(), onReview: vi.fn(), onNewQuote: vi.fn() }}
      />,
    );
    expect(screen.getByTestId("swap-quote-rows")).toHaveAttribute("aria-live", "polite");
    swap.unmount();
    const quoting = render(
      <SwapView
        model={{ ...SWAP_FIXTURES["same-chain"], quote: null, quoting: true }}
        actions={{ onAmount: vi.fn(), onPayAsset: vi.fn(), onReceiveAsset: vi.fn(), onReview: vi.fn(), onNewQuote: vi.fn() }}
      />,
    );
    expect(screen.getByTestId("swap-quoting")).toHaveAttribute("role", "status");
    quoting.unmount();
    const expired = render(<>{FIXTURES.find((f) => f.id === "swap-expired")!.render()}</>);
    expect(screen.getByTestId("swap-expired")).toHaveAttribute("role", "alert");
    expired.unmount();
    const blocked = render(<>{FIXTURES.find((f) => f.id === "review-blocked")!.render()}</>);
    expect(blocked.container.querySelector('[role="alert"]'), "the stopped transaction is announced").not.toBeNull();
    blocked.unmount();
    render(<>{FIXTURES.find((f) => f.id === "progress")!.render()}</>);
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });
});
