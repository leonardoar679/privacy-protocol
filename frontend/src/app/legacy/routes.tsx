// The legacy screens inside the new shell (spec §2, the migration order of the plan): each V1.1–V4 screen keeps its
// code and its test ids and is mounted on its route inside a Page, until the stage that replaces it. The props they
// took from App.tsx come from the session, the deployment context and the connection store.
import { useNavigate } from "react-router-dom";
import { Page } from "../../design-system";
import { useT } from "../i18n/useT";
import { useDeployment } from "../deployment";
import { useUnlockedSeed } from "../Gate";
import { useConnection } from "../../features/wallet/connection";
import { useStatusLines } from "./statusLines";
import { PrivacyCenter } from "../../components/PrivacyCenter";
import { Settings } from "../../components/Settings";
import { PrivateAI } from "../../components/PrivateAI";
import { Guest } from "../../components/Guest";

export function PrivacyRoute() {
  const t = useT();
  const navigate = useNavigate();
  const deployment = useDeployment();
  return <Page title={t("route.privacy")} back={() => navigate(-1)} testId="sheet-privacy"><PrivacyCenter deployment={deployment} /></Page>;
}

export function SettingsRoute({ title }: { title: "route.security" | "route.wallet" | "route.advanced" }) {
  const t = useT();
  const navigate = useNavigate();
  const deployment = useDeployment();
  const { account } = useConnection();
  const { readsLine, coreLine } = useStatusLines(deployment);
  return <Page title={t(title)} back={() => navigate(-1)} testId="sheet-settings"><Settings deployment={deployment} readsLine={readsLine} coreLine={coreLine} account={account} /></Page>;
}

export function AIRoute() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  return <Page title={t("route.ai")} back={() => navigate("/more")} testId="sheet-ai"><PrivateAI masterSeed={seed} deployment={deployment} /></Page>;
}

export function GuestRoute() {
  const navigate = useNavigate();
  return <div className="ds-main"><Guest onBack={() => navigate("/unlock")} /></div>;
}
