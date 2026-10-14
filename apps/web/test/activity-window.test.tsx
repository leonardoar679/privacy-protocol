// @vitest-environment jsdom
// Activity windowed (spec v2.0 §19; doc §89 Step 20; V6 Stage 16): a long history renders a page at a time — the first
// 50 rows, the next page when the end comes near (an IntersectionObserver on a sentinel) or when the reader asks ("Show
// earlier activity", reachable from the keyboard); a day's header shows with its first shown row; a short history has
// nothing to page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ACTIVITY_PAGE, ActivityView, type ActivityModel } from "../src/features/activity/View";

const g = globalThis as { IntersectionObserver?: unknown };
const original = g.IntersectionObserver;
afterEach(() => {
  cleanup();
  g.IntersectionObserver = original;
});

const usdc = (units: bigint) => ({ units, symbol: "USDC", decimals: 6, displayDecimals: 2 });
/** `days` groups of `per` rows each. */
function history(days: number, per: number): ActivityModel {
  return {
    groups: Array.from({ length: days }, (_, d) => ({
      key: `d${d}`,
      label: `Day ${d}`,
      rows: Array.from({ length: per }, (_, i) => ({
        id: `r${d}-${i}`,
        icon: "swap" as const,
        title: "USDC → ETH",
        amount: usdc(1_000_000n),
        usdCents: 100n,
        status: "completed" as const,
      })),
    })),
  };
}

describe("Activity windowed (doc §89 Step 20)", () => {
  it("renders the first page, then the next one asked for; a day's header shows with its first shown row", () => {
    render(<ActivityView model={history(3, 60)} onOpen={vi.fn()} />);
    expect(ACTIVITY_PAGE).toBe(50);
    expect(screen.getAllByTestId("activity-row")).toHaveLength(50);
    expect(screen.getAllByTestId("activity-day").map((h) => h.textContent)).toEqual(["Day 0"]);
    const more = screen.getByTestId("activity-more");
    expect(more).toHaveTextContent("Show earlier activity (130 more)");
    expect(more.tagName).toBe("BUTTON");
    fireEvent.click(more);
    expect(screen.getAllByTestId("activity-row")).toHaveLength(100);
    expect(screen.getAllByTestId("activity-day").map((h) => h.textContent)).toEqual(["Day 0", "Day 1"]);
    fireEvent.click(screen.getByTestId("activity-more"));
    fireEvent.click(screen.getByTestId("activity-more"));
    expect(screen.getAllByTestId("activity-row")).toHaveLength(180);
    expect(screen.queryByTestId("activity-more"), "the whole history: nothing left to page").toBeNull();
  });

  it("the next page comes as the end nears (an observer on a sentinel, 600 px ahead)", () => {
    let fire: (() => void) | null = null;
    const observed: Element[] = [];
    g.IntersectionObserver = class {
      constructor(
        cb: (entries: { isIntersecting: boolean }[]) => void,
        readonly options: { rootMargin?: string },
      ) {
        expect(options.rootMargin).toBe("600px 0px");
        fire = () => cb([{ isIntersecting: true }]);
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    };
    render(<ActivityView model={history(2, 70)} onOpen={vi.fn()} />);
    expect(observed[0]).toBe(screen.getByTestId("activity-sentinel"));
    expect(screen.getAllByTestId("activity-row")).toHaveLength(50);
    act(() => fire!());
    expect(screen.getAllByTestId("activity-row")).toHaveLength(100);
    act(() => fire!());
    expect(screen.getAllByTestId("activity-row")).toHaveLength(140);
    expect(screen.queryByTestId("activity-sentinel")).toBeNull();
  });

  it("a short history has nothing to page", () => {
    render(<ActivityView model={history(2, 10)} onOpen={vi.fn()} />);
    expect(screen.getAllByTestId("activity-row")).toHaveLength(20);
    expect(screen.queryByTestId("activity-more")).toBeNull();
    expect(screen.queryByTestId("activity-sentinel")).toBeNull();
  });
});
