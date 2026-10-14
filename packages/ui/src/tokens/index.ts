// The design tokens (spec v2.0 §5; doc §6–§10, §55–§57): the one source of colour, type, spacing, radius, elevation,
// motion, layering and breakpoints. `tokens.css` beside this module is generated from it (`npm run tokens` in
// packages/ui) and a test asserts the two agree; apps/web's tailwind.config.ts maps the same names onto utilities.
// A screen reads a token through a CSS variable or a Tailwind class, never through a literal of its own.
//
// The feeling is calm, premium, friendly and trustworthy: a quiet neutral surface, one deep blue for action, one
// green for protection, an amber warning and a red danger — never neon, never a terminal. Light by default (the
// system decides dark), a high-contrast set under `prefers-contrast: more`, system colours under `forced-colors`.

export const COLOR_NAMES = [
  "bg",
  "surface",
  "surface-2",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "accent",
  "accent-fg",
  "accent-soft",
  "shield",
  "shield-soft",
  "warn",
  "warn-soft",
  "danger",
  "danger-soft",
  "success",
  "success-soft",
  "focus",
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
export type Scheme = "light" | "dark" | "contrast" | "contrast-dark";

/** Every text colour meets WCAG AA on the surfaces it is used on (the tokens test checks the pairs). */
export const COLORS: Record<Scheme, Record<ColorName, string>> = {
  light: {
    bg: "#f6f7f9",
    surface: "#ffffff",
    "surface-2": "#f0f2f5",
    border: "#e3e7ec",
    "border-strong": "#c5ccd5",
    fg: "#14181f",
    "fg-muted": "#5a6472",
    accent: "#2b59c3",
    "accent-fg": "#ffffff",
    "accent-soft": "#e8eefb",
    shield: "#1b6e4c",
    "shield-soft": "#e4f3ec",
    warn: "#9a5200",
    "warn-soft": "#fdf1e1",
    danger: "#b42318",
    "danger-soft": "#fdeceb",
    success: "#1b6e4c",
    "success-soft": "#e4f3ec",
    focus: "#2b59c3",
  },
  dark: {
    bg: "#0e1116",
    surface: "#161a21",
    "surface-2": "#1d222a",
    border: "#2a3039",
    "border-strong": "#3d4651",
    fg: "#edf0f3",
    "fg-muted": "#9ea8b4",
    accent: "#8aabff",
    "accent-fg": "#0b1220",
    "accent-soft": "#1c2946",
    shield: "#5cc596",
    "shield-soft": "#14301f",
    warn: "#e9b85a",
    "warn-soft": "#382b10",
    danger: "#ff8a7d",
    "danger-soft": "#3d1c19",
    success: "#5cc596",
    "success-soft": "#14301f",
    focus: "#8aabff",
  },
  contrast: {
    bg: "#ffffff",
    surface: "#ffffff",
    "surface-2": "#f2f2f2",
    border: "#4a4a4a",
    "border-strong": "#000000",
    fg: "#000000",
    "fg-muted": "#333333",
    accent: "#0a3a9e",
    "accent-fg": "#ffffff",
    "accent-soft": "#dbe5ff",
    shield: "#0a5535",
    "shield-soft": "#d7f0e2",
    warn: "#6e3a00",
    "warn-soft": "#fde9cc",
    danger: "#8a1108",
    "danger-soft": "#fde0dd",
    success: "#0a5535",
    "success-soft": "#d7f0e2",
    focus: "#000000",
  },
  "contrast-dark": {
    bg: "#000000",
    surface: "#0b0b0b",
    "surface-2": "#161616",
    border: "#bdbdbd",
    "border-strong": "#ffffff",
    fg: "#ffffff",
    "fg-muted": "#d6d6d6",
    accent: "#a9c2ff",
    "accent-fg": "#000000",
    "accent-soft": "#1a2547",
    shield: "#7ee0b0",
    "shield-soft": "#0f2a1c",
    warn: "#ffcf70",
    "warn-soft": "#2e2209",
    danger: "#ffa39a",
    "danger-soft": "#3a1513",
    success: "#7ee0b0",
    "success-soft": "#0f2a1c",
    focus: "#ffffff",
  },
};

/** The legacy names of styles.css (until the screens are rebuilt) are aliases of the new ones, so one palette serves both. */
export const LEGACY_ALIASES: Record<string, ColorName> = { panel: "surface", "panel-2": "surface-2", muted: "fg-muted" };

/** The eight typography roles of the spec: two numeric roles with tabular figures for every amount. */
export const TYPE_ROLES = ["display", "heading", "title", "body", "body-small", "caption", "numeric-large", "numeric-medium"] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];
export interface TypeSpec {
  size: number;
  line: number;
  weight: number;
  /** letter spacing, when not the font's own */
  tracking?: string;
  /** tabular figures (every amount, so columns of numbers align and a changing value does not jump) */
  numeric?: boolean;
}
export const TYPE: Record<TypeRole, TypeSpec> = {
  display: { size: 32, line: 38, weight: 700, tracking: "-0.02em" },
  heading: { size: 24, line: 30, weight: 700, tracking: "-0.01em" },
  title: { size: 18, line: 24, weight: 600 },
  body: { size: 16, line: 24, weight: 400 },
  "body-small": { size: 14, line: 20, weight: 400 },
  caption: { size: 12, line: 16, weight: 500 },
  "numeric-large": { size: 36, line: 42, weight: 600, tracking: "-0.02em", numeric: true },
  "numeric-medium": { size: 20, line: 26, weight: 600, tracking: "-0.01em", numeric: true },
};
export const WEIGHT = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

