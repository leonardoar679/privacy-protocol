// @vitest-environment jsdom
// Accessibility (spec §19): the gallery — every component in every state — passes axe with no violation. Colour
// contrast is a browser check (jsdom has no layout); the landmark rules are page-level and checked on the screens.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { Gallery } from "../../src/design-system/Gallery";
import { ICON_NAMES } from "../../src/design-system";

describe("the gallery is accessible (spec §19)", () => {
  it("renders every section and icon", () => {
    render(<Gallery />);
    expect(screen.getByTestId("gallery")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["Buttons", "Money", "Inputs", "Status", "Sheets", "Icons"]));
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(40);
  });
  it("has no axe violations", async () => {
    const { container } = render(<Gallery />);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false }, "landmark-one-main": { enabled: false }, "page-has-heading-one": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }, 60_000);
});
