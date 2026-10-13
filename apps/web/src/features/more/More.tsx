// The More menu (spec §2, §6): the Privacy Center, Security, Wallet, Classic Privacy, Private AI; Advanced only when the
// experience says so; the experience switch itself (it writes the preference and the journal's advanced flag). Each
// row is a route.
import { useNavigate } from "react-router-dom";
import { Card, Icon, ListRow, Page } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { prefs } from "../../storage/prefs";
import { settings } from "../../wallet/settings";
import { usePrefs, useSettings } from "../../hooks";

export function More() {
  const t = useT();
  const navigate = useNavigate();
  const p = usePrefs();
  const s = useSettings();
  return (
    <Page title={t("route.more")} testId="more">
      <div className="ds-stack">
        <Card padding="md">
          <ListRow title={t("route.privacy")} subtitle={t("more.privacyWhy")} leading={<Icon name="shield" />} onPress={() => navigate("/more/privacy")} testId="more-privacy" />
          <ListRow title={t("route.security")} subtitle={t("more.securityWhy")} leading={<Icon name="lock" />} onPress={() => navigate("/more/security")} testId="more-security" />
          <ListRow title={t("route.wallet")} subtitle={t("more.walletWhy")} leading={<Icon name="wallet" />} onPress={() => navigate("/more/wallet")} testId="more-wallet" />
          <ListRow title={t("route.classic")} subtitle={t("more.classicWhy")} leading={<Icon name="recovery" />} onPress={() => navigate("/more/classic")} testId="more-classic" />
          <ListRow title={t("route.ai")} subtitle={t("more.aiWhy")} leading={<Icon name="globe" />} onPress={() => navigate("/more/ai")} testId="more-ai" />
          {p.experience === "advanced" ? <ListRow title={t("route.advanced")} subtitle={t("more.advancedWhy")} leading={<Icon name="gear" />} onPress={() => navigate("/more/advanced")} testId="more-advanced" /> : null}
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
