// The wizard before a protected execution (High-Value Protection spec §14–§15; plan V3 §44 screen states): risk
// analysis → privacy analysis → destination check, then the Review. Nothing is journaled here. The first-time
// explanation (plan §127) is shown once and remembered in Settings.
import { maximumLossModel } from "@privacy-wallet/protocol/wallet/campaign";
import type { LintId, LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { Button, Card } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { Deployment } from "../../sdk/chain";
import type { ChainKind } from "@privacy-wallet/protocol/wallet/chainKeys";
import type { DestinationCheck } from "../../wallet/addressBook";
import { DestinationCard } from "../../components/DestinationCard";
import { PrivacyLint } from "../../components/PrivacyLint";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { amountWords, type CampaignFacts, type SwapContext } from "./facts";
import { CUSTODY_WORDS, GATE_WORDS, durationWords } from "./targets";

export interface WizardProps {
  step: 0 | 1 | 2;
  provider: string;
  facts: CampaignFacts;
  ctx: SwapContext;
  introSeen: boolean;
  lintItems: LintItem[] | null;
  onAck: (id: LintId) => void;
  destAck: boolean;
  onDestAck: () => void;
  destCheck: DestinationCheck | null;
  chain: ChainKind;
  tier: Tier;
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  onNext: () => void;
  onBack: () => void;
}

export function Wizard(p: WizardProps) {
  const t = useT();
  const f = p.facts;
  const titles = [t("wizard.risk"), t("wizard.privacy"), t("wizard.destination")];
  const destinationOk = !p.ctx.destinationEdited || (p.destAck && (p.destCheck?.verified ?? false));
  return (
    <Card testId="campaign-wizard-card">
      <div className="ds-stack-sm" data-testid="campaign-wizard" data-step={p.step}>
        <div className="ds-note">{t("wizard.heading")} · {titles.map((title, i) => <span key={title} className={i === p.step ? "ds-level ds-level-Good" : i < p.step ? "ds-level ds-level-Excellent" : ""}>{i < p.step ? "✓ " : ""}{title}{i < 2 ? " → " : ""}</span>)}</div>
        <h2 className="ds-review-title">{titles[p.step]}</h2>
        {p.step === 0 && !p.introSeen ? <p className="ds-note-warn" data-testid="protection-intro">{t("wizard.intro")}</p> : null}
        {p.step === 0 ? (
          <div className="ds-stack-sm ds-note" data-testid="wizard-risk">
            <div className="ds-kv"><span className="ds-kv-label">{t("wizard.route")}</span><b className="ds-kv-value">{p.provider} · {t("wizard.classWord", { cls: f.p.riskClass })}{f.p.flags.length ? ` (+ ${f.p.flags.join(", ")})` : ""} · {CUSTODY_WORDS[f.p.custody] ?? f.p.custody}</b></div>
            <div className="ds-kv"><span className="ds-kv-label">{t("wizard.security")}</span><b className="ds-kv-value">{f.verdict.security === "Safe to execute" ? "✓" : "⚠"} {f.verdict.security}</b></div>
            <div>{f.verdict.why}</div>
            <div className="ds-kv"><span className="ds-kv-label">{t("wizard.steps")}</span><b className="ds-kv-value">{t("wizard.stepsLine", { n: f.steps, piece: amountWords(p.ctx, BigInt(f.draft.tranches[0]?.amount ?? "0")), orSo: f.steps > 1 ? t("wizard.orSo") : "", concurrency: f.p.concurrency === "sequential" ? t("swap.oneStepAtATime") : t("swap.upToAtATime", { n: f.p.maxParallel }), gate: GATE_WORDS[f.p.gate] ?? f.p.gate })}</b></div>
            <div className="ds-kv"><span className="ds-kv-label">{t("wizard.atRisk")}</span><b className="ds-kv-value">{amountWords(p.ctx, maximumLossModel(f.draft).cap)} ({f.draft.plan.capBps / 100} %{t("wizard.ofOrder")})</b></div>
            <div className="ds-kv"><span className="ds-kv-label">{t("review.protection.elpf")}</span><b className="ds-kv-value">{f.details.elpf}</b></div>
            <div className="ds-kv"><span className="ds-kv-label">{t("review.protection.concentration")}</span><b className="ds-kv-value">{f.details.concentration}</b></div>
            {f.p.reasons.length > 0 ? <ul className="ds-plain-list">{f.p.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
          </div>
        ) : null}
        {p.step === 1 ? (
          <div className="ds-stack-sm ds-note" data-testid="wizard-privacy">
            <div className="ds-kv"><span className="ds-kv-label">{t("review.privacy")}</span><b className={`ds-level ds-level-${f.verdict.privacy}`}>{f.verdict.privacy}</b></div>
            <ul className="ds-plain-list" data-testid="privacy-basis">{f.privacyView.basis.map((b) => <li key={b}>{b}</li>)}</ul>
            <p className="ds-note">{t("wizard.reveals", { n: f.steps, duration: durationWords(f.p.estimatedSeconds), cadence: f.cadence, destination: p.ctx.destinationEdited ? t("wizard.revealsEntered") : t("wizard.revealsFresh") })}</p>
            {p.lintItems ? <PrivacyLint items={p.lintItems} onAcknowledge={p.onAck} /> : null}
          </div>
        ) : null}
        {p.step === 2 ? (
          <div className="ds-stack-sm ds-note" data-testid="wizard-destination">
            <DestinationCard network={p.ctx.to.network} asset={p.ctx.to.ref.symbol} address={p.ctx.destination} kind={p.ctx.destinationEdited ? "entered" : "fresh"} title={p.ctx.destinationEdited ? t("wizard.everyStepPays") : t("wizard.firstStepPays")} />
            <p className="ds-note">{p.ctx.destinationEdited ? t("wizard.enteredNote") : t("wizard.freshNote")}</p>
            {p.ctx.destinationEdited ? <DestinationStatus chain={p.chain} address={p.ctx.destination} tier={p.tier} masterSeed={p.masterSeed} deployment={p.deployment} asset={p.ctx.to.ref.symbol} /> : null}
            {p.ctx.destinationEdited && !p.destAck ? <button type="button" className="ds-chip" onClick={p.onDestAck}>{t("swap.lines.checkedGroups")}</button> : null}
            {p.ctx.destinationEdited && p.destAck ? <div className="ds-level ds-level-Excellent">✓ {t("wizard.checked")}</div> : null}
          </div>
        ) : null}
        <div className="ds-actions">
          <Button onClick={p.onNext} disabled={p.step === 2 && !destinationOk} data-testid="wizard-next" title={p.step === 2 && p.ctx.destinationEdited && !(p.destCheck?.verified ?? false) ? t("wizard.verifyFirst") : undefined}>{p.step < 2 ? t("wizard.continue") : t("wizard.continueToReview")}</Button>
          <Button variant="ghost" onClick={p.onBack}>{t("campaign.back")}</Button>
        </div>
      </div>
    </Card>
  );
}