/** Inter (self-hosted, latin subset: fonts.css) first; Hangul and every other script from the system's own fonts. */
export const FONT = {
  sans: `"Inter Variable", -apple-system, "SF Pro Text", "Segoe UI", system-ui, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", Arial, sans-serif`,
  mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
};

/** A 4-point grid: --space-1 = 4 px … --space-16 = 64 px. */
export const SPACE_UNIT = 4;
export const SPACE_STEPS = 16;

export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 24, full: 999 } as const;

/** Soft shadows in light; a hairline border in dark, where a shadow cannot be seen. */
export const ELEVATION: Record<"light" | "dark", readonly [string, string, string, string]> = {
  light: [
    "none",
    "0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.06)",
    "0 4px 14px rgba(16, 24, 40, 0.08)",
    "0 16px 40px rgba(16, 24, 40, 0.16)",
  ],
  dark: ["none", "0 0 0 1px var(--border)", "0 0 0 1px var(--border)", "0 0 0 1px var(--border), 0 16px 40px rgba(0, 0, 0, 0.5)"],
};

/** 120 / 200 / 320 ms, all 0 under prefers-reduced-motion. */
export const MOTION = { fast: 120, base: 200, slow: 320, ease: "cubic-bezier(0.2, 0.7, 0.2, 1)" } as const;
export const Z = { nav: 10, header: 15, menu: 25, sheet: 20, dialog: 30, toast: 40 } as const;
export const BREAKPOINTS = { sm: 360, md: 480, lg: 768, xl: 1024, "2xl": 1280 } as const;
/** The phone column, the desktop width (1200–1280 px, spec §6), the bars and the 44 px touch target. */
export const LAYOUT = { headerHeight: 56, navHeight: 64, touch: 44, contentMax: 600, wideMax: 1240 } as const;

/** The ten viewports of spec §6 (doc §12): the primary canvas is 390 × 844. */
export const VIEWPORTS: readonly (readonly [number, number])[] = [
  [360, 800],
  [375, 812],
  [390, 844],
  [393, 852],
  [412, 915],
  [430, 932],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
];
export const PRIMARY_VIEWPORT: readonly [number, number] = [390, 844];

/** The tokens as one object (doc §8: DesignTokens { spacing, radius, typography, elevation, motion }). */
export interface DesignTokens {
  spacing: { unit: number; steps: number };
  radius: typeof RADIUS;
  typography: { fonts: typeof FONT; roles: typeof TYPE; weights: typeof WEIGHT };
  elevation: typeof ELEVATION;
  motion: typeof MOTION;
  color: typeof COLORS;
  z: typeof Z;
  breakpoints: typeof BREAKPOINTS;
  layout: typeof LAYOUT;
}
export const TOKENS: DesignTokens = {
  spacing: { unit: SPACE_UNIT, steps: SPACE_STEPS },
  radius: RADIUS,
  typography: { fonts: FONT, roles: TYPE, weights: WEIGHT },
  elevation: ELEVATION,
  motion: MOTION,
  color: COLORS,
  z: Z,
  breakpoints: BREAKPOINTS,
  layout: LAYOUT,
};

