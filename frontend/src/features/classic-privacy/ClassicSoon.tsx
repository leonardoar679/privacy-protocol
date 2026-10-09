// Classic Privacy (spec §16): the entry under More exists from the shell on; the screens arrive in Stage 10.
import { useNavigate } from "react-router-dom";
import { Page, SecurityCard } from "../../design-system";
import { useT } from "../../app/i18n/useT";

export function ClassicSoon() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Page title={t("route.classic")} back={() => navigate("/more")} testId="classic">
      <SecurityCard icon="recovery" title={t("route.classic")} body={t("classic.soon")} />
    </Page>
  );
}
