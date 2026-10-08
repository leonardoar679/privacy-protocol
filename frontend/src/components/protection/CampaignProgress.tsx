import { exposure, type Campaign, type Tranche } from "@ref/wallet/campaign";
import { levelOf, type Level } from "@ref/wallet/privacyCenter";
import { formatUsd } from "@ref/wallet/valuation";
import { fmtUnits } from "../../sdk/format";
import { ALERT_TITLES } from "../../wallet/alerts";

// The progress of a protected execution (High-Value Protection spec §15; plan V3 §47, §66–§67, §75, §143): "Step k of
// ~N", the protection bar (completed · in flight · prepared · protected), the four amounts visible at all times, the
// privacy level next to the status, the three statuses ✓ Protected / ⚠ Review / ● Processing, the pause with its
// reason and the Resume, the reroute waiting for its Review, Pause and "Return the rest", the per-step lines
// (collapsed unless Advanced), the last alerts, and the one sentence about leaving the screen. No red walls.
export type CampaignStatus = { mark: "✓" | "⚠" | "●"; word: "Protected" | "Review" | "Processing" | "Completed" | "Returned" };

export function campaignStatus(c: Campaign): CampaignStatus {
  if (c.state === "completed") return { mark: "✓", word: "Completed" };
  if (c.state === "cancelled") return { mark: "✓", word: "Returned" };
  if (c.state === "paused" || c.state === "rerouting") return { mark: "⚠", word: "Review" };
  const e = exposure(c);
  if (e.inFlight > 0n || e.preparedCount > 0 || c.state === "requoting" || c.state === "reassessing" || c.state === "winding-down" || c.state === "preparing-notes") return { mark: "●", word: "Processing" };
  return { mark: "✓", word: "Protected" };
}

export const TRANCHE_WORDS: Record<Tranche["state"], string> = {
  planned: "waiting", ready: "starting", committed: "committed", funded: "funded", signed: "signed", executing: "executing", "source-confirmed": "executing", "destination-submitted": "waiting for finality", settled: "settled", partial: "partial", refunding: "returning", refunded: "returned", failed: "needs attention", skipped: "skipped",
};

