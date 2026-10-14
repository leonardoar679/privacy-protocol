// The locale in force (spec v2.0 §18; doc §78; V6 Stage 16): the one the query, the user's choice (More → Language) and
// the browser's languages agree on (./detect.ts), applied once its table is in memory — Korean loads as its own chunk
// — together with the design system's words, the locale amounts are written in and the document's lang. main.tsx
// waits for it before the first render, so a Korean reader never sees English first.
import { setFormatLocale, setLabels } from "@privacy-wallet/ui";
import { prefs } from "../../storage/prefs";
import { catalogReady, loadCatalog, registerCatalogs } from "./catalogs";
import { chooseLocale } from "./detect";
import { intlLocale } from "./intl";
import { getLocale, setLocale, t } from "./messages";

/** The locale the query, the preference and the browser's languages agree on. */
export function chosenLocale(): string {
  const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("locale") : null;
  const languages = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  const p = prefs().get();
  return chooseLocale({ prefs: p.locale, chosen: p.localeChosen, query, languages });
}

function apply(locale: string): void {
  if (locale !== getLocale()) setLocale(locale);
  // the design system's own words follow (Back, Close, the hold, the fee lines …)
  setLabels({
    back: t("common.back"),
    close: t("common.close"),
    cancel: t("common.cancel"),
    confirm: t("common.confirm"),
    holdToConfirm: t("common.holdToConfirm"),
    keepHolding: t("common.keepHolding"),
    pressAndHold: t("common.pressAndHold"),
    confirmWithoutHolding: t("common.confirmWithoutHolding"),
    confirmDialogTitle: t("common.confirmDialogTitle"),
    confirmDialogBody: t("common.confirmDialogBody"),
    paste: t("common.paste"),
    search: t("common.search"),
    max: t("common.max"),
    commonSizes: t("common.commonSizes"),
    addressBook: t("common.addressBook"),
    chooseAsset: t("common.chooseAsset"),
    totalFees: t("fees.total"),
    viewFeeDetails: t("fees.viewDetails"),
    compareRoutes: t("quote.compare"),
    loading: t("common.loading"),
    notifications: t("common.notifications"),
    mainNav: t("nav.main"),
    skipToContent: t("common.skipToContent"),
    chooseNetwork: t("common.chooseNetwork"),
    unavailable: t("common.unavailable"),
    switchDirection: t("common.switchDirection"),
    copy: t("common.copy"),
    copied: t("common.copied"),
  });
  setFormatLocale(intlLocale(locale));
  if (typeof document !== "undefined") document.documentElement.lang = locale === "pseudo" ? "en" : locale;
}

/** Applies the chosen locale — at once when its table is in memory, else once it has loaded (the current one until
 *  then; English if it never loads) — and answers the locale in force now. */
export function applyLocale(): string {
  registerCatalogs();
  const locale = chosenLocale();
  if (catalogReady(locale)) {
    apply(locale);
    return locale;
  }
  void loadCatalog(locale).then(
    () => {
      if (chosenLocale() === locale) apply(locale);
    },
    () => undefined,
  );
  return getLocale();
}

/** Before the first render: the preferences read (at most half a second), the chosen locale's table loaded, applied. */
export async function prepareLocale(): Promise<string> {
  registerCatalogs();
  await Promise.race([prefs().ready, new Promise((r) => setTimeout(r, 500))]);
  try {
    await loadCatalog(chosenLocale());
  } catch {
    // the table did not load: English stands
  }
  return applyLocale();
}
