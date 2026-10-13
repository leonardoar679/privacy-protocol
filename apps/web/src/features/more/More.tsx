// The More menu (spec v2.0 §6, §7.10): the Privacy Center, Security, Wallet, Classic Privacy, Private AI; Advanced only
// when the experience says so (one list with the desktop's Wallet menu: ./entries.ts); the experience switch itself (it
// writes the preference and the journal's advanced flag). Each row is a route.
import { useNavigate } from "react-router-dom";
import { Card, Icon, ListRow, Page } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { prefs } from "../../storage/prefs";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { usePrefs, useSettings } from "../../hooks";
import { moreEntries } from "./entries";

export function More() {
  const t = useT();
  const navigate = useNavigate();
  const p = usePrefs();
  const s = useSettings();
  return (
    <Page title={t("route.more")} testId="more">
      <div className="ds-stack">
        <Card padding="md">
          {moreEntries(p.experience === "advanced" ? "advanced" : "simple").map((e) => (
            <ListRow key={e.id} title={t(e.title)} subtitle={t(e.subtitle)} leading={<Icon name={e.icon} />} onPress={() => navigate(e.to)} testId={`more-${e.id}`} />
          ))}
        </Card>
        <Card testId="experience">
          <label className="ds-switch-row ds-native-row">
            <span className="ds-radio-text"><b>{t("more.experienceTitle")}</b><span className="ds-radio-desc">{t("more.experienceToggle")}</span></span>
            <input type="checkbox" checked={s.advanced} onChange={(e) => { settings.set({ advanced: e.target.checked }); prefs().update({ experience: e.target.checked ? "advanced" : "simple" }); }} data-testid="experience-toggle" />
          </label>
        </Card>
      </div>
    </Page>
  );
}
