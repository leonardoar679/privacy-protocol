// The More menu (spec §2): the Privacy Center, Security, Wallet, Classic Privacy, Private AI; Advanced only when the
// experience says so. Each row is a route.
import { useNavigate } from "react-router-dom";
import { Card, Icon, ListRow, Page } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { usePrefs } from "../../storage/prefs";

export function More() {
  const t = useT();
  const navigate = useNavigate();
  const p = usePrefs();
  return (
    <Page title={t("route.more")} testId="more">
      <Card padding="md">
        <ListRow title={t("route.privacy")} subtitle={t("more.privacyWhy")} leading={<Icon name="shield" />} onPress={() => navigate("/more/privacy")} testId="more-privacy" />
        <ListRow title={t("route.security")} subtitle={t("more.securityWhy")} leading={<Icon name="lock" />} onPress={() => navigate("/more/security")} testId="more-security" />
        <ListRow title={t("route.wallet")} subtitle={t("more.walletWhy")} leading={<Icon name="wallet" />} onPress={() => navigate("/more/wallet")} testId="more-wallet" />
        <ListRow title={t("route.classic")} subtitle={t("more.classicWhy")} leading={<Icon name="recovery" />} onPress={() => navigate("/more/classic")} testId="more-classic" />
        <ListRow title={t("route.ai")} subtitle={t("more.aiWhy")} leading={<Icon name="globe" />} onPress={() => navigate("/more/ai")} testId="more-ai" />
        {p.experience === "advanced" ? <ListRow title={t("route.advanced")} subtitle={t("more.advancedWhy")} leading={<Icon name="gear" />} onPress={() => navigate("/more/advanced")} testId="more-advanced" /> : null}
      </Card>
    </Page>
  );
}
