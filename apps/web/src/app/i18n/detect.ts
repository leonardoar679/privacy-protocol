// Locale detection (Privacy Wallet Web spec §19; Stage 11): the catalogs the build carries, the browser's languages
// matched by base language, an explicit preference first, a `?locale=` query for development and the width checks
// (the pseudo-locale). Pure: the app applies the result through messages.setLocale.
export const SUPPORTED = ["en", "ko", "zh", "ja"] as const;
export type Supported = (typeof SUPPORTED)[number];
/** The pseudo-locale (every English string lengthened and accented) exists for the layout checks, never for a user. */
export const PSEUDO = "pseudo";

/** The first of the browser's languages whose base language has a catalog; English otherwise. */
export function detectLocale(languages: readonly string[] | undefined, supported: readonly string[] = SUPPORTED): string {
  for (const l of languages ?? []) {
    const base = String(l).toLowerCase().split("-")[0];
    if (supported.includes(base)) return base;
  }
  return "en";
}

/**
 * The locale to run with: `?locale=` when it names a catalog (or the pseudo-locale), else the preference when the user
 * chose it (More → Language, `chosen`: English included — V6 Stage 16) or when it is not the default English, else the
 * browser's languages ("Automatic").
 */
export function chooseLocale(o: { prefs?: string | null; chosen?: boolean; query?: string | null; languages?: readonly string[]; supported?: readonly string[] }): string {
  const supported = o.supported ?? SUPPORTED;
  const q = o.query?.toLowerCase().trim();
  if (q && (q === PSEUDO || supported.includes(q))) return q;
  const p = o.prefs?.toLowerCase().split("-")[0];
  if (p && (o.chosen || p !== "en") && supported.includes(p)) return p;
  return detectLocale(o.languages, supported);
}
