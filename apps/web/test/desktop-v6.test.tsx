// @vitest-environment jsdom
// The desktop (spec v2.0 §6; doc §54, §88; V6 Stage 16): from 1024 px Home shows the balance, the tiles Protect | Send |
// Swap (the one primary first), then two columns — Protected assets | Recent activity —; the Swap card has its route
// details beside it, open (the Advanced experience); and every action a 390 px screen offers is there at 1440 px, for
// every fixture state (the browser harness checks the same with layout, tests/visual/run.mjs).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { FIXTURES } from "../src/fixtures/registry";

const viewport = (w?: number) => {
  const g = globalThis as { __TEST_VIEWPORT_WIDTH__?: number };
  if (w === undefined) delete g.__TEST_VIEWPORT_WIDTH__;
  else g.__TEST_VIEWPORT_WIDTH__ = w;
};
afterEach(() => {
  cleanup();
  viewport();
});

const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;
const actionsOf = (root: HTMLElement) =>
  [...root.querySelectorAll("button[data-testid], a[data-testid], input[data-testid]")].map((e) => e.getAttribute("data-testid")!);
// the bottom bar's items become the top bar and the Wallet menu (as the harness maps them)
const BAR: Record<string, string> = { "nav-home": "top-nav-home", "nav-swap": "top-nav-swap", "nav-activity": "top-nav-activity", "nav-more": "nav-wallet" };

describe("the desktop (doc §54, §88)", () => {
  it("Home from 1024 px: the balance, the tiles Protect | Send | Swap, then Protected assets | Recent activity", () => {
    viewport(1440);
    render(<>{fixture("home-funded").render()}</>);
    const home = screen.getByTestId("home");
    const tiles = screen.getByTestId("home-tiles");
    expect([...tiles.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["protect-cta", "home-send", "home-swap"]);
    expect(screen.getByTestId("protect-cta")).toHaveAttribute("data-variant", "primary");
    expect(home.querySelectorAll('[data-variant="primary"]'), "one primary action").toHaveLength(1);
    const columns = home.querySelector(".ds-columns")!;
    const [left, right] = [...columns.children] as HTMLElement[];
    expect(within(left).getByTestId("assets")).toHaveTextContent("Protected assets");
    expect(within(left).getAllByTestId("asset-row")).toHaveLength(3);
    expect(within(right).getByTestId("recent")).toHaveTextContent("Recent activity");
    expect(within(right).getAllByTestId("recent-row")).toHaveLength(3);
    // the order on the page: the balance, the tiles, the columns
    const order = [screen.getByTestId("balance"), tiles, columns];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Home with nothing protected: the Protected assets column says how to start; Recent activity says there is none yet", () => {
    viewport(1440);
    render(<>{fixture("home-empty").render()}</>);
    expect(screen.queryByTestId("assets")).toBeNull();
    expect(screen.getByTestId("protect-card")).toHaveTextContent("Protected assets");
    expect(screen.getByTestId("protect-card")).toHaveTextContent("Protect your assets");
    expect(screen.getByTestId("recent")).toHaveTextContent("Nothing here yet");
    expect(screen.getByTestId("home").querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  });

  it("Swap from 1024 px: the route details stand beside the swap card, open; on a phone they fold inside the quote", () => {
    viewport(1440);
    const desk = render(<>{fixture("swap-advanced").render()}</>);
    const details = screen.getByTestId("swap-route-details");
    expect(details).toHaveTextContent("Route details");
    expect(details).toHaveTextContent("THORChain");
    const columns = screen.getByTestId("swap-view").querySelector(".ds-columns")!;
    expect(columns.children[0]).toContainElement(screen.getByTestId("swap-quote"));
    expect(columns.children[1]).toContainElement(details);
    expect(screen.getByTestId("swap-route-details-toggle"), "open, and still foldable (the phone's action)").toHaveAttribute("aria-expanded", "true");
    desk.unmount();
    viewport(390);
    render(<>{fixture("swap-advanced").render()}</>);
    expect(screen.getByTestId("swap-quote")).toContainElement(screen.getByTestId("swap-route-details"));
    expect(screen.getByTestId("swap-route-details-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("swap-route-details")).not.toHaveTextContent("THORChain");
  });

  it("every action a 390 px screen offers is there at 1440 px — every fixture state (doc §88)", () => {
    const screens = FIXTURES.filter((f) => f.kind === "screen" && !f.before);
    expect(screens.length).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const f of screens) {
      viewport(390);
      const phone = render(<>{f.render()}</>);
      const onPhone = actionsOf(phone.container).map((id) => BAR[id] ?? id);
      phone.unmount();
      viewport(1440);
      const desk = render(<>{f.render()}</>);
      const onDesk = actionsOf(desk.container);
      desk.unmount();
      const lacking = [...new Set(onPhone.filter((id) => !onDesk.includes(id)))];
      if (lacking.length) missing.push(`${f.id}: ${lacking.join(", ")}`);
    }
    expect(missing).toEqual([]);
  });
});
