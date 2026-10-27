// Settings (spec v3.0 §2; doc §3, §15; V7 Stage 4): one page, the sections the owner's document names — Backup &
// security, Connected wallet (the connection, the allowances, the Receive address), Trading preference, Language,
// Experience (Simple / Advanced), Notifications — and, in the Advanced experience, the way to the Advanced settings.
// The sections are the former More pages, unwrapped (features/more/Security.tsx, Wallet.tsx, Language.tsx), with every
// test id they had; the Settings page takes the id `settings` the Security page carried, and the old `/more/*` paths
// redirect here (routes/index.tsx), a `#section` hash scrolling to its section. Everything is journaled (encrypted) or
// a preference; nothing is sent anywhere.
import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { Card, Icon, ListRow, Page } from "@privacy-wallet/ui";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { requestSystemNotifications } from "@privacy-wallet/sdk/wallet/notifications";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { useT } from "../../app/i18n/useT";
import { useDeployment } from "../../app/deployment";
import type { MessageKey } from "../../app/i18n/en";
import type { ShellContext } from "../../app/Shell";
import { prefs } from "../../storage/prefs";
import { usePrefs, useSettings } from "../../hooks";
import { SecuritySection } from "../more/Security";
import { TradePreferenceSection, WalletSection } from "../more/Wallet";
import { LanguageSection } from "../more/Language";

/** The sections, in the document's order; each is an anchor (`/settings#wallet`) and a heading. */
export const SETTINGS_SECTIONS = ["backup", "wallet", "trading", "language", "experience", "notifications"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
const TITLE: Record<SettingsSection, MessageKey> = {
  backup: "settings.section.backup",
  wallet: "settings.section.wallet",
  trading: "settings.section.trading",
  language: "settings.section.language",
  experience: "settings.section.experience",
  notifications: "settings.section.notifications",
};

function Section({ id, children }: { id: SettingsSection; children: ReactNode }) {
  const t = useT();
  return (
    // a plain section (no accessible name, so no region landmark beside the shell's own — axe landmark-unique), anchored by its id
    <section className="ds-stack-sm" id={id} data-testid={`settings-${id}`}>
      <h2 className="ds-review-title">{t(TITLE[id])}</h2>
      {children}
    </section>
  );
}

export function Settings({
  deployment,
  hash = "",
  onBack,
  onReceive,
  onAdvanced,
  onConnect,
  onFees,
}: {
  deployment: Deployment | null;
  /** the location's hash: `#wallet` scrolls to the Connected wallet section */
  hash?: string;
  onBack?: () => void;
  onReceive: () => void;
  onAdvanced: () => void;
  /** Fees & refunds — the published policy (V7 Stage 12) */
  onFees?: () => void;
  /** opens the connector picker (the shell's sheet); without it the first wallet of the browser connects */
  onConnect?: () => void;
}) {
  const t = useT();
  const s = useSettings();
  const p = usePrefs();
  // `/settings#wallet` (and the old `/more/wallet`, redirected): the section scrolls into view once the page is there
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!(SETTINGS_SECTIONS as readonly string[]).includes(id)) return;
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  const n = s.protection.notifications;
  const setNotifications = (patch: Partial<typeof n>) => settings.set({ protection: { ...s.protection, notifications: { ...n, ...patch } } });
  async function enableSystemNotifications(on: boolean) {
    if (!on) {
      setNotifications({ system: false });
      return;
    }
    setNotifications({ system: await requestSystemNotifications() });
  }
  const toggle = (checked: boolean, onChange: (v: boolean) => void, text: string, testId: string) => (
    <label className="ds-switch-row ds-native-row">
      <span>{text}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
    </label>
  );
  return (
    <Page title={t("route.settings")} back={onBack} testId="settings">
      <div className="ds-stack">
        <Section id="backup">
          <SecuritySection />
        </Section>
        <Section id="wallet">
          <WalletSection deployment={deployment} onConnect={onConnect} />
          <Card padding="md" testId="receive-card">
            <ListRow
              title={t("route.receive")}
              subtitle={t("more.receiveWhy")}
              leading={<Icon name="receive" />}
              onPress={onReceive}
              testId="settings-receive"
            />
          </Card>
        </Section>
        <Section id="trading">
          <TradePreferenceSection />
          {onFees ? (
            <Card padding="md" testId="fees-card">
              <ListRow title={t("settings.feesAndRefunds")} subtitle={t("settings.feesAndRefundsWhy")} leading={<Icon name="recovery" />} onPress={onFees} testId="settings-fees" />
            </Card>
          ) : null}
        </Section>
        <Section id="language">
          <LanguageSection />
        </Section>
        <Section id="experience">
          <Card testId="experience">
            {toggle(
              s.advanced,
              (v) => {
                settings.set({ advanced: v });
                prefs().update({ experience: v ? "advanced" : "simple" });
              },
              t("more.experienceToggle"),
              "experience-toggle",
            )}
          </Card>
        </Section>
        <Section id="notifications">
          <Card testId="notifications">
            <div className="ds-stack-sm">
              <p className="ds-note">{t("settings.notificationsBody")}</p>
              {toggle(n.inApp, (v) => setNotifications({ inApp: v }), t("advanced.protection.inApp"), "notify-in-app")}
              {toggle(n.system, (v) => void enableSystemNotifications(v), t("advanced.protection.system"), "notify-system")}
              {toggle(n.generic, (v) => setNotifications({ generic: v }), t("advanced.protection.generic"), "notify-generic")}
            </div>
          </Card>
        </Section>
        {p.experience === "advanced" ? (
          <Card padding="md" testId="settings-advanced-card">
            <ListRow
              title={t("route.advanced")}
              subtitle={t("more.advancedWhy")}
              leading={<Icon name="gear" />}
              onPress={onAdvanced}
              testId="settings-advanced"
            />
          </Card>
        ) : null}
      </div>
    </Page>
  );
}

/** The route: Settings over the deployment; Receive and Advanced are routes of their own; the picker is the shell's. */
export function SettingsRoute() {
  const navigate = useNavigate();
  const deployment = useDeployment();
  const { hash } = useLocation();
  const shell = useOutletContext<ShellContext | undefined>();
  return (
    <Settings
      deployment={deployment}
      hash={hash}
      onBack={() => navigate(-1)}
      onReceive={() => navigate("/receive")}
      onAdvanced={() => navigate("/settings/advanced")}
      onFees={() => navigate("/privacy/fees")}
      onConnect={shell ? () => shell.openConnect() : undefined}
    />
  );
}
