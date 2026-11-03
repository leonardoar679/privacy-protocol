// The Review (spec §3.9; whale spec §24; plan V2 §11, §46–§47; V3 §15, §43; V4 §55, §69): the screen before the
// irreversible moments — commit (the withdrawal funds the escrow), execute (the signed call), a send or a withdrawal,
// a protected execution and its reroute. The amount in USD and in the asset, From and To with the destination card,
// what is received at least, the execution in words, the time, the privacy level with the lint, the lines of plan §4
// with their meaning, the issuer line, the maximum-loss model and the combined verdict (SECURITY and PRIVACY are one
// block: the security verdict is never shown without the privacy level), the route details under Advanced, the trade
// check on Private AI. A tap below the `large-protected` band, the hold from it, the second factor from
// high-value-secondary, the separate device at institutional (no password fallback), the review hold and the export
// at institutional. Same props and test ids as the V2–V4 screen; the words come from the message catalog, the values too (the
// tier, the privacy level, the issuer line, the route kind, the verdict — audit round 2, r55; ./words.ts).
import { useState, type ReactNode } from "react";
import type { Level } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { unacknowledgedBlocks, type LintId, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { Button, Collapsible, HoldButton, TextButton, Input } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { assertSecondFactor, verifyPassword, webauthnAvailable } from "@privacy-wallet/sdk/secondFactor";
import { holdMs, type Controls } from "@privacy-wallet/sdk/tiers";
import type { TradeCheck } from "../../zkapi/tradeCheck";
import { DestinationCard } from "../../components/DestinationCard";
import { PrivacyLint } from "../../components/PrivacyLint";
import { EXECUTION_WORDS, LEVEL_WORDS, ROUTE_KIND_WORDS, SECURITY_WORDS, TIER_WORDS } from "./words";

export interface ReviewLine { id: "price" | "route" | "destination" | "slippage" | "privacy" | "exposure" | "security"; label: string; ok: boolean; meaning: string; /** the line is ok only once the user acknowledges this */ ack?: { text: string; done: boolean; onAck: () => void } }
export interface RouteDetails { provider: string; mode: string; parts?: number; fees: string; expectedOutput: string; settlement: string; alternatives: { provider: string; outcome: string; reason?: string }[]; score?: string; linkEvidence?: string }
/** The maximum-loss model of a protected execution (High-Value Protection spec §15, plan V3 §46), every figure already formatted. */
export interface MaximumLoss { order: string; cap: string; maxExposure: string; protected: string; preparation: string }
/** The combined verdict (plan V3 §43): SECURITY and PRIVACY are one block — "Safe to execute" is never shown without the privacy level. */
export interface Verdict { security: "Safe to execute" | "Review" | "Do not execute"; privacy: Level; why: string; /** V4 (plan §55): the third line — the competition's winner, the only route, or a route the user chose over the winner */ execution?: "Best available" | "Only route" | "Review"; executionWhy?: string }
/** Advanced (plan V3 §94): the protection plan in figures. */
export interface ProtectionDetails { riskClass: string; custody: string; band: string; cap: string; gate: string; steps: string; duration: string; cadence: string; elpf: string; concentration: string; alternative?: string }

export interface ReviewProps {
  moment: "commit" | "execute" | "send" | "withdraw" | "campaign" | "reroute";
  tier: Tier;
  controls: Controls;
  usd: string | null;
  amount: string;
  from: string;
  to: { network: string; asset: string; address: string; kind: "fresh" | "entered" | "privacy-address"; label?: string };
  receiveMin?: string | null;
  execution?: { words: string; detail?: string; eta: string } | null;
  privacy: { level: Level; score?: number };
  lint: LintItem[];
  onAcknowledgeLint: (id: LintId) => void;
  lines: ReviewLine[];
  /** the token is issuer-controlled (sdk issuerControlled): the issuer line, in the catalog's words */
  issuer?: boolean | null;
  routeKind?: "Native-to-native" | "Issuer-dependent" | null;
  details?: RouteDetails | null;
  advanced?: boolean;
  /** institutional: the funding waits this long after the confirmation and can be cancelled meanwhile */
  reviewHold?: { minutes: number } | null;
  onExport?: () => void;
  secondFactor?: { credentialId?: string } | null;
  /** institutional (spec §14): the registered separate device, asked after the second factor whenever `controls.secondDevice` is set; absent credential: the confirmation is refused, there is no password fallback */
  secondDevice?: { credentialId?: string } | null;
  maximumLoss?: MaximumLoss | null;
  verdict?: Verdict | null;
  protectionDetails?: ProtectionDetails | null;
  /** V4 (plan §69): the route settles across chains; the Review states the fact in the plan's words */
  crossChain?: boolean;
  /** "Check this trade" on Private AI (spec §22): available only with an open private session; the summary is sanitized by the caller */
  tradeCheck?: { available: boolean; reason?: string; run: () => Promise<TradeCheck> } | null;
  busy?: string;
  error?: string;
  /** the caller's own block (the review round of 2026-11-03, W7: offline — spec v2.0 §7.11 closes every confirmation): the lines shown, the confirmation closed */
  confirmDisabled?: boolean;
  /** the §3.8 checks shown as the Protection line at the band and above */
  protectedExecution?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

const levelClass = (level: Level): string => `ds-level ds-level-${level}`;
const Row = ({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) => <div className="ds-kv" data-testid={testId}><span className="ds-kv-label">{label}</span><span className="ds-kv-value">{children}</span></div>;

export function Review(p: ReviewProps) {
  const t = useT();
  const [factor, setFactor] = useState<"idle" | "asking" | "password" | "passed">("idle");
  const [password, setPassword] = useState("");
  const [factorError, setFactorError] = useState("");
  const [device, setDevice] = useState<"idle" | "asking" | "passed">("idle");
  const [deviceError, setDeviceError] = useState("");
  const [check, setCheck] = useState<{ busy?: boolean; result?: TradeCheck; error?: string }>({});
  async function runCheck() {
    if (!p.tradeCheck?.available) return;
    setCheck({ busy: true });
    try { setCheck({ result: await p.tradeCheck.run() }); } catch (e) { setCheck({ error: e instanceof Error ? e.message : String(e) }); }
  }
  const title = t(`review.moment.${p.moment}.title` as MessageKey);
  const what = t(`review.moment.${p.moment}.what` as MessageKey);
  const buttonWords = t(`review.moment.${p.moment}.button` as MessageKey);
  const blocks = unacknowledgedBlocks(p.lint);
  const pendingLines = p.lines.filter((l) => !l.ok);
  const ready = blocks.length === 0 && pendingLines.length === 0 && !p.busy && !p.confirmDisabled;
  const needsFactor = p.controls.secondFactor && factor !== "passed";
  // the tier's own rule (audit round 2, r28): a Review whose caller passed no device — a Send, a one-order swap — had confirmed
  // an institutional operation after the platform factor alone, the separate device never asked
  const needsDevice = (p.controls.secondDevice || !!p.secondDevice) && device !== "passed";

  /** After the second factor (or without one): the separate device at institutional, then the confirmation. */
  async function afterFactor() {
    if (needsDevice) {
      setDeviceError("");
      if (!p.secondDevice?.credentialId) { setDeviceError(t("review.device.missing")); return; }
      if (!webauthnAvailable()) { setDeviceError(t("review.device.unavailable")); return; }
      setDevice("asking");
      const ok = await assertSecondFactor(p.secondDevice.credentialId);
      if (!ok) { setDevice("idle"); setDeviceError(t("review.device.declined")); return; }
      setDevice("passed");
    }
    await p.onConfirm();
  }
  async function confirm() {
    if (!ready) return;
    if (needsFactor) {
      setFactorError("");
      if (p.secondFactor?.credentialId && webauthnAvailable()) {
        setFactor("asking");
        if (await assertSecondFactor(p.secondFactor.credentialId)) { setFactor("passed"); await afterFactor(); return; }
        setFactorError(t("review.factor.declined"));
      }
      setFactor("password");
      return;
    }
    await afterFactor();
  }
  async function confirmWithPassword() {
    setFactorError("");
    if (!(await verifyPassword(password))) { setFactorError(t("review.factor.wrongPassword")); return; }
    setPassword(""); setFactor("passed");
    await afterFactor();
  }
  const confirmLabel = needsFactor ? t("review.factor.next", { button: buttonWords }) : needsDevice ? t("review.device.next", { button: buttonWords }) : buttonWords;
  const asking = factor === "asking" || device === "asking";

  return (
    <div className="ds-card ds-elev-1 ds-pad-md ds-review" data-testid="review" data-moment={p.moment}>
      <h2 className="ds-review-title">{title}</h2>
      <p className="ds-note">{what} {t(TIER_WORDS[p.tier])}.</p>
      <div className="ds-numeral ds-review-usd" data-testid="review-usd">{p.usd ?? "—"}</div>
      <div className="ds-review-amount-v5">{p.amount}</div>
      <Row label={t("review.from")}>{p.from}</Row>
      <DestinationCard title={t("review.to")} network={p.to.network} asset={p.to.asset} address={p.to.address} kind={p.to.kind} label={p.to.label} />
      {p.receiveMin ? <Row label={t("review.receiveAtLeast")}>{p.receiveMin}</Row> : null}
      {p.execution ? (
        <>
          <Row label={t("review.execution")}>{p.execution.words}{p.execution.detail ? <span className="ds-note"> · {p.execution.detail}</span> : null}</Row>
          <Row label={t("review.estimatedTime")}>{p.execution.eta}</Row>
        </>
      ) : null}
      {p.crossChain ? <p className="ds-note-warn" data-testid="non-atomic">{t("review.nonAtomic")}</p> : null}
      <Row label={t("review.privacy")}><span className={levelClass(p.privacy.level)}>{t(LEVEL_WORDS[p.privacy.level])}{p.advanced && p.privacy.score !== undefined ? ` (${p.privacy.score}/100)` : ""}</span></Row>
      {p.protectedExecution ? <Row label={t("review.protection")} testId="review-protection">{t("review.protectionPrivate")}</Row> : null}
      {p.issuer ? <Row label={t("review.token")}>{t("review.issuerLine")}</Row> : null}
      {p.routeKind ? <Row label={t("review.route")}>{t(ROUTE_KIND_WORDS[p.routeKind])}</Row> : null}
      <PrivacyLint items={p.lint} onAcknowledge={p.onAcknowledgeLint} compact />
      {p.maximumLoss ? (
        <div className="ds-review-block" data-testid="maximum-loss">
          <div className="ds-note">{t("review.maxLoss.title")}</div>
          <Row label={t("review.maxLoss.order")}>{p.maximumLoss.order}</Row>
          <Row label={t("review.maxLoss.cap")}>{p.maximumLoss.cap}</Row>
          <Row label={t("review.maxLoss.maxExposure")}>{p.maximumLoss.maxExposure}</Row>
          <Row label={t("review.maxLoss.protected")}>{p.maximumLoss.protected}</Row>
          <Row label={t("review.maxLoss.preparation")}>{p.maximumLoss.preparation}</Row>
        </div>
      ) : null}
      {p.verdict ? (
        <div className="ds-review-block" data-testid="verdict">
          <Row label={t("review.verdict.security")}><span className={p.verdict.security === "Safe to execute" ? "ds-level ds-level-Excellent" : p.verdict.security === "Review" ? "ds-level ds-level-Reduced" : "ds-level ds-level-danger"} data-testid="verdict-security">{t(SECURITY_WORDS[p.verdict.security])}</span></Row>
          <Row label={t("review.verdict.privacy")}><span className={levelClass(p.verdict.privacy)} data-testid="verdict-privacy">{t(LEVEL_WORDS[p.verdict.privacy])}</span></Row>
          {p.verdict.execution ? <Row label={t("review.verdict.execution")}><span className={p.verdict.execution === "Best available" ? "ds-level ds-level-Excellent" : p.verdict.execution === "Only route" ? "ds-level ds-level-Good" : "ds-level ds-level-Reduced"} data-testid="verdict-execution">{t(EXECUTION_WORDS[p.verdict.execution])}{p.verdict.execution === "Best available" ? " ✓" : ""}</span></Row> : null}
          <div className="ds-note">{p.verdict.why}{p.verdict.executionWhy ? ` · ${p.verdict.executionWhy}` : ""}</div>
        </div>
      ) : null}

      <ul className="ds-review-lines" data-testid="review-lines">
        {p.lines.map((l) => (
          <li key={l.id} data-line={l.id} data-ok={l.ok ? "1" : "0"}>
            <span className={l.ok ? "ds-level ds-level-Excellent ds-review-mark" : "ds-level ds-level-Reduced ds-review-mark"}>{l.ok ? "✓" : "⚠"}</span>
            <span><b>{l.label}</b> <span className="ds-note">· {l.meaning}</span>
              {l.ack && !l.ack.done ? <button type="button" className="ds-chip" onClick={l.ack.onAck}>{l.ack.text}</button> : null}
            </span>
          </li>
        ))}
      </ul>

      {p.details ? (
        <Collapsible summary={t("review.advancedDetails")} testId="review-advanced">
          <div className="ds-note ds-stack-sm" data-testid="route-details">
            <Row label={t("review.details.provider")}>{p.details.provider}</Row>
            <Row label={t("review.details.mode")}>{p.details.mode}{p.details.parts ? ` · ${t("review.details.parts", { parts: p.details.parts })}` : ""}</Row>
            <Row label={t("review.details.fees")}>{p.details.fees}</Row>
            <Row label={t("review.details.expectedOutput")}>{p.details.expectedOutput}</Row>
            <Row label={t("review.details.settlement")}>{p.details.settlement}</Row>
            {p.details.linkEvidence ? <Row label={t("review.details.linkEvidence")}>{p.details.linkEvidence}</Row> : null}
            {p.details.score ? <Row label={t("review.details.score")}>{p.details.score}</Row> : null}
            {p.details.alternatives.length > 0 ? <div>{t("review.details.alternatives", { list: p.details.alternatives.map((a) => `${a.provider} — ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`).join("; ") })}</div> : null}
            {p.protectionDetails ? (
              <div className="ds-stack-sm" data-testid="protection-details">
                <Row label={t("review.protection.riskClass")}>{p.protectionDetails.riskClass} · {p.protectionDetails.custody}</Row>
                <Row label={t("review.protection.band")}>{p.protectionDetails.band} · {p.protectionDetails.cap}</Row>
                <Row label={t("review.protection.gate")}>{p.protectionDetails.gate}</Row>
                <Row label={t("review.protection.steps")}>{p.protectionDetails.steps} · {p.protectionDetails.duration}</Row>
                <Row label={t("review.protection.cadence")}>{p.protectionDetails.cadence}</Row>
                <Row label={t("review.protection.elpf")}>{p.protectionDetails.elpf}</Row>
                <Row label={t("review.protection.concentration")}>{p.protectionDetails.concentration}</Row>
                {p.protectionDetails.alternative ? <Row label={t("review.protection.alternative")}>{p.protectionDetails.alternative}</Row> : null}
              </div>
            ) : null}
          </div>
        </Collapsible>
      ) : null}

      {p.tradeCheck ? (
        <div className="ds-stack-sm" data-testid="trade-check">
          <div className="ds-actions">
            <Button variant="secondary" onClick={() => void runCheck()} disabled={!p.tradeCheck.available || !!check.busy} title={p.tradeCheck.available ? t("review.tradeCheck.hint") : p.tradeCheck.reason}>{t("review.tradeCheck.button")}</Button>
            {!p.tradeCheck.available ? <span className="ds-note">{p.tradeCheck.reason}</span> : null}
          </div>
          {check.error ? <p className="ds-field-error">{check.error}</p> : null}
          {check.result ? (
            <div className="ds-review-block" data-testid="trade-check-result">
              <div className="ds-note">{t("review.tradeCheck.disclaimer")}</div>
              {(["bestRoute", "alternative", "estimatedSavings", "privacy", "execution", "risk"] as const).map((k) => check.result![k] ? <Row key={k} label={t(`review.tradeCheck.${k}` as MessageKey)}>{String(check.result![k])}</Row> : null)}
            </div>
          ) : null}
        </div>
      ) : null}
      {p.reviewHold ? <p className="ds-note-warn" data-testid="review-hold-notice">{t("review.reviewHold", { minutes: p.reviewHold.minutes })}</p> : null}
      {p.onExport ? <div className="ds-actions"><Button variant="secondary" icon="download" onClick={p.onExport}>{t("review.export")}</Button></div> : null}

      {factor === "password" ? (
        <div className="ds-review-block" data-testid="second-factor-password">
          <div className="ds-note">{p.secondFactor?.credentialId ? t("review.factor.passwordAfterDecline") : t("review.factor.passwordNoAuthenticator")}</div>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void confirmWithPassword(); }} autoComplete="current-password" aria-label={t("review.factor.passwordLabel")} />
          <Button onClick={() => void confirmWithPassword()} disabled={!password || !!p.busy}>{t("review.factor.confirmWithPassword")}</Button>
        </div>
      ) : null}
      {factorError ? <p className="ds-field-error">{factorError}</p> : null}
      {deviceError ? <p className="ds-field-error" data-testid="second-device-error">{deviceError}</p> : null}
      {device === "asking" ? <p className="ds-note">{t("review.device.asking")}</p> : null}
      {p.error ? <p className="ds-field-error">{p.error}</p> : null}
      {p.busy ? <p className="ds-note" data-testid="review-busy">{p.busy}</p> : null}

      <div className="ds-actions ds-review-actions">
        {factor !== "password" ? (p.controls.hold
          ? <HoldButton label={confirmLabel} holdMs={holdMs()} onConfirm={() => void confirm()} disabled={!ready || asking} hint={t("review.holdHint")} holdingLabel={t("review.holding")} />
          : <Button size="lg" full onClick={() => void confirm()} disabled={!ready || asking} data-testid="confirm-tap">{confirmLabel}</Button>) : null}
        <TextButton onClick={p.onCancel} disabled={!!p.busy}>{t("review.back")}</TextButton>
      </div>
      {!ready && !p.busy ? <p className="ds-note">{blocks.length ? t("review.ackLint") : pendingLines.length ? t("review.waitingOn", { lines: pendingLines.map((l) => l.label).join(", ") }) : ""}</p> : null}
    </div>
  );
}
