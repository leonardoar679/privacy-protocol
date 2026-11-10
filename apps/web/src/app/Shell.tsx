// The shell (spec v2.0 §6; doc §11–§12, §53–§54, §88): on a phone the bottom bar `Home · Swap · Activity · More` — four
// items, never more —; from 1024 px one top bar `Logo · Home Swap Activity · Wallet` above the content, its Wallet menu
// holding the connection and every More entry (the same list as the More screen, so nothing on a phone is out of reach
// on a desktop). Then the journal notice when the stored journal would not decrypt, and the screen of the current
// route; the background jobs run beside it while the wallet is unlocked. V7 Stage 4 (spec v3.0 §2): the Wallet menu
// holds the Connect wallet button (the account chip once connected) and More = Tornado Classic · Privacy Center ·
// Settings (Private AI in the Advanced experience); the connector picker is a sheet the shell owns, opened from the
// menu and from Home's header through the outlet context; More stays highlighted on /privacy and /settings.
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppShell, Button, Icon, ListRow, Skeleton, StatusBadge, WarningCard, type NavItem, type ShellNav, type StatusTone } from "@privacy-wallet/ui";
import { shortAccount, type ConnectionStatus } from "@privacy-wallet/wallet-engine/connection";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useT } from "./i18n/useT";
import type { MessageKey } from "./i18n/en";
// V6 Stage 16: the runners and the scheduler load after the shell renders (they are not on Home's critical path)
const Background = lazy(() => import("./Background").then((m) => ({ default: m.Background })));
// the notice of a scan the counters wait on that failed (the twelfth review round, W6 §5.4), loaded with them: discovery.ts is not on the first route
const ScanHeldNotice = lazy(() => import("./ScanHeldNotice").then((m) => ({ default: m.ScanHeldNotice })));
import { NotificationToasts } from "./notifications";
import { StorageNotice } from "./StorageNotice";
import { PublicWalletNotice } from "./PublicWalletNotice";
import { useConnection, useConnectivity, usePrefs, useSession } from "../hooks/core";
import { moreEntries } from "../features/more/entries";
import { ConnectSheet } from "../features/wallet/ConnectSheet";

const TONE: Record<ConnectionStatus, StatusTone> = {
  connected: "ok",
  connecting: "pending",
  "wrong-network": "warn",
  disconnected: "neutral",
  unavailable: "neutral",
};

/** What the shell hands its screens (react-router's outlet context): the way to open the connector picker. */
export interface ShellContext {
  openConnect: () => void;
}

export function Shell() {
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const s = useSession();
  const p = usePrefs();
  const conn = useConnection();
  const [connectOpen, setConnectOpen] = useState(false);
  const openConnect = useCallback(() => setConnectOpen(true), []);
  const shellContext = useMemo<ShellContext>(() => ({ openConnect }), [openConnect]);
  const home: NavItem = { to: "/", label: t("nav.home"), icon: "home", testId: "nav-home" };
  const swap: NavItem = { to: "/swap", label: t("nav.swap"), icon: "swap", testId: "nav-swap" };
  const activity: NavItem = { to: "/activity", label: t("nav.activity"), icon: "activity", testId: "nav-activity" };
  const more: NavItem = { to: "/more", label: t("nav.more"), icon: "more", testId: "nav-more", also: ["/privacy", "/settings"] };
  const status = t(`wallet.status.${conn.status}` as MessageKey);
  const nav: ShellNav = {
    brand: (
      <>
        <Icon name="shield-check" size={22} />
        <span>{t("app.name")}</span>
      </>
    ),
    items: [home, swap, activity, more],
    desktopItems: [home, swap, activity],
    current: pathname,
    onSelect: (to) => navigate(to),
    label: t("nav.main"),
    menu: {
      label: t("nav.wallet"),
      icon: "wallet",
      testId: "nav-wallet",
      content: (close) => (
        <>
          <div className="ds-kv" data-testid="menu-connection">
            <span className="ds-kv-label">{t("wallet.connection")}</span>
            <StatusBadge tone={TONE[conn.status]}>{conn.account ? `${status} · ${shortAccount(conn.account)}` : status}</StatusBadge>
          </div>
          <Button
            variant="secondary"
            full
            icon="wallet"
            onClick={() => {
              close();
              openConnect();
            }}
            data-testid="menu-connect"
          >
            {conn.account ? shortAccount(conn.account) : t("protect.connect")}
          </Button>
          {moreEntries(p.experience === "advanced" ? "advanced" : "simple").map((e) =>
            e.external ? (
              <ListRow key={e.id} title={t(e.title)} leading={<Icon name={e.icon} />} href={e.to} testId={`menu-${e.id}`} />
            ) : (
              <ListRow
                key={e.id}
                title={t(e.title)}
                leading={<Icon name={e.icon} />}
                onPress={() => {
                  close();
                  navigate(e.to);
                }}
                testId={`menu-${e.id}`}
              />
            ),
          )}
        </>
      ),
    },
  };
  return (
    <AppShell nav={nav}>
      <Suspense fallback={null}>
        <Background />
      </Suspense>
      <NotificationToasts />
      <ConnectionBanner />
      <Suspense fallback={null}>
        <ScanHeldNotice />
      </Suspense>
      <StorageNotice />
      <PublicWalletNotice />
      {s.journalUnreadable ? (
        <div className="notice" data-testid="journal-unreadable">
          <p>
            <b>{t("journal.unreadableTitle")}</b> {t("journal.unreadableBody")}
          </p>
          <div className="ds-chips">
            <Button variant="secondary" onClick={() => session.lock()}>
              {t("journal.lockRestore")}
            </Button>
            <Button variant="secondary" onClick={() => session.discardUnreadableJournal()}>
              {t("journal.setAside")}
            </Button>
          </div>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div data-testid="loading" aria-busy="true" aria-label={t("common.loading")}>
            <Skeleton height={160} />
          </div>
        }
      >
        <Outlet context={shellContext} />
      </Suspense>
      <ConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} />
    </AppShell>
  );
}

/** Doc §75 (spec v2.0 §7.11): over every screen while the connection is interrupted; the operations pause meanwhile. */
function ConnectionBanner() {
  const t = useT();
  const net = useConnectivity();
  if (net.online) return null;
  return (
    <div role="status" aria-live="polite" className="ds-connection-banner">
      <WarningCard
        title={t("offline.title")}
        body={
          <>
            <p>{t("offline.preserved")}</p>
            <p>{t("offline.noSubmit")}</p>
          </>
        }
        testId="offline-banner"
      />
    </div>
  );
}
