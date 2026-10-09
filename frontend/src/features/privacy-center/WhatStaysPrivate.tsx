// "What stays private?" (spec §3.13; plan §56): what is not stored as plain public blockchain data, what remains
// public, the one sentence on the whole path, then the LIMITS of @ref/wallet/privacyCenter — the same words
// everywhere. "100 % anonymous" never appears.
import { LIMITS } from "@ref/wallet/privacyCenter";
import { Card, Page } from "../../design-system";
import { useT } from "../../app/i18n/useT";

export function WhatStaysPrivate({ onBack }: { onBack?: () => void }) {
  const t = useT();
  return (
    <Page title={t("whatStaysPrivate.title")} back={onBack} testId="what-stays-private">
      <div className="ds-stack">
        <Card>
          <div className="ds-stack-sm">
            <h3 className="ds-review-title">{t("whatStaysPrivate.title")}</h3>
            <p className="ds-note">{t("whatStaysPrivate.private")}</p>
            <h3 className="ds-review-title">{t("whatStaysPrivate.publicTitle")}</h3>
            <p className="ds-note">{t("whatStaysPrivate.public")}</p>
            <p className="ds-note">{t("whatStaysPrivate.path")}</p>
          </div>
        </Card>
        <Card>
          <h3 className="ds-review-title">{t("privacyCenter.limitsTitle")}</h3>
          <ul className="ds-plain-list ds-note" data-testid="limits">{LIMITS.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </Card>
      </div>
    </Page>
  );
}
