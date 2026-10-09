// The legacy screens inside the new shell (spec §2, the migration order of the plan): each V1.1–V4 screen keeps its
// code and its test ids and is mounted on its route inside a Page, until the stage that replaces it. The props they
// took from App.tsx come from the session, the deployment context and the connection store.
import { useNavigate } from "react-router-dom";
import { Button, Page } from "../../design-system";
import { useT } from "../i18n/useT";
import { useDeployment } from "../deployment";
import { useUnlockedSeed } from "../Gate";
import { connection, shortAccount, useConnection } from "../../features/wallet/connection";
import { useStatusLines } from "./statusLines";
import { Shield } from "../../components/Shield";
import { Send } from "../../components/Send";
import { Withdraw } from "../../components/Withdraw";
import { Receive } from "../../components/Receive";
import { Swap } from "../../components/Swap";
import { Activity } from "../../components/Activity";
import { PrivacyCenter } from "../../components/PrivacyCenter";
import { Settings } from "../../components/Settings";
import { PrivateAI } from "../../components/PrivateAI";
import { Guest } from "../../components/Guest";
import { useState } from "react";

export function ProtectRoute() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const conn = useConnection();
  return (
    <Page title={t("route.protect")} back={() => navigate("/")} testId="protect">
      <div className="ds-switch-row">
        <span className="ds-field-hint" data-testid="protect-connection">{conn.account ? t("protect.connected", { account: shortAccount(conn.account) }) : t("protect.connectLine")}</span>
        {!conn.account ? <Button variant="secondary" loading={conn.status === "connecting"} onClick={() => void connection.connect()} data-testid="protect-connect">{t("protect.connect")}</Button> : null}
      </div>
      <Shield masterSeed={seed} deployment={deployment} />
    </Page>
  );
}

export function SendRoute() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  const [mode, setMode] = useState<"private" | "public">("private");
  return (
    <Page title={t("route.send")} back={() => navigate("/")} testId="send-tab">
      <div className="segment" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "private"} className={mode === "private" ? "active" : ""} onClick={() => setMode("private")}>{t("send.privately")}</button>
        <button type="button" role="tab" aria-selected={mode === "public"} className={mode === "public" ? "active" : ""} onClick={() => setMode("public")}>{t("send.public")}</button>
      </div>
      {mode === "private" ? <Send masterSeed={seed} deployment={deployment} /> : <Withdraw masterSeed={seed} deployment={deployment} account={account} />}
    </Page>
  );
}

export function ReceiveRoute() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  return <Page title={t("route.receive")} back={() => navigate("/")} testId="sheet-receive"><Receive masterSeed={seed} /></Page>;
}

export function SwapRoute() {
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  return <Swap masterSeed={seed} deployment={deployment} account={account} />;
}

export function ActivityRoute() {
  const deployment = useDeployment();
  return <Activity deployment={deployment} />;
}

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
