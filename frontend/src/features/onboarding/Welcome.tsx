// The first launch (spec §3.1): the promise, Connect Wallet (optional), then Simple or Advanced — Simple by default.
// The choice is a preference (spec §8), written here and mirrored into the journal at unlock.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Page, RadioGroup } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { prefs } from "../../storage/prefs";
import { connection, shortAccount, useConnection } from "../wallet/connection";

export function Welcome() {
  const t = useT();
  const navigate = useNavigate();
  const conn = useConnection();
  const [step, setStep] = useState<"promise" | "experience">("promise");
  const [experience, setExperience] = useState<"simple" | "advanced">("simple");
  const finish = () => {
    prefs().update({ experience, firstLaunchDone: true });
    navigate("/create", { replace: true });
  };
  if (step === "promise") {
    return (
      <div className="ds-main">
        <Page title={t("app.name")} testId="welcome">
          <Card padding="lg">
            <h2 className="ds-error-title">{t("welcome.title")}</h2>
            <p>{t("welcome.body")}</p>
            {conn.status === "connected" && conn.account ? <p className="ds-field-hint" data-testid="welcome-connected">{t("welcome.connected", { account: shortAccount(conn.account) })}</p> : null}
            {conn.status === "unavailable" ? <p className="ds-field-hint" role="status">{t("welcome.unavailable")}</p> : null}
            {conn.status === "connected" ? <Button size="lg" full onClick={() => setStep("experience")} data-testid="welcome-continue">{t("common.continue")}</Button>
              : <Button size="lg" full loading={conn.status === "connecting"} onClick={() => void connection.connect()} data-testid="welcome-connect">{t("welcome.connect")}</Button>}
            <p className="ds-field-hint">{t("welcome.noAccount")}</p>
            {conn.status !== "connected" ? <Button variant="ghost" full onClick={() => setStep("experience")} data-testid="welcome-skip">{t("welcome.skip")}</Button> : null}
          </Card>
        </Page>
      </div>
    );
  }
  return (
    <div className="ds-main">
      <Page title={t("experience.title")} back={() => setStep("promise")} testId="experience">
        <RadioGroup value={experience} onValueChange={(v) => setExperience(v === "advanced" ? "advanced" : "simple")} ariaLabel={t("experience.title")} name="experience"
          options={[{ value: "simple", label: t("experience.simple"), description: t("experience.simpleWhy"), testId: "experience-simple" }, { value: "advanced", label: t("experience.advanced"), description: t("experience.advancedWhy"), testId: "experience-advanced" }]} />
        <Button size="lg" full onClick={finish} data-testid="experience-continue">{t("common.continue")}</Button>
      </Page>
    </div>
  );
}
