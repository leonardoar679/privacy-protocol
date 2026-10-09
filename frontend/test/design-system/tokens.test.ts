// The design tokens (spec §4): tokens.css is generated from tokens.ts and must match it; the scales are ordered; the
// ten viewports of the plan are the ones the browser run uses.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BREAKPOINTS, COLORS, ELEVATION, LAYOUT, MOTION, PRIMARY_VIEWPORT, SPACE_STEPS, SPACE_UNIT, TYPE, VIEWPORTS, Z, toCss, type TypeRole } from "../../src/design-system/tokens";

describe("design tokens (spec §4)", () => {
  it("tokens.css is the output of tokens.ts (`npm run tokens` regenerates it)", () => {
    const css = readFileSync(fileURLToPath(new URL("../../src/design-system/tokens.css", import.meta.url)), "utf8");
    expect(css).toBe(toCss());
  });
  it("the dark set names every light token; elevation has four levels in both", () => {
    expect(Object.keys(COLORS.dark).sort()).toEqual(Object.keys(COLORS.light).sort());
    expect(ELEVATION.light).toHaveLength(4);
    expect(ELEVATION.dark).toHaveLength(4);
    for (const set of [COLORS.light, COLORS.dark]) for (const v of Object.values(set)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("the type scale descends from display to caption and every line height is at least its size", () => {
    const roles: TypeRole[] = ["display", "title", "heading", "body", "label", "caption"];
    for (let i = 1; i < roles.length; i++) expect(TYPE[roles[i]].size).toBeLessThan(TYPE[roles[i - 1]].size);
    for (const r of roles) expect(TYPE[r].line).toBeGreaterThanOrEqual(TYPE[r].size);
    expect(TYPE.body.size).toBe(16);
  });
  it("spacing is a 4-pt scale of twelve steps; motion, layers and breakpoints are ordered; targets are 44 px", () => {
    expect(SPACE_UNIT).toBe(4);
    expect(SPACE_STEPS).toBe(12);
    expect(MOTION.fast).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.slow);
    expect(Z.nav).toBeLessThan(Z.sheet);
    expect(Z.sheet).toBeLessThan(Z.dialog);
    expect(Z.dialog).toBeLessThan(Z.toast);
    const bps = Object.values(BREAKPOINTS);
    for (let i = 1; i < bps.length; i++) expect(bps[i]).toBeGreaterThan(bps[i - 1]);
    expect(LAYOUT.touch).toBe(44);
    expect(LAYOUT.navHeight).toBe(64);
  });
  it("the ten viewports of the plan (§8), the primary canvas 390 × 844", () => {
    expect(VIEWPORTS.map(([w, h]) => `${w}x${h}`)).toEqual(["360x800", "375x812", "390x844", "393x852", "412x915", "430x932", "768x1024", "1024x768", "1280x800", "1440x900"]);
    expect(PRIMARY_VIEWPORT).toEqual([390, 844]);
  });
  it("the stylesheet carries dark mode under the media query and the data-theme attribute, reduced motion, and the legacy aliases", () => {
    const css = toCss();
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/--panel: var\(--surface\);/);
    expect(css).toMatch(/--muted: var\(--fg-muted\);/);
    expect(css).toMatch(/--space-12: 48px;/);
    expect(css).toMatch(/--touch: 44px;/);
  });
});