export function CampaignProgress({ campaign: c, advanced, onPause, onResume, onCancel, onReviewReroute, onBack, now = Date.now() }: {
  campaign: Campaign; advanced?: boolean; onPause: () => void; onResume: () => void; onCancel: () => void; onReviewReroute?: () => void; onBack?: () => void; now?: number;
}) {
  const e = exposure(c);
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const usdPer = c.value && typeof c.value === "object" && "usd" in (c.value as object) && e.total > 0n ? (c.value as { usd: number }).usd / (Number(e.total) / 10 ** dec) : null;
  const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);
  const amt = (u: bigint) => `${trim(fmtUnits(u, dec, 4))} ${sym}${usdPer !== null ? ` (≈ ${formatUsd(usdPer * (Number(u) / 10 ** dec), { compact: true })})` : ""}`;
  const pct = (u: bigint) => (e.total > 0n ? Number((u * 10000n) / e.total) / 100 : 0);
  const counted = c.tranches.filter((t) => t.state !== "skipped");
  const settled = counted.filter((t) => t.state === "settled").length;
  const total = Math.max(counted.length, 1);
  const step = Math.min(settled + 1, total);
  const status = campaignStatus(c);
  const snapshot = (c.riskSnapshot ?? {}) as { privacyScore?: number };
  const privacy: Level | null = typeof snapshot.privacyScore === "number" ? levelOf(snapshot.privacyScore) : null;
  const terminal = c.state === "completed" || c.state === "cancelled";
  const alerts = (c.alerts ?? []).slice(-3).reverse();
  return (
    <div data-testid="campaign-progress" data-state={c.state} data-status={status.word}>
      <div className="row" style={{ alignItems: "center" }}>
        <b>Protected swap · {sym} → {c.request.to.symbol}</b>
        <b className={status.mark === "✓" ? "level-Excellent" : status.mark === "⚠" ? "level-Reduced" : "level-Good"} data-testid="campaign-status">{status.mark} {status.word}</b>
      </div>
      <div className="numeral-sm" data-testid="campaign-step">Step {step} of ~{total}</div>
      <div className="muted small">{terminal ? (c.state === "completed" ? "Every step settled." : "The rest returned to your private balance.") : `${settled} settled · ${e.inFlightCount} executing · ${counted.length - settled - e.inFlightCount - e.preparedCount} remaining`}{privacy ? ` · Privacy: ` : ""}{privacy && <b className={`level-${privacy}`}>{privacy}</b>}</div>
      <div className="bar" style={{ display: "flex", marginTop: 8 }} data-testid="protection-bar" title="completed · in flight · prepared · protected">
        <span style={{ width: `${pct(e.completed)}%`, background: "var(--shield)" }} data-segment="completed" />
        <span style={{ width: `${pct(e.inFlight)}%`, background: "var(--accent)" }} data-segment="in-flight" />
        <span style={{ width: `${pct(e.prepared)}%`, background: "var(--warn)" }} data-segment="prepared" />
        <span style={{ width: `${pct(e.remaining)}%`, background: "var(--panel-2)" }} data-segment="protected" />
      </div>
      <div className="small" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px", marginTop: 8 }} data-testid="campaign-amounts">
        <span className="muted">Completed</span><b data-amount="completed">{amt(e.completed)}</b>
        <span className="muted">In progress</span><b data-amount="in-flight">{amt(e.inFlight + e.prepared)}</b>
        <span className="muted">Protected (never exposed at once)</span><b data-amount="protected">{amt(e.protected)}</b>
        <span className="muted">Remaining</span><b data-amount="remaining">{amt(e.remaining)}</b>
      </div>
      <p className="muted small" style={{ margin: "6px 0 0" }}>At most {amt(e.cap)} is ever outside your private balance and unsettled at one time ({c.plan.capBps / 100} % of the order){c.plan.concurrency === "sequential" ? "; one step at a time" : `; up to ${c.plan.maxParallel} steps at a time`}; each step settles at the {c.plan.gate === "destination-final" ? "destination, final," : c.plan.gate === "destination-submitted" ? "destination" : "source"} before the next starts.</p>

      {c.state === "paused" && c.pause && (
        <div className="notice" style={{ marginTop: 10 }} data-testid="campaign-pause">
          <b>Paused — {ALERT_TITLES[c.pause.reason === "user" ? "paused" : c.pause.reason === "price-deviation" ? "price-changed" : c.pause.reason === "provider-error" ? "provider-degraded" : c.pause.reason === "chain-congestion" ? "chain-congested" : c.pause.reason === "route-degraded" ? "liquidity-dropped" : c.pause.reason === "unexpected-destination" ? "destination-changed" : c.pause.reason === "security-incident" ? "security-incident" : "paused"]}</b>
          <div className="small">{c.pause.detail}{c.pause.trancheIndex !== undefined ? ` (step ${c.pause.trancheIndex + 1})` : ""}</div>
          <div className="small muted">Resuming checks the facts again, quotes the remaining amount again, and asks you to review the route if it changed. Steps already handed over continue meanwhile.</div>
        </div>
      )}
      {c.state === "rerouting" && c.pendingReroute && (
        <div className="notice" style={{ marginTop: 10 }} data-testid="campaign-reroute">
          <b>The route changed to {c.pendingReroute.provider}.</b>
          <div className="small">A route change on a large operation is reviewed, never adopted quietly. The steps already handed over continue.</div>
        </div>
      )}

      <div className="tabs" style={{ marginTop: 10 }}>
        {!terminal && c.state !== "paused" && c.state !== "rerouting" && c.state !== "winding-down" && <button className="tab" onClick={onPause} data-testid="campaign-pause-button">Pause</button>}
        {c.state === "paused" && <button className="primary" onClick={onResume} data-testid="campaign-resume-button">Resume</button>}
        {c.state === "rerouting" && onReviewReroute && <button className="primary" onClick={onReviewReroute} data-testid="campaign-reroute-button">Review the new route</button>}
        {!terminal && c.state !== "winding-down" && <button className="tab" onClick={onCancel} data-testid="campaign-cancel-button" title="Steps not yet started are skipped; a funded step returns through its own refund; steps already handed over finish">Return the rest to my private balance</button>}
        {onBack && <button className="tab" onClick={onBack}>Back</button>}
      </div>
      {!terminal && <p className="muted small">You can safely leave this screen — keep the wallet unlocked. The steps run from any screen and resume when you unlock again.</p>}

      {alerts.length > 0 && (
        <ul className="small" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }} data-testid="campaign-alerts">
          {alerts.map((a, i) => <li key={`${a.at}:${i}`}><span className="muted">{new Date(a.at).toLocaleTimeString()} · {ALERT_TITLES[a.kind]}</span> — {a.text}</li>)}
        </ul>
      )}

      {advanced && (
        <div className="muted small" style={{ marginTop: 10 }} data-testid="campaign-steps">
          <div className="row"><span>Route</span><b>{c.provider ?? "—"} · class {c.plan.riskClass} · band {c.plan.bandBps[0] / 100}–{c.plan.bandBps[1] / 100} % · gate {c.plan.gate}</b></div>
          {c.plan.elpfUsd !== undefined && <div className="row"><span>Expected loss per failure</span><b>{formatUsd(c.plan.elpfUsd)}</b></div>}
          <div className="row"><span>Max loss (any moment)</span><b>{amt(e.maxLoss)}</b></div>
          {c.tranches.map((t) => (
            <div key={t.index} className="row" data-tranche={t.index} data-tranche-state={t.state}>
              <span>Step {t.index + 1} · {trim(fmtUnits(t.amount, dec, 4))} {sym}{t.provider ? ` · ${t.provider}` : ""}</span>
              <b>{TRANCHE_WORDS[t.state]}{t.settledAt ? ` · ${new Date(t.settledAt).toLocaleTimeString()}` : t.notBefore && t.state === "planned" && t.notBefore > now ? ` · not before ${new Date(t.notBefore).toLocaleTimeString()}` : ""}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
