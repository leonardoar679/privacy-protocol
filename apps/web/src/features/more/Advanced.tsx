// More → Advanced (spec §2, §6; High-Value Protection spec §14; plan V3 §59, §72, §74; V4 §62, §92, §127–§128): the
// technical detail and the controls the Simple experience hides — the deployment and the crypto core, the light client
// and the submission path, protected balance maintenance, the protected-execution knobs with the two-step opt-out,
// the second device, the address book. Every test id of the V2–V4 Settings screen is kept; everything is journaled
// (encrypted) and nothing is sent anywhere. V6 Stage 10 (doc §71): the deployment fingerprint remembered at the first
// operation, and the deliberate way to forget it (the next operation then remembers the deployment this app names).
import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { Button, Card, Field, Page, Input } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { defaultRelayerUrl } from "@privacy-wallet/sdk/relayer";
import { registerSecondDevice, webauthnAvailable } from "@privacy-wallet/sdk/secondFactor";
import { forgetDeployment } from "@privacy-wallet/sdk/deploymentGuard";
import { requestSystemNotifications } from "@privacy-wallet/sdk/wallet/notifications";
import { CAP_BPS_RANGE, PROTECTION_DEFAULTS, PROTECTION_MODES, settings, type ProtectionMode } from "@privacy-wallet/sdk/wallet/settings";
import { AddressBookPanel } from "../../components/protection/AddressBook";
import { useStatusLines } from "./statusLines";
import { useDeploymentFingerprint, useSettings } from "../../hooks";

