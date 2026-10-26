// The page around the screens (spec v3.0 §7.9): the header with the title, the network and the wallet state, the
// Deposit | Withdraw tabs (the original's one page, each tab a route), the links to History and Settings, the notices,
// the two-column layout from 1024 px (the form beside the Statistics), the footer.
import type { ReactNode } from "react";
import { t } from "../app/i18n/messages";
import type { Route } from "../app/router";
import { Notice } from "./ui";

export function Shell(props: {
  route: Route;
  onRoute: (r: Route) => void;
  walletLabel: string;
  walletEnabled: boolean;
  onWallet?: () => void;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const tab = props.route === "withdraw" ? "withdraw" : "deposit";
  const onPage = props.route === "history" || props.route === "settings";
  return (
    <div className="tc-shell">
      <header className="tc-header" data-testid="classic-header">
        <div className="tc-brand">
          <span className="tc-brand-mark" aria-hidden="true" />
          <div>
            <h1 className="tc-title">{t("app.title")}</h1>
            <p className="tc-sub">{t("app.subtitle")}</p>
          </div>
        </div>
        <div className="tc-header-actions">
          <span className="tc-chip" data-testid="classic-network">
            {t("app.network")}
          </span>
          <button
            type="button"
            className="tc-chip tc-chip-button"
            data-testid="classic-wallet"
            disabled={!props.walletEnabled}
            title={props.walletEnabled ? undefined : t("wallet.notInBuild")}
            onClick={props.onWallet}
          >
            {props.walletLabel}
          </button>
        </div>
        <Notice tone="warn" testId="classic-not-connected">
          <strong>{t("notice.notConnected")}</strong>
        </Notice>
      </header>
      <nav className="tc-nav" aria-label={t("nav.tabs")}>
        <div className="tc-tabs" role="tablist" aria-label={t("nav.tabs")}>
          {(["deposit", "withdraw"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              id={`tab-${r}`}
              className={`tc-tab${tab === r && !onPage ? " tc-tab-active" : ""}`}
              aria-selected={tab === r && !onPage}
              aria-controls={`panel-${r}`}
              data-testid={`classic-tab-${r}`}
              onClick={() => props.onRoute(r)}
            >
              {t(r === "deposit" ? "nav.deposit" : "nav.withdraw")}
            </button>
          ))}
        </div>
        <div className="tc-links">
          <button
            type="button"
            className={`tc-link${props.route === "history" ? " tc-link-active" : ""}`}
            data-testid="classic-link-history"
            aria-current={props.route === "history" ? "page" : undefined}
            onClick={() => props.onRoute("history")}
          >
            {t("nav.history")}
          </button>
          <button
            type="button"
            className={`tc-link${props.route === "settings" ? " tc-link-active" : ""}`}
            data-testid="classic-link-settings"
            aria-current={props.route === "settings" ? "page" : undefined}
            onClick={() => props.onRoute("settings")}
          >
            {t("nav.settings")}
          </button>
        </div>
      </nav>
      <div className={`tc-columns${props.aside ? " tc-columns-two" : ""}`}>
        <main className="tc-main">
          {onPage ? (
            props.children
          ) : (
            <div className="tc-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
              {props.children}
            </div>
          )}
        </main>
        {props.aside ? <aside className="tc-aside">{props.aside}</aside> : null}
      </div>
      <footer className="tc-footer">
        <span>{t("app.version")}</span>
      </footer>
    </div>
  );
}
