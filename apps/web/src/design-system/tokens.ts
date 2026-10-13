// The design tokens (Privacy Wallet Web spec §4; plan §7–§8, §51, §74, §76): the one source of truth for colours,
// type, spacing, radius, elevation, motion, layering and breakpoints. `tokens.css` is generated from this file
// (`npm run tokens`) and a test asserts the two agree; `tailwind.config.ts` maps the same names onto utilities.
// A screen reads a token through a CSS variable or a Tailwind class, never through a literal of its own.

export type ColorName =
  | "bg" | "surface" | "surface-2" | "border" | "fg" | "fg-muted"
  | "accent" | "accent-fg" | "accent-soft" | "shield" | "shield-soft"
  | "warn" | "warn-soft" | "danger" | "danger-soft" | "success";

/** A neutral light surface first, one primary accent, one security accent (the shield), one warning, one danger. */
export const COLORS: Record<"light" | "dark", Record<ColorName, string>> = {
  light: {
    bg: "#f4f6f8", surface: "#ffffff", "surface-2": "#eef2f6", border: "#e1e6ec", fg: "#141a21", "fg-muted": "#5f6c7b",
    accent: "#2457d6", "accent-fg": "#ffffff", "accent-soft": "#e4ebfb", shield: "#1d8a5a", "shield-soft": "#e3f3ea",
    warn: "#b4610d", "warn-soft": "#fbeedd", danger: "#c0392b", "danger-soft": "#fbe4e1", success: "#1d8a5a",
  },
  dark: {
    bg: "#0f1216", surface: "#171b21", "surface-2": "#1f252d", border: "#2a313a", fg: "#eef1f4", "fg-muted": "#9aa5b1",
    accent: "#7a9fff", "accent-fg": "#0b1220", "accent-soft": "#1d2a4a", shield: "#4cc38a", "shield-soft": "#15301f",
    warn: "#e2b04a", "warn-soft": "#3a2d10", danger: "#ff7b6b", "danger-soft": "#3f1d1a", success: "#4cc38a",
  },
};

/** The legacy names of styles.css (until Stage 10) are aliases of the new ones, so one palette serves both. */
export const LEGACY_ALIASES: Record<string, ColorName> = { panel: "surface", "panel-2": "surface-2", muted: "fg-muted" };

export type TypeRole = "display" | "title" | "heading" | "body" | "label" | "caption";
export const TYPE: Record<TypeRole, { size: number; line: number; weight: number }> = {
  display: { size: 40, line: 44, weight: 700 },
  title: { size: 28, line: 32, weight: 700 },
  heading: { size: 20, line: 26, weight: 600 },
  body: { size: 16, line: 24, weight: 400 },
  label: { size: 14, line: 20, weight: 500 },
  caption: { size: 12, line: 16, weight: 400 },
};
export const FONT = {
  sans: `-apple-system, "SF Pro Text", "Segoe UI", "IBM Plex Sans", system-ui, Arial, sans-serif`,
  mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
};

/** A 4-pt scale: --space-1 = 4 px … --space-12 = 48 px. */
export const SPACE_UNIT = 4;
export const SPACE_STEPS = 12;

export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 20, full: 999 } as const;

/** Soft shadows in light; a hairline border in dark, where a shadow cannot be seen. */
export const ELEVATION: Record<"light" | "dark", readonly [string, string, string, string]> = {
  light: ["none", "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08)", "0 4px 12px rgba(16, 24, 40, 0.10)", "0 12px 32px rgba(16, 24, 40, 0.16)"],
  dark: ["none", "0 0 0 1px var(--border)", "0 0 0 1px var(--border)", "0 0 0 1px var(--border), 0 12px 32px rgba(0, 0, 0, 0.5)"],
};

export const MOTION = { fast: 120, base: 200, slow: 320, ease: "cubic-bezier(0.2, 0.7, 0.2, 1)" } as const;
export const Z = { nav: 10, sheet: 20, dialog: 30, toast: 40 } as const;
export const BREAKPOINTS = { sm: 360, md: 480, lg: 768, xl: 1024, "2xl": 1280 } as const;
export const LAYOUT = { navHeight: 64, touch: 44, contentMax: 720, wideMax: 1200 } as const;

/** The ten viewports of spec §4 (plan §8): the primary canvas is 390 × 844. */
export const VIEWPORTS: readonly (readonly [number, number])[] = [
  [360, 800], [375, 812], [390, 844], [393, 852], [412, 915], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900],
];
export const PRIMARY_VIEWPORT: readonly [number, number] = [390, 844];

const px = (n: number) => `${n}px`;

function colorLines(set: Record<ColorName, string>): string[] {
  return (Object.keys(set) as ColorName[]).map((k) => `  --${k}: ${set[k]};`);
}
function elevationLines(set: readonly string[]): string[] {
  return set.map((v, i) => `  --elevation-${i}: ${v};`);
}

/** The stylesheet text of these tokens — `tokens.css` byte for byte. */
export function toCss(): string {
  const out: string[] = [];
  out.push("/* Generated from src/design-system/tokens.ts by `npm run tokens`; edit the TypeScript, not this file. */");
  out.push(":root {");
  out.push("  color-scheme: light dark;");
  out.push(...colorLines(COLORS.light));
  for (const [legacy, name] of Object.entries(LEGACY_ALIASES)) out.push(`  --${legacy}: var(--${name});`);
  out.push(`  --font-sans: ${FONT.sans};`);
  out.push(`  --font-mono: ${FONT.mono};`);
  for (const role of Object.keys(TYPE) as TypeRole[]) {
    const t = TYPE[role];
    out.push(`  --${role}-size: ${px(t.size)};`, `  --${role}-line: ${px(t.line)};`, `  --${role}-weight: ${t.weight};`);
  }
  for (let i = 1; i <= SPACE_STEPS; i++) out.push(`  --space-${i}: ${px(i * SPACE_UNIT)};`);
  for (const [k, v] of Object.entries(RADIUS)) out.push(`  --radius-${k}: ${px(v)};`);
  out.push("  --radius: var(--radius-lg);");
  out.push(...elevationLines(ELEVATION.light));
  out.push(`  --motion-fast: ${MOTION.fast}ms;`, `  --motion-base: ${MOTION.base}ms;`, `  --motion-slow: ${MOTION.slow}ms;`, `  --ease: ${MOTION.ease};`);
  for (const [k, v] of Object.entries(Z)) out.push(`  --z-${k}: ${v};`);
  out.push(`  --nav-h: ${px(LAYOUT.navHeight)};`, `  --touch: ${px(LAYOUT.touch)};`, `  --content-max: ${px(LAYOUT.contentMax)};`, `  --wide-max: ${px(LAYOUT.wideMax)};`);
  out.push("}");
  const dark = [...colorLines(COLORS.dark), ...elevationLines(ELEVATION.dark)];
  out.push("@media (prefers-color-scheme: dark) {");
  out.push("  :root:not([data-theme=\"light\"]) {");
  out.push(...dark.map((l) => `  ${l}`));
  out.push("  }");
  out.push("}");
  out.push(":root[data-theme=\"dark\"] {");
  out.push(...dark);
  out.push("}");
  out.push("@media (prefers-reduced-motion: reduce) {");
  out.push("  :root {");
  out.push("    --motion-fast: 0ms;", "    --motion-base: 0ms;", "    --motion-slow: 0ms;");
  out.push("  }");
  out.push("}");
  return out.join("\n") + "\n";
}
