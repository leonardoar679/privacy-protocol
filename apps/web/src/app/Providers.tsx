// The providers above every screen (spec §2): the deployment, the toasts, the locale (spec §19: the preference, else
// the browser's languages; `?locale=` for development and the layout checks). The router sits above them in App.tsx.
import { useEffect, useState, type ReactNode } from "react";
import { setLabels, ToastProvider } from "@privacy-wallet/ui";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { config } from "@privacy-wallet/sdk/config";
import { connection, discover } from "@privacy-wallet/wallet-engine/connection";
import { prefs } from "../storage/prefs";
import { DeploymentContext } from "./deployment";
import { registerCatalogs } from "./i18n/catalogs";
import { chooseLocale } from "./i18n/detect";
import { getLocale, setLocale, t } from "./i18n/messages";

/** Applies the locale the preference, the query and the browser agree on; the document's lang follows. */
export function applyLocale(): string {
  registerCatalogs();
  const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("locale") : null;
  const languages = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  const locale = chooseLocale({ prefs: prefs().get().locale, query, languages });
  if (locale !== getLocale()) setLocale(locale);
  // the design system's own words follow (Back, Close, the hold, the fee lines …)
  setLabels({ back: t("common.back"), close: t("common.close"), cancel: t("common.cancel"), confirm: t("common.confirm"), holdToConfirm: t("common.holdToConfirm"), keepHolding: t("common.keepHolding"), pressAndHold: t("common.pressAndHold"), paste: t("common.paste"), search: t("common.search"), max: t("common.max"), commonSizes: t("common.commonSizes"), addressBook: t("common.addressBook"), chooseAsset: t("common.chooseAsset"), totalFees: t("fees.total"), viewFeeDetails: t("fees.viewDetails"), compareRoutes: t("quote.compare"), loading: t("common.loading"), notifications: t("common.notifications"), mainNav: t("nav.main"), skipToContent: t("common.skipToContent"), chooseNetwork: t("common.chooseNetwork"), unavailable: t("common.unavailable"), switchDirection: t("common.switchDirection"), copy: t("common.copy"), copied: t("common.copied") });
  if (typeof document !== "undefined") document.documentElement.lang = locale === "pseudo" ? "en" : locale;
  return locale;
}

export function Providers({ children, deployment }: { children: ReactNode; deployment?: Deployment | null }) {
  const [fromEnv] = useState(() => (deployment === undefined ? config().deployment : deployment));
  useEffect(() => { connection.configure({ expectedChainId: fromEnv?.chainId ?? null }); discover(); }, [fromEnv]);
  useEffect(() => { applyLocale(); return prefs().subscribe(applyLocale); }, []);
  return (
    <DeploymentContext.Provider value={fromEnv}>
      <ToastProvider>{children}</ToastProvider>
    </DeploymentContext.Provider>
  );
}
