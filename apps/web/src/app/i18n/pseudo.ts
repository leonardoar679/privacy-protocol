// The pseudo-locale (Privacy Wallet Web spec §19; Stage 11): every English string, accented and lengthened by about a
// third and bracketed, so a layout that survives it survives German or Finnish. Placeholders `{name}` and the
// characters the wallet relies on (✓ ⚠ · → ≈ digits, punctuation) stay as they are. The lengthening is added as
// short groups separated by spaces, so it wraps like real text: one unbroken run would overflow any width (the
// local-stack viewport pass found exactly that). Built from the English table.
import type { en as EN } from "./en";

const MAP: Record<string, string> = { a: "á", b: "ƀ", c: "ç", d: "đ", e: "é", f: "ƒ", g: "ğ", h: "ĥ", i: "í", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ɋ", r: "ř", s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž", A: "Á", B: "Ɓ", C: "Ç", D: "Đ", E: "É", F: "Ƒ", G: "Ğ", H: "Ĥ", I: "Í", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ɋ", R: "Ř", S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž" };

/** One string: letters accented, placeholders kept, lengthened by one "~~~" group per nine letters (about a third) and bracketed. */
export function pseudoLocalize(s: string): string {
  let letters = 0;
  const body = s.replace(/\{\w+\}|[A-Za-z]/g, (m) => {
    if (m.length > 1) return m; // a placeholder
    letters += 1;
    return MAP[m] ?? m;
  });
  const pad = Array.from({ length: Math.ceil(letters / 9) }, () => "~~~").join(" ");
  return `[${body}${pad ? ` ${pad}` : ""}]`;
}

/** The whole catalog, from the English table. */
export function pseudoCatalog(en: typeof EN): Partial<Record<keyof typeof EN, string>> {
  const out: Partial<Record<keyof typeof EN, string>> = {};
  for (const k of Object.keys(en) as (keyof typeof EN)[]) out[k] = pseudoLocalize(en[k]);
  return out;
}
