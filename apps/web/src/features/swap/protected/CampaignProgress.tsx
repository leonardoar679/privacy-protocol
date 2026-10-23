// The progress of a protected execution (spec §3.8; High-Value Protection spec §15; plan V3 §47, §66–§67, §75, §143):
// "Your $80,000 swap is being completed in protected steps", the protection bar (completed · in flight · prepared ·
// protected), the four amounts visible at all times, the privacy level next to the status, the three statuses
// ✓ Protected / ⚠ Review / ● Processing, the §3.8 checks, the pause with its reason and the Resume, the reroute
// waiting for its Review, Pause and "Return the rest", the per-step lines (Advanced only: "Tranche #1/40" and
// "Step k of n" never appear outside Advanced), the last alerts, and the one sentence about leaving the screen.
import { exposure, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { levelOf, type Level } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { formatUsd } from "@privacy-wallet/protocol/wallet/valuation";
import { Button, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../../app/i18n/useT";
import { formatTime } from "../../../app/i18n/intl";
import { fmtUnits } from "@privacy-wallet/sdk/format";
import { ALERT_TITLES, alertKindFor } from "@privacy-wallet/sdk/wallet/alerts";
import { ExposureDashboard } from "./ExposureDashboard";
import { campaignStatusWords } from "./words";

export type CampaignStatus = { mark: "✓" | "⚠" | "●"; word: "Protected" | "Review" | "Processing" | "Completed" | "Returned" };

export function campaignStatus(c: Campaign): CampaignStatus {
  if (c.state === "completed") return { mark: "✓", word: "Completed" };
  if (c.state === "cancelled") return { mark: "✓", word: "Returned" };
  if (c.state === "paused" || c.state === "rerouting") return { mark: "⚠", word: "Review" };
  const e = exposure(c);
  if (e.inFlight > 0n || e.preparedCount > 0 || c.state === "requoting" || c.state === "reassessing" || c.state === "winding-down" || c.state === "preparing-notes") return { mark: "●", word: "Processing" };
  return { mark: "✓", word: "Protected" };
}

export { TRANCHE_WORDS } from "./words";

const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);

export function CampaignProgress({ campaign: c, advanced, onPause, onResume, onCancel, onReviewReroute, onBack, now = Date.now() }: {
  campaign: Campaign; advanced?: boolean; onPause: () => void; onResume: () => void; onCancel: () => void; onReviewReroute?: () => void; onBack?: () => void; now?: number;
}) {
  const t = useT();
  const e = exposure(c);
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const valued = c.value && typeof c.value === "object" && "usd" in (c.value as object) ? (c.value as { usd: number }).usd : null;
  const usdPer = valued !== null && e.total > 0n ? valued / (Number(e.total) / 10 ** dec) : null;
  const amt = (u: bigint) => `${trim(fmtUnits(u, dec, 4))} ${sym}${usdPer !== null ? ` (≈ ${formatUsd(usdPer * (Number(u) / 10 ** dec), { compact: true })})` : ""}`;
  const pct = (u: bigint) => (e.total > 0n ? Number((u * 10000n) / e.total) / 100 : 0);
  const counted = c.tranches.filter((x) => x.state !== "skipped");
  const settled = counted.filter((x) => x.state === "settled").length;
  const total = Math.max(c.tranches.length, 1); // the plan's steps; a cancel skips the rest, it does not shrink the plan
  const step = Math.min(settled + 1, total);
  const status = campaignStatus(c);
  const snapshot = (c.riskSnapshot ?? {}) as { privacyScore?: number };
  const privacy: Level | null = typeof snapshot.privacyScore === "number" ? levelOf(snapshot.privacyScore) : null;
  const terminal = c.state === "completed" || c.state === "cancelled";
  const alerts = (c.alerts ?? []).slice(-3).reverse();
  const unknown = c.tranches.filter((x) => x.lastReadFailedAt !== undefined).length; // plan §110: never "failed"
  const remaining = counted.length - settled - e.inFlightCount - e.preparedCount;
  const routeHealthy = c.state === "running" || c.state === "user-confirmed" || c.state === "preparing-notes" || terminal;
  const destinationVerified = c.bounds.destination.kind === "fresh-per-tranche" || !!c.confirmations.destinationVerified;
  const statusClass = status.mark === "✓" ? "ds-level ds-level-Excellent" : status.mark === "⚠" ? "ds-level ds-level-Reduced" : "ds-level ds-level-Good";
  const pauseTitle = c.pause ? ALERT_TITLES[alertKindFor(c.pause.reason, c.pause.detail)] : "";
  const segments: { key: string; width: number; cls: string }[] = [
    { key: "completed", width: pct(e.completed), cls: "ds-bar-completed" },
    { key: "in-flight", width: pct(e.inFlight), cls: "ds-bar-inflight" },
    { key: "prepared", width: pct(e.prepared), cls: "ds-bar-prepared" },
    { key: "protected", width: pct(e.remaining), cls: "ds-bar-protected" },
  ];
  let x = 0;
  return (
    <div className="ds-stack-sm" data-testid="campaign-progress" data-state={c.state} data-status={status.word}>
      <div className="ds-kv">
        <b>{t("campaign.title", { from: sym, to: c.request.to.symbol })}</b>
        <b className={statusClass} data-testid="campaign-status">{status.mark} {campaignStatusWords(t, status)}</b>
      </div>
      <div className="ds-review-amount-v5" data-testid="campaign-step" data-step={step} data-steps={total}>{advanced ? t("campaign.stepOf", { step, total }) : t("campaign.executing")}</div>
      {valued !== null && !terminal ? <p className="ds-note" data-testid="campaign-headline">{t("campaign.headline", { usd: formatUsd(valued) })}</p> : null}
      <p className="ds-note">{terminal ? (c.state === "completed" ? t("campaign.everySettled") : t("campaign.restReturned")) : `${t("campaign.counts", { settled, executing: e.inFlightCount, remaining })}${unknown ? ` · ${t("campaign.unknownCount", { n: unknown })}` : ""}${privacy ? ` · ${t("campaign.privacyLevel", { level: privacy })}` : ""}`}</p>
      <svg className="ds-protection-bar" data-testid="protection-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={t("campaign.barLabel")}>
        {segments.map((s) => { const el = <rect key={s.key} className={s.cls} x={x} y={0} width={s.width} height={8} data-segment={s.key} data-width={`${s.width}%`} />; x += s.width; return el; })}
      </svg>
      <div className="ds-campaign-amounts" data-testid="campaign-amounts">
        <span className="ds-kv-label">{t("campaign.completed")}</span><b data-amount="completed">{amt(e.completed)}</b>
        <span className="ds-kv-label">{t("campaign.inProgress")}</span><b data-amount="in-flight">{amt(e.inFlight + e.prepared)}</b>
        <span className="ds-kv-label">{t("campaign.protected")}</span><b data-amount="protected">{amt(e.protected)}</b>
        <span className="ds-kv-label">{t("campaign.remaining")}</span><b data-amount="remaining">{amt(e.remaining)}</b>
      </div>
      <p className="ds-note">{t("campaign.capSentence", { cap: amt(e.cap), percent: c.plan.capBps / 100, concurrency: c.plan.concurrency === "sequential" ? t("campaign.oneAtATime") : t("campaign.upTo", { n: c.plan.maxParallel }) })}</p>
      {!terminal ? <div className="ds-checks-line" data-testid="campaign-checks"><span data-check="route" data-ok={routeHealthy ? "1" : "0"}>{routeHealthy ? "✓" : "⚠"} {t("campaign.routeHealthy")}</span><span data-check="destination" data-ok={destinationVerified ? "1" : "0"}>{destinationVerified ? "✓" : "⚠"} {t("campaign.destinationVerified")}</span></div> : null}

      {c.state === "paused" && c.pause ? (
        <div className="ds-review-block" data-testid="campaign-pause">
          <b>{t("campaign.pausedTitle", { title: pauseTitle })}</b>
          <div className="ds-note">{c.pause.detail}{c.pause.trancheIndex !== undefined ? ` (${t("campaign.stepWord", { n: c.pause.trancheIndex + 1 })})` : ""}</div>
          <div className="ds-note">{t("campaign.resumeNote")}</div>
        </div>
      ) : null}
      {c.state === "rerouting" && c.pendingReroute ? (
        <div className="ds-review-block" data-testid="campaign-reroute">
          <b>{t("campaign.rerouteTitle", { provider: c.pendingReroute.provider })}</b>
          <div className="ds-note">{t("campaign.rerouteNote")}</div>
        </div>
      ) : null}

      <div className="ds-actions">
        {!terminal && c.state !== "paused" && c.state !== "rerouting" && c.state !== "winding-down" ? <Button variant="secondary" onClick={onPause} data-testid="campaign-pause-button">{t("campaign.pause")}</Button> : null}
        {c.state === "paused" ? <Button onClick={onResume} data-testid="campaign-resume-button">{t("campaign.resume")}</Button> : null}
        {c.state === "rerouting" && onReviewReroute ? <Button onClick={onReviewReroute} data-testid="campaign-reroute-button">{t("campaign.reviewRoute")}</Button> : null}
        {!terminal && c.state !== "winding-down" ? <Button variant="secondary" onClick={onCancel} data-testid="campaign-cancel-button" title={t("campaign.cancelHint")}>{t("campaign.cancel")}</Button> : null}
        {onBack ? <TextButton onClick={onBack}>{t("campaign.back")}</TextButton> : null}
      </div>
      {!terminal ? <p className="ds-note">{t("campaign.leaveNote")}</p> : null}

      {alerts.length > 0 ? (
        <ul className="ds-plain-list ds-note" data-testid="campaign-alerts">
          {alerts.map((a, i) => <li key={`${a.at}:${i}`}><span>{formatTime(a.at)} · {ALERT_TITLES[a.kind]}</span> — {a.text}</li>)}
        </ul>
      ) : null}

      {advanced ? <ExposureDashboard campaign={c} now={now} /> : null}
    </div>
  );
}
