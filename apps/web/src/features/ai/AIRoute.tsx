// Private AI under More (spec §2): the V1.1–V2 screen keeps its code and its test ids, mounted inside a Page; a
// separate chunk loaded when the route opens (spec §20).
import { useNavigate } from "react-router-dom";
import { Page } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { PrivateAI } from "../../components/PrivateAI";

export function AIRoute() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  return <Page title={t("route.ai")} back={() => navigate("/more")} testId="sheet-ai"><PrivateAI masterSeed={seed} deployment={deployment} /></Page>;
}

export default AIRoute;