export function Advanced({ deployment, onBack }: { deployment: Deployment | null; onBack?: () => void }) {
  const t = useT();
  const s = useSettings();
  const { readsLine, coreLine } = useStatusLines(deployment);
  const p = s.protection;
  const [cap, setCap] = useState(() => formatEther(BigInt(s.housekeeping.dailyFeeCapWei)));
  const [exposure, setExposure] = useState(() => ((p.capBps ?? PROTECTION_DEFAULTS[p.mode].capBps) / 100).toFixed(1));
  const [exposureError, setExposureError] = useState("");
  const [deviceStatus, setDeviceStatus] = useState("");
  const [offAsk, setOffAsk] = useState(false);
  const [share, setShare] = useState(() => (p.providerShareCapBps !== undefined ? String(p.providerShareCapBps / 100) : ""));
  const [velocity, setVelocity] = useState(() => (p.velocity ? String(p.velocity.maxUsdPer24h) : ""));
  const [knobError, setKnobError] = useState("");
  const fingerprint = useDeploymentFingerprint(deployment?.chainId ?? null);
  const [forgotten, setForgotten] = useState(false);

  function applyCap() {
    try { settings.set({ housekeeping: { ...s.housekeeping, dailyFeeCapWei: parseEther(cap || "0").toString() } }); } catch { setCap(formatEther(BigInt(s.housekeeping.dailyFeeCapWei))); }
  }
  function applyExposure() {
    const bps = Math.round(Number(exposure) * 100);
    if (!Number.isFinite(bps) || bps < CAP_BPS_RANGE[0] || bps > CAP_BPS_RANGE[1]) {
      setExposureError(t("advanced.protection.exposureError", { min: CAP_BPS_RANGE[0] / 100, max: CAP_BPS_RANGE[1] / 100 }));
      setExposure(((p.capBps ?? PROTECTION_DEFAULTS[p.mode].capBps) / 100).toFixed(1));
      return;
    }
    setExposureError("");
    settings.set({ protection: { ...p, capBps: bps } });
  }
  function applyShare() {
    if (share.trim() === "") { const rest = { ...p }; delete rest.providerShareCapBps; settings.set({ protection: rest }); setKnobError(""); return; }
    const bps = Math.round(Number(share) * 100);
    if (!Number.isFinite(bps) || bps < 1000 || bps > 10000) { setKnobError(t("advanced.protection.concentrationError")); setShare(p.providerShareCapBps !== undefined ? String(p.providerShareCapBps / 100) : ""); return; }
    setKnobError(""); settings.set({ protection: { ...p, providerShareCapBps: bps } });
  }
  function applyVelocity() {
    if (velocity.trim() === "") { const rest = { ...p }; delete rest.velocity; settings.set({ protection: rest }); setKnobError(""); return; }
    const usd = Number(velocity);
    if (!Number.isFinite(usd) || usd <= 0) { setKnobError(t("advanced.protection.velocityError")); setVelocity(p.velocity ? String(p.velocity.maxUsdPer24h) : ""); return; }
    setKnobError(""); settings.set({ protection: { ...p, velocity: { maxUsdPer24h: usd } } });
  }
  async function registerDevice() {
    setDeviceStatus(t("advanced.protection.deviceRegistering"));
    try { const credentialId = await registerSecondDevice(); settings.set({ protection: { ...p, secondDevice: { enabled: true, credentialId } } }); setDeviceStatus(t("advanced.protection.deviceDone")); }
    catch (e) { setDeviceStatus(e instanceof Error ? e.message : String(e)); }
  }
  async function enableSystemNotifications(on: boolean) {
    if (!on) { settings.set({ protection: { ...p, notifications: { ...p.notifications, system: false } } }); return; }
    const granted = await requestSystemNotifications();
    settings.set({ protection: { ...p, notifications: { ...p.notifications, system: granted } } });
  }
  const toggle = (checked: boolean, onChange: (v: boolean) => void, text: string, testId?: string) => (
    <label className="ds-switch-row ds-native-row"><span>{text}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} /></label>
  );

  return (
    <Page title={t("route.advanced")} back={onBack} testId="advanced">
      <div className="ds-stack">
        <Card testId="technical">
          <div className="ds-stack-sm">
            <p className="ds-note" data-testid="deployment-line">{deployment ? t("advanced.deployment", { core: deployment.core.slice(0, 8), chain: deployment.chainId, endpoints: deployment.rpcUrls.length, line: coreLine }) : t("advanced.noDeployment")}</p>
            {deployment ? (
              <div className="ds-stack-sm" data-testid="deployment-fingerprint">
                <p className="ds-note">{fingerprint ? t("advanced.fingerprint", { hash: `${fingerprint.slice(0, 10)}…${fingerprint.slice(-6)}` }) : forgotten ? t("advanced.fingerprintForgotten") : t("advanced.fingerprintNone")}</p>
                {fingerprint ? <Button variant="secondary" onClick={() => { forgetDeployment(deployment.chainId); setForgotten(true); }} data-testid="deployment-forget">{t("advanced.fingerprintForget")}</Button> : null}
              </div>
            ) : null}
            <p className="ds-note">{t("advanced.unaudited")}</p>
          </div>
        </Card>

        <Card testId="network">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("advanced.networkTitle")}</h2>
            {toggle(s.verifyReads, (v) => settings.set({ verifyReads: v }), t("advanced.verifyReads"), "verify-reads")}
            <p className="ds-note" data-testid="reads-line">{readsLine}</p>
            <Field label={t("advanced.submission")} htmlFor="submission">
              <select id="submission" className="ds-input" value={s.submission.kind} onChange={(e) => settings.set({ submission: e.target.value === "relayer" ? { kind: "relayer", url: s.submission.kind === "relayer" ? s.submission.url : defaultRelayerUrl() } : { kind: "wallet" } })} data-testid="submission">
                <option value="relayer">{t("advanced.submission.relayer")}</option>
                <option value="wallet">{t("advanced.submission.wallet")}</option>
              </select>
            </Field>
            {s.submission.kind === "relayer" ? (
              <Field label={t("advanced.relayerUrl")} htmlFor="relayer-url"><Input id="relayer-url" value={s.submission.url} onChange={(e) => settings.set({ submission: { kind: "relayer", url: e.target.value } })} data-testid="relayer-url" /></Field>
            ) : null}
          </div>
        </Card>

        <Card testId="maintenance">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("advanced.maintenanceTitle")}</h2>
            {toggle(s.housekeeping.enabled, (v) => settings.set({ housekeeping: { ...s.housekeeping, enabled: v } }), t("advanced.maintenanceToggle"), "maintenance-enabled")}
            <Field label={t("advanced.feeCap")} htmlFor="fee-cap" hint={t("advanced.feeCapNote")}><Input id="fee-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyCap} data-testid="fee-cap" /></Field>
          </div>
        </Card>

        <Card testId="protected-execution">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("advanced.protection.title")}</h2>
            <p className="ds-note">{t("advanced.protection.body")}</p>
            <label className="ds-switch-row ds-native-row"><span>{t("advanced.protection.enabled")}</span><input type="checkbox" checked={p.enabled} onChange={(e) => { if (e.target.checked) { settings.set({ protection: { ...p, enabled: true } }); setOffAsk(false); } else setOffAsk(true); }} data-testid="protection-enabled" /></label>
            {offAsk && p.enabled ? (
              <div className="ds-note-warn" data-testid="protection-off-warning">
                <p><b>{t("advanced.protection.offWarningTitle")}</b> {t("advanced.protection.offWarning")}</p>
                <div className="ds-actions">
                  <Button variant="destructive" onClick={() => { settings.set({ protection: { ...p, enabled: false } }); setOffAsk(false); }} data-testid="protection-off-confirm">{t("advanced.protection.offConfirm")}</Button>
                  <Button variant="secondary" onClick={() => setOffAsk(false)}>{t("advanced.protection.keepOn")}</Button>
                </div>
              </div>
            ) : null}
            {!p.enabled ? <p className="ds-note-warn" data-testid="protection-off-notice">{t("advanced.protection.offNotice")}</p> : null}
            {toggle(p.protectFromEnhanced, (v) => settings.set({ protection: { ...p, protectFromEnhanced: v } }), t("advanced.protection.fromEnhanced"), "protect-from-enhanced")}
            <div className="ds-radio-list" role="radiogroup" aria-label={t("advanced.protection.title")}>
              {PROTECTION_MODES.map((m: ProtectionMode) => (
                <label key={m} className="ds-radio-row ds-native-row" data-checked={p.mode === m ? "true" : "false"}>
                  <input type="radio" name="protection-mode" checked={p.mode === m} onChange={() => { settings.set({ protection: { ...p, mode: m, capBps: undefined } }); setExposure((PROTECTION_DEFAULTS[m].capBps / 100).toFixed(1)); }} />
                  <span className="ds-radio-text"><b>{PROTECTION_DEFAULTS[m].label}</b> <span className="ds-note">· {t("advanced.protection.modeLine", { cap: PROTECTION_DEFAULTS[m].capBps / 100 })}</span><span className="ds-radio-desc">{PROTECTION_DEFAULTS[m].words}</span></span>
                </label>
              ))}
            </div>
            <Field label={t("advanced.protection.exposure", { min: CAP_BPS_RANGE[0] / 100, max: CAP_BPS_RANGE[1] / 100 })} htmlFor="exposure" error={exposureError || undefined}>
              <Input id="exposure" inputMode="decimal" value={exposure} onChange={(e) => setExposure(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyExposure} invalid={!!exposureError} data-testid="exposure-input" />
            </Field>
            {toggle(p.pauseLargeOperations, (v) => settings.set({ protection: { ...p, pauseLargeOperations: v } }), t("advanced.protection.pause"), "pause-large-operations")}
            {toggle(p.autoReroute, (v) => settings.set({ protection: { ...p, autoReroute: v } }), t("advanced.protection.autoReroute"), "auto-reroute")}
            <p className="ds-note"><b>{t("advanced.protection.advancedWord")}</b> {t("advanced.protection.advancedNote")}</p>
            <Field label={t("advanced.protection.concentration")} htmlFor="concentration"><Input id="concentration" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyShare} data-testid="concentration-input" /></Field>
            <Field label={t("advanced.protection.velocity")} htmlFor="velocity" error={knobError || undefined}><Input id="velocity" inputMode="numeric" value={velocity} onChange={(e) => setVelocity(e.target.value.replace(/[^0-9]/g, ""))} onBlur={applyVelocity} data-testid="velocity-input" /></Field>
            {toggle(p.notifications.inApp, (v) => settings.set({ protection: { ...p, notifications: { ...p.notifications, inApp: v } } }), t("advanced.protection.inApp"), "notify-in-app")}
            {toggle(p.notifications.system, (v) => void enableSystemNotifications(v), t("advanced.protection.system"), "notify-system")}
            {toggle(p.notifications.generic, (v) => settings.set({ protection: { ...p, notifications: { ...p.notifications, generic: v } } }), t("advanced.protection.generic"), "notify-generic")}
            <div className="ds-kv"><span className="ds-kv-label">{t("advanced.protection.secondDevice")}</span><b className="ds-kv-value">{p.secondDevice.credentialId ? t("advanced.protection.deviceRegistered") : webauthnAvailable() ? t("advanced.protection.deviceNotRegistered") : t("advanced.protection.deviceUnavailable")}</b></div>
            <div className="ds-actions">
              {!p.secondDevice.credentialId ? <Button variant="secondary" onClick={() => void registerDevice()} disabled={!webauthnAvailable()} data-testid="register-second-device">{t("advanced.protection.registerDevice")}</Button> : null}
              {p.secondDevice.credentialId ? <Button variant="secondary" onClick={() => { settings.set({ protection: { ...p, secondDevice: { enabled: false } } }); setDeviceStatus(t("advanced.protection.deviceRemoved")); }}>{t("advanced.protection.removeDevice")}</Button> : null}
            </div>
            <p className="ds-note">{t("advanced.protection.deviceNote")}</p>
            {deviceStatus ? <p className="ds-note" data-testid="device-status">{deviceStatus}</p> : null}
          </div>
        </Card>

        <AddressBookPanel deployment={deployment} />
      </div>
    </Page>
  );
}
