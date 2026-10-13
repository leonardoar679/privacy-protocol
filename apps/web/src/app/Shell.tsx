// The shell (spec §2, §3.3): the four-item navigation — Home, Swap, Activity, More, never more —, the journal
// notice when the stored journal would not decrypt, and the screen of the current route; the background jobs run
// beside it while the wallet is unlocked.
import { Suspense } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppShell, BottomNav, Button, Skeleton, type NavItem } from "../design-system";
import { useT } from "./i18n/useT";
import { session, useSession } from "../wallet/session";
import { Background } from "./Background";

export function Shell() {
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const s = useSession();
  const items: NavItem[] = [
    { to: "/", label: t("nav.home"), icon: "home", testId: "nav-home" },
    { to: "/swap", label: t("nav.swap"), icon: "swap", testId: "nav-swap" },
    { to: "/activity", label: t("nav.activity"), icon: "activity", testId: "nav-activity" },
    { to: "/more", label: t("nav.more"), icon: "more", testId: "nav-more" },
  ];
  return (
    <AppShell nav={<BottomNav items={items} current={pathname} onSelect={(to) => navigate(to)} brand={t("app.name")} />}>
      <Background />
      {s.journalUnreadable ? (
        <div className="notice" data-testid="journal-unreadable">
          <p><b>{t("journal.unreadableTitle")}</b> {t("journal.unreadableBody")}</p>
          <div className="ds-chips">
            <Button variant="secondary" onClick={() => session.lock()}>{t("journal.lockRestore")}</Button>
            <Button variant="secondary" onClick={() => session.discardUnreadableJournal()}>{t("journal.setAside")}</Button>
          </div>
        </div>
      ) : null}
      <Suspense fallback={<div data-testid="loading" aria-busy="true" aria-label={t("common.loading")}><Skeleton height={160} /></div>}>
        <Outlet />
      </Suspense>
    </AppShell>
  );
}
