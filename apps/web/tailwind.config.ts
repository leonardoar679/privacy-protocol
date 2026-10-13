// Tailwind over the design tokens (spec v2.0 §5): every colour, type role, radius, shadow, duration and layer is a CSS
// variable of tokens.css, so a utility class and a `var(--…)` in a stylesheet always agree. Preflight is off: the
// legacy stylesheet (styles.css) keeps its look until the screens are rebuilt, and base.css carries the small reset.
import type { Config } from "tailwindcss";
import { BREAKPOINTS, COLOR_NAMES, MOTION, TYPE_ROLES, Z } from "@privacy-wallet/ui/tokens";

const v = (name: string) => `var(--${name})`;
const colors = Object.fromEntries(COLOR_NAMES.map((n) => [n, v(n)]));
// every role through its variables, so a high-contrast or a larger-text override reaches the utilities too
const fontSize = Object.fromEntries(TYPE_ROLES.map((r) => [r, [v(`${r}-size`), { lineHeight: v(`${r}-line`), fontWeight: v(`${r}-weight`), letterSpacing: v(`${r}-tracking`) }]]));

export default {
  // the design system is a package (V6 Stage 4): its components' classes are generated with the app's
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  corePlugins: { preflight: false },
  theme: {
    screens: Object.fromEntries(Object.entries(BREAKPOINTS).map(([k, px]) => [k, `${px}px`])),
    extend: {
      colors,
      fontSize,
      fontFamily: { sans: v("font-sans"), mono: v("font-mono") },
      borderRadius: { sm: v("radius-sm"), md: v("radius-md"), lg: v("radius-lg"), xl: v("radius-xl"), full: v("radius-full") },
      boxShadow: { "elevation-1": v("elevation-1"), "elevation-2": v("elevation-2"), "elevation-3": v("elevation-3") },
      transitionDuration: { fast: `${MOTION.fast}ms`, base: `${MOTION.base}ms`, slow: `${MOTION.slow}ms` },
      transitionTimingFunction: { ds: MOTION.ease },
      zIndex: Object.fromEntries(Object.entries(Z).map(([k, n]) => [k, `${n}`])),
      minHeight: { touch: v("touch") },
      minWidth: { touch: v("touch") },
      maxWidth: { content: v("content-max"), wide: v("wide-max") },
      spacing: { "nav-h": v("nav-h"), "safe-top": "env(safe-area-inset-top, 0px)", "safe-bottom": "env(safe-area-inset-bottom, 0px)" },
    },
  },
  plugins: [],
} satisfies Config;
