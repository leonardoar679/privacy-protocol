// The recovery phrase, shown once after a wallet is created (spec §3.2, §9): the 24 words, an acknowledgement, Continue.
import { useState } from "react";
import { Button, Card, Page } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { session } from "../../wallet/session";

export function Phrase({ phrase }: { phrase: string }) {
  const t = useT();
  const [ack, setAck] = useState(false);
  return (
    <div className="ds-main">
      <Page title={t("phrase.title")}>
        <Card padding="lg" testId="recovery-phrase">
          <p className="ds-field-hint">{t("phrase.body")}</p>
          <code className="ds-numeral" data-testid="phrase-words">{phrase}</code>
          <label className="ds-switch-row">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="phrase-ack" />
            <span>{t("phrase.ack")}</span>
          </label>
          <Button size="lg" full disabled={!ack} onClick={() => session.acknowledgePhrase()} data-testid="phrase-continue">{t("common.continue")}</Button>
        </Card>
      </Page>
    </div>
  );
}
