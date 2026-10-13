// @vitest-environment jsdom
// Accessibility (spec v2.0 §18–§19): the component preview — every component and pattern in its states — passes axe
// with no violation. Colour contrast is checked on the tokens (tokens.test.ts) and in the browser (tests/visual): jsdom
// has no layout; the landmark rules are page-level and checked on the screens.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { Preview, PREVIEW_SECTIONS, PREVIEW_SENTINEL } from "../src/Preview";
import { ICON_NAMES } from "../src/index";

describe("the component preview is accessible (spec v2.0 §18)", () => {
  it("renders every section, every icon, and carries the sentinel the production build is checked for", () => {
    render(<Preview />);
    expect(screen.getByTestId("preview")).toHaveAttribute("data-preview", PREVIEW_SENTINEL);
    const sections = [...document.querySelectorAll("[data-preview-section]")].map((s) => s.getAttribute("data-preview-section"));
    expect(sections).toEqual([...PREVIEW_SECTIONS]);
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(40);
  });

  it("has no axe violations", async () => {
    const { container } = render(<Preview />);
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
        "landmark-one-main": { enabled: false },
        "page-has-heading-one": { enabled: false },
      },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }, 60_000);
});
