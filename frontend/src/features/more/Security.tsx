// More → Security (spec §2, §3.2, §9, §11; plan §13, §26): the backup status with the date, Back up now (the backup
// file: the keystore and the encrypted journal, opened only with the password) and the recovery phrase after the
// password, Lock, the second confirmation (the platform authenticator; the password stays the fallback), the large
// transfer thresholds (the two consumer bands and the V2–V4 tiers, user-adjustable, increasing), and Forget behind a
// typed confirmation in a dialog. Everything is journaled (encrypted); nothing is sent anywhere.
import { useState } from "react";
import { checkThresholds, TIER_DEFAULTS, type TierThresholds } from "@ref/wallet/valuation";
import { Button, Card, Collapsible, Field, Modal, Page, StatusBadge, TextInput } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { registerSecondFactor, webauthnAvailable } from "../../sdk/secondFactor";
import { prefs, usePrefs } from "../../storage/prefs";
import { session } from "../../wallet/session";
import { settings, useSettings } from "../../wallet/settings";

const TIER_FIELDS: { key: keyof TierThresholds; label: MessageKey }[] = [
  { key: "large", label: "security.tier.large" }, { key: "largeProtected", label: "security.tier.largeProtected" }, { key: "enhanced", label: "security.tier.enhanced" },
  { key: "highValue", label: "security.tier.highValue" }, { key: "highValueSecondary", label: "security.tier.highValueSecondary" }, { key: "institutional", label: "security.tier.institutional" },
];
const tiersOf = (t: TierThresholds): Record<keyof TierThresholds, string> => ({ large: String(t.large ?? TIER_DEFAULTS.large), largeProtected: String(t.largeProtected ?? TIER_DEFAULTS.largeProtected), enhanced: String(t.enhanced), highValue: String(t.highValue), highValueSecondary: String(t.highValueSecondary), institutional: String(t.institutional) });

