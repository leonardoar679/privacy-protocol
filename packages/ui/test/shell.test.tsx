// @vitest-environment happy-dom
// The shell's layout (spec v2.0 §6; doc §11–§12, §88): one bar at a time — on a phone the bottom bar with four items
// after <main>; from 1024 px the top bar before <main> (V5 drew the desktop navigation after the content) with three
// items and the Wallet menu, whose panel opens, closes on Escape (focus back on its button) and on a click outside.
// The pixels themselves (which bar shows where) are checked in the browser: tests/visual.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppShell, ListRow, type NavItem, type ShellNav } from "../src/index";

const items: NavItem[] = [
  { to: "/", label: "Home", icon: "home", testId: "nav-home" },
  { to: "/swap", label: "Swap", icon: "swap", testId: "nav-swap" },
  { to: "/activity", label: "Activity", icon: "activity", testId: "nav-activity" },
  { to: "/more", label: "More", icon: "more", testId: "nav-more" },
];
const nav = (onSelect = vi.fn()): ShellNav => ({
  brand: "Privacy Wallet",
  items,
  desktopItems: items.slice(0, 3),
  current: "/swap",
  onSelect,
  label: "Main",
  menu: { label: "Wallet", icon: "wallet", testId: "nav-wallet", content: (close) => <ListRow title="Privacy Center" onPress={close} testId="menu-privacy" /> },
});
const at = (width: number) => ((globalThis as { __TEST_VIEWPORT_WIDTH__?: number }).__TEST_VIEWPORT_WIDTH__ = width);

afterEach(() => {
  delete (globalThis as { __TEST_VIEWPORT_WIDTH__?: number }).__TEST_VIEWPORT_WIDTH__;
});

describe("the shell (spec v2.0 §6)", () => {
  it("a phone: <main>, then the bottom bar with four items, the current one marked; no top bar", () => {
    at(390);
    const onSelect = vi.fn();
    render(
      <AppShell nav={nav(onSelect)}>
        <p>Content</p>
      </AppShell>,
    );
    const main = screen.getByRole("main");
    const bottom = screen.getByTestId("bottom-navigation");
    expect(main.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("app-bar")).toBeNull();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect([...bottom.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Home", "Swap", "Activity", "More"]);
    expect(screen.getByTestId("nav-swap")).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByTestId("nav-activity"));
    expect(onSelect).toHaveBeenCalledWith("/activity");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
  });

  it("from 1024 px: the top bar before <main> with Home · Swap · Activity and the Wallet menu; no bottom bar", () => {
    for (const width of [1024, 1440]) {
      at(width);
      const onSelect = vi.fn();
      const { unmount } = render(
        <AppShell nav={nav(onSelect)}>
          <p>Content</p>
        </AppShell>,
      );
      const bar = screen.getByTestId("app-bar");
      const main = screen.getByRole("main");
      expect(bar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByTestId("bottom-navigation")).toBeNull();
      expect(screen.getAllByRole("navigation")).toHaveLength(1);
      expect([...screen.getByTestId("top-navigation").querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Home", "Swap", "Activity"]);
      expect(screen.getByTestId("top-nav-swap")).toHaveAttribute("aria-current", "page");
      expect(screen.getByTestId("nav-wallet")).toHaveTextContent("Wallet");
      fireEvent.click(screen.getByTestId("top-nav-activity"));
      expect(onSelect).toHaveBeenCalledWith("/activity");
      unmount();
    }
  });

  it("the Wallet menu: opens its panel, closes on Escape with the focus back on its button, on a click outside and on a choice", () => {
    at(1440);
    render(
      <AppShell nav={nav()}>
        <button type="button">Elsewhere</button>
      </AppShell>,
    );
    const button = screen.getByTestId("nav-wallet");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("nav-wallet-panel")).toHaveAttribute("id", button.getAttribute("aria-controls")!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("nav-wallet-panel")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByTestId("nav-wallet-panel")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByTestId("menu-privacy"));
    expect(screen.queryByTestId("nav-wallet-panel")).toBeNull();
  });

  it("without navigation (the onboarding screens) the shell is the content alone", () => {
    render(
      <AppShell>
        <p>Welcome</p>
      </AppShell>,
    );
    expect(screen.queryByTestId("app-bar")).toBeNull();
    expect(screen.queryByTestId("bottom-navigation")).toBeNull();
    expect(screen.getByRole("main")).toHaveTextContent("Welcome");
  });
});
