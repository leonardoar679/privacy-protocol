// The design tokens (spec v2.0 §5): tokens.css is generated from the tokens module and must match it; the eight type
// roles and their order; every text colour meets WCAG AA on the surfaces it is drawn on, in the light, dark and both
// high-contrast sets; the 4-point grid, the motion, the layers, the breakpoints, the 44 px target; the ten viewports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BREAKPOINTS,
  COLOR_NAMES,
  COLORS,
  ELEVATION,
  LAYOUT,
  MOTION,
  PRIMARY_VIEWPORT,
  SPACE_STEPS,
  SPACE_UNIT,
  TOKENS,
  TYPE,
  TYPE_ROLES,
  VIEWPORTS,
  Z,
  toCss,
  type ColorName,
  type Scheme,
} from "../src/tokens/index";

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("design tokens (spec v2.0 §5)", () => {
  it("tokens.css is the output of the tokens module (`npm run tokens` regenerates it)", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/tokens/tokens.css", import.meta.url)), "utf8");
    expect(css).toBe(toCss());
  });

  it("four colour sets name every token; elevation has four levels in light and dark", () => {
    for (const scheme of Object.keys(COLORS) as Scheme[]) {
      expect(Object.keys(COLORS[scheme]).sort(), scheme).toEqual([...COLOR_NAMES].sort());
      for (const v of Object.values(COLORS[scheme])) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(ELEVATION.light).toHaveLength(4);
    expect(ELEVATION.dark).toHaveLength(4);
  });

  it("every text colour meets WCAG AA (4.5:1) on the surfaces it is drawn on, in every set", () => {
    const pairs: [ColorName, ColorName][] = [
      ["fg", "bg"],
      ["fg", "surface"],
      ["fg", "surface-2"],
      ["fg-muted", "bg"],
      ["fg-muted", "surface"],
      ["accent", "surface"],
      ["accent", "bg"],
      ["accent-fg", "accent"],
      ["accent", "accent-soft"],
      ["shield", "shield-soft"],
      ["shield", "surface"],
      ["warn", "warn-soft"],
      ["danger", "danger-soft"],
      ["danger", "surface"],
      ["success", "success-soft"],
    ];
    const failures: string[] = [];
    for (const scheme of Object.keys(COLORS) as Scheme[]) {
      for (const [fg, bg] of pairs) {
        const ratio = contrast(COLORS[scheme][fg], COLORS[scheme][bg]);
        if (ratio < 4.5) failures.push(`${scheme}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
    // the high-contrast sets go further: 7:1 for the body text
    expect(contrast(COLORS.contrast.fg, COLORS.contrast.bg)).toBeGreaterThanOrEqual(7);
    expect(contrast(COLORS["contrast-dark"].fg, COLORS["contrast-dark"].bg)).toBeGreaterThanOrEqual(7);
  });

  it("the eight type roles of the spec; the text roles descend, the numeric roles are tabular; line ≥ size", () => {
    expect(TYPE_ROLES).toEqual(["display", "heading", "title", "body", "body-small", "caption", "numeric-large", "numeric-medium"]);
    const text = ["display", "heading", "title", "body", "body-small", "caption"] as const;
    for (let i = 1; i < text.length; i++) expect(TYPE[text[i]].size).toBeLessThan(TYPE[text[i - 1]].size);
    for (const r of TYPE_ROLES) expect(TYPE[r].line).toBeGreaterThanOrEqual(TYPE[r].size);
    expect(TYPE.body.size).toBe(16);
    expect(TYPE["numeric-large"].numeric && TYPE["numeric-medium"].numeric).toBe(true);
    expect(TYPE["numeric-large"].size).toBeGreaterThan(TYPE["numeric-medium"].size);
  });

  it("spacing is a 4-pt grid of sixteen steps; motion 120 / 200 / 320; layers and breakpoints ordered; 44 px targets", () => {
    expect(SPACE_UNIT).toBe(4);
    expect(SPACE_STEPS).toBe(16);
    expect([MOTION.fast, MOTION.base, MOTION.slow]).toEqual([120, 200, 320]);
    expect(Z.nav).toBeLessThan(Z.header);
    expect(Z.header).toBeLessThan(Z.sheet);
    expect(Z.sheet).toBeLessThan(Z.dialog);
    expect(Z.dialog).toBeLessThan(Z.toast);
    const bps = Object.values(BREAKPOINTS);
    for (let i = 1; i < bps.length; i++) expect(bps[i]).toBeGreaterThan(bps[i - 1]);
    expect(BREAKPOINTS.xl).toBe(1024);
    expect(LAYOUT.touch).toBe(44);
    expect(LAYOUT.wideMax).toBeGreaterThanOrEqual(1200);
    expect(LAYOUT.wideMax).toBeLessThanOrEqual(1280);
    expect(TOKENS.spacing).toEqual({ unit: 4, steps: 16 });
    expect(TOKENS.typography.roles).toBe(TYPE);
  });

  it("the ten viewports of spec §6, the primary canvas 390 × 844", () => {
    expect(VIEWPORTS.map(([w, h]) => `${w}x${h}`)).toEqual([
      "360x800",
      "375x812",
      "390x844",
      "393x852",
      "412x915",
      "430x932",
      "768x1024",
      "1024x768",
      "1280x800",
      "1440x900",
    ]);
    expect(PRIMARY_VIEWPORT).toEqual([390, 844]);
  });

  it("the stylesheet: dark mode under the query and the attribute, both high-contrast sets, forced colours, reduced motion, the legacy aliases, Inter first", () => {
    const css = toCss();
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/@media \(prefers-contrast: more\) \{/);
    expect(css).toMatch(/@media \(prefers-contrast: more\) and \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/@media \(forced-colors: active\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/--panel: var\(--surface\);/);
    expect(css).toMatch(/--muted: var\(--fg-muted\);/);
    expect(css).toMatch(/--space-16: 64px;/);
    expect(css).toMatch(/--touch: 44px;/);
    expect(css, "the type in rem: the reader's text size scales it (V6 Stage 16)").toMatch(/--numeric-large-size: 2.25rem;/);
    expect(css).toMatch(/--body-size: 1rem;/);
    expect(css).toMatch(/--font-sans: "Inter Variable",/);
    expect(css).toMatch(/"Malgun Gothic"/);
  });

  it("the typeface is self-hosted: the latin subset of Inter from this origin, its licence named", () => {
    const fonts = readFileSync(fileURLToPath(new URL("../src/fonts.css", import.meta.url)), "utf8");
    expect(fonts).toMatch(/font-family: "Inter Variable"/);
    expect(fonts).toMatch(/inter-latin-wght-normal\.woff2/);
    expect(fonts).toMatch(/unicode-range:\s+U\+0000-00FF/);
    expect(fonts).toMatch(/Open Font License/);
    expect(fonts).not.toMatch(/https?:\/\//);
  });
});