export function downloadBackup(): void {
  const json = session.exportBackup();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `privacy-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const current = prefs().get().backup ?? {};
  prefs().update({ backup: { ...current, exportedAt: Date.now() } });
}

export function Security({ onBack }: { onBack?: () => void }) {
  const t = useT();
  const s = useSettings();
  const p = usePrefs();
  const [tiers, setTiers] = useState(() => tiersOf(s.tiers));
  const [tierError, setTierError] = useState("");
  const [factorStatus, setFactorStatus] = useState("");
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forget, setForget] = useState("");
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phraseError, setPhraseError] = useState("");
  const backedUp = p.backup?.exportedAt ?? p.backup?.phraseAcknowledgedAt;

  function applyTiers() {
    const next: TierThresholds = { large: Number(tiers.large), largeProtected: Number(tiers.largeProtected), enhanced: Number(tiers.enhanced), highValue: Number(tiers.highValue), highValueSecondary: Number(tiers.highValueSecondary), institutional: Number(tiers.institutional) };
    try { checkThresholds(next); settings.set({ tiers: next }); setTierError(""); } catch (e) { setTierError(e instanceof Error ? e.message : String(e)); }
  }
  function resetTiers() { settings.set({ tiers: { ...TIER_DEFAULTS } }); setTiers(tiersOf(TIER_DEFAULTS)); setTierError(""); }
  async function registerFactor() {
    setFactorStatus(t("security.factor.registering"));
    try { const credentialId = await registerSecondFactor(); settings.set({ secondFactor: { enabled: true, credentialId } }); setFactorStatus(t("security.factor.registered")); } catch (e) { setFactorStatus(e instanceof Error ? e.message : String(e)); }
  }
  async function reveal() {
    setPhraseError("");
    const words = await session.revealPhrase(password);
    if (!words) { setPhraseError(t("security.phrase.wrongPassword")); return; }
    setPhrase(words); setPassword("");
    const current = prefs().get().backup ?? {};
    prefs().update({ backup: { ...current, phraseAcknowledgedAt: Date.now() } });
  }

  return (
    <Page title={t("route.security")} back={onBack} testId="settings">
      <div className="ds-stack" data-testid="security">
        <Card testId="backup-status">
          <div className="ds-stack-sm">
            <div className="ds-kv"><span className="ds-kv-label">{t("security.backupStatus")}</span><StatusBadge tone={backedUp ? "ok" : "warn"} testId="backup-badge">{backedUp ? t("security.backedUp", { date: new Date(backedUp).toLocaleDateString() }) : t("security.notBackedUp")}</StatusBadge></div>
            <p className="ds-note">{t("security.backupBody")}</p>
            <div className="ds-actions">
              <Button onClick={downloadBackup} icon="download" data-testid="backup-now">{t("backup.now")}</Button>
              <Button variant="secondary" onClick={() => { setPhraseOpen((v) => !v); setPhrase(null); setPhraseError(""); }} icon="key" data-testid="show-phrase">{t("security.showPhrase")}</Button>
              <Button variant="secondary" onClick={() => session.lock()} icon="lock" data-testid="lock-wallet">{t("security.lock")}</Button>
            </div>
            {phraseOpen ? (
              <div className="ds-stack-sm" data-testid="phrase-panel">
                {phrase ? <code className="ds-mono-break" data-testid="phrase-words">{phrase}</code> : (
                  <>
                    <Field label={t("security.phrase.password")} htmlFor="phrase-password"><TextInput id="phrase-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
                    <Button variant="secondary" onClick={() => void reveal()} disabled={!password} data-testid="reveal-phrase">{t("security.phrase.reveal")}</Button>
                  </>
                )}
                {phraseError ? <p className="ds-field-error">{phraseError}</p> : null}
                <p className="ds-note">{t("security.phrase.note")}</p>
              </div>
            ) : null}
          </div>
        </Card>

        <Card testId="second-factor">
          <div className="ds-stack-sm">
            <h3 className="ds-review-title">{t("security.factor.title")}</h3>
            <p className="ds-note">{t("security.factor.body")}</p>
            <div className="ds-kv"><span className="ds-kv-label">{t("security.factor.authenticator")}</span><b className="ds-kv-value">{s.secondFactor.credentialId ? t("security.factor.registeredHere") : webauthnAvailable() ? t("security.factor.notRegistered") : t("security.factor.unavailable")}</b></div>
            <div className="ds-actions">
              {!s.secondFactor.credentialId ? <Button variant="secondary" onClick={() => void registerFactor()} disabled={!webauthnAvailable()}>{t("security.factor.register")}</Button> : null}
              {s.secondFactor.credentialId ? <Button variant="secondary" onClick={() => { settings.set({ secondFactor: { enabled: false } }); setFactorStatus(t("security.factor.removed")); }}>{t("security.factor.remove")}</Button> : null}
            </div>
            {factorStatus ? <p className="ds-note">{factorStatus}</p> : null}
          </div>
        </Card>

        <Card testId="large-transfers">
          <div className="ds-stack-sm">
            <h3 className="ds-review-title">{t("security.tiers.title")}</h3>
            <p className="ds-note">{t("security.tiers.body")}</p>
            {TIER_FIELDS.map((f) => (
              <Field key={f.key} label={t(f.label)} htmlFor={`tier-${f.key}`}>
                <TextInput id={`tier-${f.key}`} inputMode="numeric" value={tiers[f.key]} onChange={(e) => setTiers({ ...tiers, [f.key]: e.target.value.replace(/[^0-9]/g, "") })} onBlur={applyTiers} data-testid={`tier-${f.key}`} />
              </Field>
            ))}
            {tierError ? <p className="ds-field-error" data-testid="tier-error">{tierError}</p> : null}
            <div className="ds-actions"><Button variant="secondary" onClick={resetTiers}>{t("security.tiers.reset")}</Button></div>
          </div>
        </Card>

        <Collapsible summary={t("security.forget.title")} testId="forget-section">
          <p className="ds-note">{t("security.forget.body")}</p>
          <Button variant="danger" onClick={() => setForgetOpen(true)} data-testid="forget-open">{t("security.forget.open")}</Button>
        </Collapsible>
        <Modal open={forgetOpen} onClose={() => { setForgetOpen(false); setForget(""); }} title={t("security.forget.title")} description={t("security.forget.body")} danger testId="forget-modal">
          <Field label={t("security.forget.typeWord")} htmlFor="forget-word"><TextInput id="forget-word" value={forget} onChange={(e) => setForget(e.target.value)} placeholder="FORGET" autoComplete="off" data-testid="forget-input" /></Field>
          <Button variant="danger" full disabled={forget !== "FORGET"} onClick={() => session.forget()} data-testid="forget-confirm">{t("security.forget.confirm")}</Button>
        </Modal>
      </div>
    </Page>
  );
}
