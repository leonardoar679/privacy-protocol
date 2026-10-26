// @vitest-environment happy-dom
// The Classic app's root (V7 Stage 3): the "Not connected" words of spec v3.0 §7.7 on the first screen of every build
// until a pool function is switched live; the original's two tabs; no promise word on the page.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App, NOT_CONNECTED } from "../src/app/App";
import { resetRoute } from "../src/app/router";
import { applyConfig, configFromEnv } from "../src/config";
import { mockSource } from "../src/model/mock";
import { scan } from "../scripts/words.mjs";

describe("the Classic app's root", () => {
  it("opens on the deposit tab with the Not connected words, the two tabs and no promise word", () => {
    applyConfig(configFromEnv({}));
    window.history.replaceState(null, "", "/classic/");
    resetRoute();
    render(<App source={mockSource({ now: 1_793_361_600 })} now={1_793_361_600} />);
    expect(NOT_CONNECTED).toBe("Not connected — interface prototype. Live contract, note-generation and transaction functionality is subject to verification.");
    expect(screen.getByTestId("classic-not-connected")).toHaveTextContent(NOT_CONNECTED);
    expect(screen.getByTestId("classic-not-connected")).toHaveAttribute("role", "status");
    expect(screen.getByRole("tab", { name: "Deposit" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Withdraw" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("classic-deposit")).toBeInTheDocument();
    expect(screen.getByTestId("classic-statistics")).toBeInTheDocument();
    expect(scan(document.body.textContent ?? "")).toEqual([]);
  });
});
