// The Privacy Center (spec v2.0 §7.10; doc §36; V6 Stage 14): the indicator — "🛡 High protection", with "Some blockchain
// metadata remains public." —, then the seven sections, each row a fact with its value; "Data sent to services" names
// every service this build talks to and what it receives, what the swap API keeps (for a swap only) and what no service
// keeps; Advanced settings keeps the six categories with their "Why", and what this wallet cannot promise is never
// hidden. Pure: ./PrivacyCenter.tsx gathers the facts through ./model.ts.
import { useState } from "react";
import { Card, Collapsible, Page, ProtectionBadge, StatusBadge, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { en, type MessageKey } from "../../app/i18n/en";

export type CenterLevel = "high" | "medium" | "low";
export type SectionId = "protection" | "wallet" | "network" | "transaction" | "stored" | "sent" | "advanced";
export type Tone = "ok" | "warn" | "neutral";
export interface CenterRow {
  id: string;
  label: MessageKey;
  /** the fact's value (a badge on the right); a row with a detail or items carries it, if at all, as a caption */
  value?: MessageKey;
  vars?: Record<string, string | number>;
  tone: Tone;
  /** a sentence under the row (the services' "what it receives") */
  detail?: MessageKey;
  /** a list worded item by item (what the API keeps, what nothing keeps) */
  items?: MessageKey[];
}
export interface CenterSection {
  id: SectionId;
  title: MessageKey;
  rows: CenterRow[];
  note?: MessageKey;
}
export interface PostureView {
  /** the posture's overall word (V4: Excellent / Good / Reduced), mapped to the V6 levels here */
  overall: "Excellent" | "Good" | "Reduced" | null;
  categories: { id: string; label: string; score: number | null; level: string | null; why: string[] }[];
  limits: string[];
}
export interface PrivacyCenterModel {
  level: CenterLevel | null;
  sections: CenterSection[];
  categories: PostureView["categories"];
  overallWord: PostureView["overall"];
  poolNotes: number | null;
  limits: string[];
}

const BADGE: Record<CenterLevel, "High" | "Reduced"> = { high: "High", medium: "Reduced", low: "Reduced" };
/** V6 Stage 16: the posture states its limits in English (the protocol's LIMITS); the catalog says each in the reader's
 *  language — found by its English words, so a limit the catalog does not know shows as it came. */
export const LIMIT_KEYS: readonly MessageKey[] = [
  "privacyCenter.limit.deposit",
  "privacyCenter.limit.ip",
  "privacyCenter.limit.provider",
  "privacyCenter.limit.pool",
  "privacyCenter.limit.trace",
];
const limitKey = (sentence: string): MessageKey | undefined => LIMIT_KEYS.find((k) => en[k] === sentence);
const INDICATOR: Record<CenterLevel, MessageKey> = {
  high: "screen.swap.protectionHigh",
  medium: "screen.swap.protectionMedium",
  low: "screen.swap.protectionLow",
};

export interface PrivacyCenterActions {
  onBack?: () => void;
  /** "What stays private?" */
  onLearnMore?: () => void;
  /** More → Advanced (the protection's opt-out, the reads, the submission) */
  onSettings?: () => void;
}

function Row({ r }: { r: CenterRow }) {
  const t = useT();
  const text = !!r.detail || !!r.items; // a service or a list: the words under the title, nothing on the right
  return (
    <div className="ds-list-row" data-testid="privacy-row" data-row={r.id} data-tone={r.tone}>
      <div className="ds-list-main">
        <b>{t(r.label)}</b>
        {text && r.value ? <span className="ds-list-sub">{t(r.value, r.vars)}</span> : null}
        {r.detail ? <span className="ds-list-sub">{t(r.detail)}</span> : null}
        {r.items ? (
          <ul className="ds-plain-list ds-note" data-testid={`privacy-items-${r.id}`}>
            {r.items.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {!text && r.value ? (
        r.tone === "neutral" ? (
          <span className="ds-note">{t(r.value, r.vars)}</span>
        ) : (
          <StatusBadge tone={r.tone === "ok" ? "ok" : "warn"}>{t(r.value, r.vars)}</StatusBadge>
        )
      ) : null}
    </div>
  );
}

export function PrivacyCenterView({
  model: m,
  actions: a,
  defaultAdvanced = false,
}: {
  model: PrivacyCenterModel;
  actions: PrivacyCenterActions;
  defaultAdvanced?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Page title={t("route.privacy")} back={a.onBack} testId="privacy-center">
      <div className="ds-stack">
        {m.sections.map((s) =>
          s.id === "advanced" ? (
            <Card key={s.id} testId={`privacy-section-${s.id}`}>
              <Collapsible summary={t(s.title)} defaultOpen={defaultAdvanced} testId="privacy-advanced">
                <div className="ds-stack-sm" data-testid="privacy-categories">
                  <p className="ds-note">
                    {m.poolNotes !== null ? t("privacyCenter.poolHoldsNow", { notes: m.poolNotes }) : t("privacyCenter.poolUnknown")}{" "}
                    {s.note ? t(s.note) : null}
                  </p>
                  {m.categories.map((c) => (
                    <div key={c.id} className="ds-stack-sm" data-category={c.id}>
                      <div className="ds-kv">
                        <span>{c.label}</span>
                        <span>
                          <span className="ds-note">{c.score === null ? "—" : `${c.score}/100`} </span>
                          <button type="button" className="ds-chip" aria-expanded={open === c.id} onClick={() => setOpen((v) => (v === c.id ? null : c.id))}>
                            {open === c.id ? t("privacyCenter.hide") : t("privacyCenter.why")}
                          </button>
                        </span>
                      </div>
                      {open === c.id ? (
                        <ul className="ds-plain-list ds-note">
                          {c.why.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                  {a.onSettings ? (
                    <TextButton icon="chevron-right" onClick={a.onSettings} data-testid="privacy-settings">
                      {t("privacyCenter.moreSettings")}
                    </TextButton>
                  ) : null}
                </div>
              </Collapsible>
            </Card>
          ) : (
            <Card key={s.id} testId={`privacy-section-${s.id}`}>
              <div className="ds-stack-sm">
                <h2 className="ds-card-title">{t(s.title)}</h2>
                {s.id === "protection" ? (
                  // the indicator is the section's fact (doc §35): "🛡 High protection", the reasons in a swap's "Why?"
                  <div data-testid="privacy-indicator" data-row="protection" data-tone={s.rows[0]?.tone}>
                    {m.level ? (
                      <ProtectionBadge level={BADGE[m.level]} label={`🛡 ${t(INDICATOR[m.level])}`} />
                    ) : (
                      <span className="ds-note">{t("privacyCenter.unknown")}</span>
                    )}
                  </div>
                ) : (
                  <div>
                    {s.rows.map((r) => (
                      <Row key={r.id} r={r} />
                    ))}
                  </div>
                )}
                {s.note ? <p className="ds-note">{t(s.note)}</p> : null}
                {s.id === "network" && a.onLearnMore ? (
                  <TextButton icon="chevron-right" onClick={a.onLearnMore} data-testid="learn-more">
                    {t("privacyCenter.learnMore")}
                  </TextButton>
                ) : null}
              </div>
            </Card>
          ),
        )}
        <Card testId="privacy-limits-card">
          <h2 className="ds-card-title">{t("privacyCenter.limitsTitle")}</h2>
          <ul className="ds-plain-list ds-note" data-testid="privacy-limits">
            {m.limits.map((l, i) => {
              const k = limitKey(l);
              return <li key={i}>{k ? t(k) : l}</li>;
            })}
          </ul>
        </Card>
      </div>
    </Page>
  );
}
