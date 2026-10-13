// The Privacy Center (spec §3.13, §15; plan §30–§31, §56–§57; whale spec §23): the session facts, computed and never
// asserted — no analytics, the protected balance encrypted locally, a private operation, the destination isolated,
// no third-party tracking —, the §31 rows mapped to facts (the posture's level, the secure store, the read quorum
// and the light client, the relayer submission, the fresh destinations from the address book), the network
// visibility note with "Learn more" (§3.13 "What stays private?"), "Advanced privacy settings" (the six V2
// categories with their levels and "Why"), and what this wallet cannot promise — never hidden (plan V2 §69). The
// numbers come from the privacy lab's model; nothing is fetched.
import { useState } from "react";
import { Button, Card, Collapsible, Page, StatusBadge } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import type { Deployment } from "../../sdk/chain";
import { privacyRows, sessionFacts, type PrivacyRow } from "./status";
import { useAddressBook, usePoolStats, usePosture, useSettings } from "../../hooks";

const ROW_KEY: Record<PrivacyRow["id"], MessageKey> = { protection: "privacyCenter.row.protection", walletData: "privacyCenter.row.walletData", analytics: "privacyCenter.row.analytics", privateRpc: "privacyCenter.row.privateRpc", shielded: "privacyCenter.row.shielded", freshDestination: "privacyCenter.row.freshDestination" };

export function PrivacyCenter({ deployment, onBack, onLearnMore, defaultAdvanced = false }: { deployment: Deployment | null; onBack?: () => void; onLearnMore?: () => void; defaultAdvanced?: boolean }) {
  const t = useT();
  const posture = usePosture(deployment);
  const stats = usePoolStats();
  const s = useSettings();
  const book = useAddressBook();
  const facts = sessionFacts(s, book);
  const rows = privacyRows(posture, deployment, s, book);
  const [open, setOpen] = useState<string | null>(null);
  const check = (ok: boolean, label: string, id: string) => <span key={id} data-fact={id} data-ok={ok ? "1" : "0"}>{ok ? "✓" : "⚠"} {label}</span>;
  const rowValue = (r: PrivacyRow): string => {
    if (r.id === "protection") return r.level ? t(`privacyCenter.level.${r.level}` as MessageKey) : "—";
    if (r.id === "walletData") return t("privacyCenter.storedLocally");
    if (r.id === "analytics") return t("privacyCenter.off");
    return r.ok ? t("privacyCenter.enabled") : t("privacyCenter.disabled");
  };
  return (
    <Page title={t("route.privacy")} back={onBack} testId="privacy-center">
      <div className="ds-stack">
        <Card testId="session-facts">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("privacyCenter.sessionTitle")}</h2>
            <div className="ds-checks-line" data-testid="session-checks">
              {check(facts.analyticsOff, t("privacyCenter.fact.noAnalytics"), "analytics")}
              {check(facts.walletDataLocal, t("privacyCenter.fact.encryptedLocally"), "local")}
              {check(facts.privateOperation, t("privacyCenter.fact.privateOperation"), "private")}
              {check(facts.destinationIsolated, t("privacyCenter.fact.destinationIsolated"), "destination")}
              {check(facts.trackingOff, t("privacyCenter.fact.noTracking"), "tracking")}
            </div>
            <div className="ds-kv"><span className="ds-kv-label">{t("privacyCenter.networkVisibility")}</span><b className="ds-kv-value">{t("privacyCenter.publicData")}</b></div>
            <p className="ds-note">{t("privacyCenter.networkNote")}</p>
            {onLearnMore ? <div className="ds-actions"><Button variant="secondary" onClick={onLearnMore} data-testid="learn-more">{t("privacyCenter.learnMore")}</Button></div> : null}
          </div>
        </Card>
        <Card padding="none" testId="privacy-rows">
          {rows.map((r) => (
            <div key={r.id} className="ds-list-row ds-pad-md" data-testid="privacy-row" data-row={r.id} data-ok={r.ok ? "1" : "0"}>
              <span className="ds-list-main">{t(ROW_KEY[r.id])}</span>
              <StatusBadge tone={r.ok ? "ok" : "warn"}>{rowValue(r)}</StatusBadge>
            </div>
          ))}
        </Card>
        <Collapsible summary={t("privacyCenter.advancedSettings")} defaultOpen={defaultAdvanced} testId="privacy-advanced">
          <div className="ds-stack-sm" data-testid="privacy-categories">
            <div className="ds-kv"><span className="ds-kv-label">{t("privacyCenter.overall")}</span><b className={posture.overall ? `ds-level ds-level-${posture.overall}` : ""}>{posture.overall ?? "—"}</b></div>
            <p className="ds-note">{stats ? t("privacyCenter.poolHolds", { notes: stats.notes, time: new Date(stats.at).toLocaleTimeString() }) : t("privacyCenter.poolUnknown")} {t("privacyCenter.boundsNote")}</p>
            {posture.categories.map((c) => (
              <div key={c.id} className="ds-stack-sm" data-category={c.id}>
                <div className="ds-kv">
                  <span>{c.label}</span>
                  <span><span className="ds-note">{c.score === null ? "—" : `${c.score}/100`} </span><b className={c.level ? `ds-level ds-level-${c.level}` : ""}>{c.level ?? t("privacyCenter.unknown")}</b> <button type="button" className="ds-chip" aria-expanded={open === c.id} onClick={() => setOpen((v) => (v === c.id ? null : c.id))}>{open === c.id ? t("privacyCenter.hide") : t("privacyCenter.why")}</button></span>
                </div>
                {open === c.id ? <ul className="ds-plain-list ds-note">{c.why.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
              </div>
            ))}
          </div>
        </Collapsible>
        <Card testId="privacy-limits-card">
          <h2 className="ds-review-title">{t("privacyCenter.limitsTitle")}</h2>
          <ul className="ds-plain-list ds-note" data-testid="privacy-limits">{posture.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </Card>
      </div>
    </Page>
  );
}