const px = (n: number) => `${n}px`;
const rem = (n: number): string => `${n / 16}rem`;
const colorLines = (set: Record<ColorName, string>, indent = "  "): string[] => COLOR_NAMES.map((k) => `${indent}--${k}: ${set[k]};`);
const elevationLines = (set: readonly string[], indent = "  "): string[] => set.map((v, i) => `${indent}--elevation-${i}: ${v};`);
const block = (selector: string, lines: string[]): string[] => [`${selector} {`, ...lines, "}"];
const media = (query: string, selector: string, lines: string[]): string[] => [
  `@media ${query} {`,
  `  ${selector} {`,
  ...lines.map((l) => `  ${l}`),
  "  }",
  "}",
];

/** The stylesheet text of these tokens — `tokens.css` byte for byte. */
export function toCss(): string {
  const root: string[] = ["  color-scheme: light dark;", ...colorLines(COLORS.light)];
  for (const [legacy, name] of Object.entries(LEGACY_ALIASES)) root.push(`  --${legacy}: var(--${name});`);
  root.push(`  --font-sans: ${FONT.sans};`, `  --font-mono: ${FONT.mono};`);
  for (const role of TYPE_ROLES) {
    const t = TYPE[role];
    // V6 Stage 16 (doc §77): the type in rem — the reader's own text size (up to 200 %) scales it; 16 px is 1 rem
    root.push(
      `  --${role}-size: ${rem(t.size)};`,
      `  --${role}-line: ${rem(t.line)};`,
      `  --${role}-weight: ${t.weight};`,
      `  --${role}-tracking: ${t.tracking ?? "normal"};`,
    );
  }
  for (const [k, v] of Object.entries(WEIGHT)) root.push(`  --weight-${k}: ${v};`);
  for (let i = 1; i <= SPACE_STEPS; i++) root.push(`  --space-${i}: ${px(i * SPACE_UNIT)};`);
  for (const [k, v] of Object.entries(RADIUS)) root.push(`  --radius-${k}: ${px(v)};`);
  root.push("  --radius: var(--radius-lg);", ...elevationLines(ELEVATION.light));
  root.push(`  --motion-fast: ${MOTION.fast}ms;`, `  --motion-base: ${MOTION.base}ms;`, `  --motion-slow: ${MOTION.slow}ms;`, `  --ease: ${MOTION.ease};`);
  for (const [k, v] of Object.entries(Z)) root.push(`  --z-${k}: ${v};`);
  root.push(`  --header-h: ${px(LAYOUT.headerHeight)};`, `  --nav-h: ${px(LAYOUT.navHeight)};`, `  --touch: ${px(LAYOUT.touch)};`);
  root.push(`  --content-max: ${px(LAYOUT.contentMax)};`, `  --wide-max: ${px(LAYOUT.wideMax)};`, "  --keyboard-inset: 0px;");

  const dark = [...colorLines(COLORS.dark), ...elevationLines(ELEVATION.dark)];
  const out = [
    "/* Generated from packages/ui/src/tokens/index.ts by `npm run tokens` (packages/ui); edit the TypeScript, not this file. */",
    ...block(":root", root),
    ...media("(prefers-color-scheme: dark)", ':root:not([data-theme="light"])', dark),
    ...block(':root[data-theme="dark"]', dark),
    ...media("(prefers-contrast: more)", ":root", colorLines(COLORS.contrast)),
    ...media("(prefers-contrast: more) and (prefers-color-scheme: dark)", ':root:not([data-theme="light"])', colorLines(COLORS["contrast-dark"])),
    ...media("(forced-colors: active)", ":root", ["  --border: CanvasText;", "  --border-strong: CanvasText;", "  --focus: Highlight;"]),
    ...media("(prefers-reduced-motion: reduce)", ":root", ["  --motion-fast: 0ms;", "  --motion-base: 0ms;", "  --motion-slow: 0ms;"]),
  ];
  return out.join("\n") + "\n";
}
