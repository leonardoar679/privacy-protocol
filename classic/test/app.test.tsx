// @vitest-environment happy-dom
// The Classic app's root (V7 Stage 2): the "Not connected" words of spec v3.0 §7.7 on every build until a pool function
// is switched live; no promise word anywhere on the page.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App, NOT_CONNECTED } from "../src/app/App";
import { applyConfig, configFromEnv } from "../src/config";
import { scan } from "../scripts/words.mjs";

describe("the Classic app's root", () => {
  it("shows the Not connected words and names the chain; says no promise word", () => {
    applyConfig(configFromEnv({}));
    render(<App />);
    expect(screen.getByTestId("classic-not-connected")).toHaveTextContent(NOT_CONNECTED);
    expect(screen.getByTestId("classic-not-connected")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("classic-stage")).toHaveTextContent("chain 1");
    expect(scan(document.body.textContent ?? "")).toEqual([]);
  });
});
