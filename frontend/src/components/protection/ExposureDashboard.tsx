import { exposure, providerShares, type Campaign, type Tranche } from "@ref/wallet/campaign";
import { formatUsd } from "@ref/wallet/valuation";
import { fmtUnits } from "../../sdk/format";
import { ALERT_TITLES } from "../../wallet/alerts";

// The exposure dashboard (High-Value Protection spec §15; plan V3 §75), under Advanced: the order, what is in flight, the
// maximum allowed, the provider and its exposure, the remaining amount, the exposure timeline (what was outside the
// private balance and unsettled at every hand-over and settlement — never above the cap, I1), the per-step table, the
// pause history and the expected loss per failure. Everything comes from the journaled campaign; nothing is fetched.
const TRANCHE_WORDS: Record<Tranche["state"], string> = {
  planned: "waiting", ready: "starting", committed: "committed", funded: "funded", signed: "signed", executing: "executing", "source-confirmed": "executing", "destination-submitted": "waiting for the destination", "destination-confirmed": "delivered, finality pending", settled: "settled", partial: "partial", refunding: "returning", refunded: "returned", failed: "needs attention", skipped: "skipped",
};
const IN_FLIGHT_STATES = new Set<Tranche["state"]>(["executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial"]);
const LEAVES_FLIGHT = new Set<Tranche["state"]>(["settled", "refunded", "failed", "skipped", "refunding"]);

export interface ExposurePoint { at: number; inFlight: bigint; trancheIndex: number; note: string }

/** The in-flight amount after every hand-over and every settlement, from the tranche histories (pure). */
export function exposureTimeline(c: Campaign): ExposurePoint[] {
  const events: { at: number; delta: bigint; index: number; note: string }[] = [];
  for (const t of c.tranches) {
    const amount = BigInt(t.amount);
    let flying = false;
    for (const h of t.history) {
      if (!flying && IN_FLIGHT_STATES.has(h.state)) { flying = true; events.push({ at: h.at, delta: amount, index: t.index, note: "handed over" }); }
      else if (flying && LEAVES_FLIGHT.has(h.state)) { flying = false; events.push({ at: h.at, delta: -amount, index: t.index, note: h.state === "settled" ? "settled" : h.state }); }
    }
  }
  events.sort((a, b) => a.at - b.at);
  let inFlight = 0n;
  return events.map((e) => { inFlight += e.delta; if (inFlight < 0n) inFlight = 0n; return { at: e.at, inFlight, trancheIndex: e.index, note: e.note }; });
}

export function ExposureDashboard({ campaign: c, now = Date.now() }: { campaign: Campaign; now?: number }) {
  const e = exposure(c);
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const usdPer = c.value && typeof c.value === "object" && "usd" in (c.value as object) && e.total > 0n ? (c.value as { usd: number }).usd / (Number(e.total) / 10 ** dec) : null;
  const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);
  const amt = (u: bigint) => `${trim(fmtUnits(u, dec, 4))} ${sym}${usdPer !== null ? ` (≈ ${formatUsd(usdPer * (Number(u) / 10 ** dec), { compact: true })})` : ""}`;
  const shares = providerShares(c);
  const timeline = exposureTimeline(c);
  const pauses = c.history.filter((h) => h.state === "paused" || h.state === "reassessing" || h.state === "requoting" || h.state === "rerouting" || h.state === "winding-down");
  const outDec = c.request.to.decimals, outSym = c.request.to.symbol;
  const time = (t: number) => new Date(t).toLocaleTimeString();
  return (
    <div className="muted small" style={{ marginTop: 10 }} data-testid="exposure-dashboard">
      <div className="row"><span>Order</span><b>{amt(e.total)}</b></div>
      <div className="row"><span>In flight (handed over, unsettled)</span><b data-dashboard="in-flight">{amt(e.inFlight)}</b></div>
      <div className="row"><span>Prepared (in our escrows, not yet handed over)</span><b>{amt(e.prepared)}</b></div>
      <div className="row"><span>Maximum allowed at once</span><b data-dashboard="cap">{amt(e.cap)} ({c.plan.capBps / 100} %)</b></div>
      <div className="row"><span>Max loss right now</span><b>{amt(e.maxLoss)}</b></div>
      <div className="row"><span>Remaining (never exposed yet)</span><b>{amt(e.remaining)}</b></div>
      <div className="row"><span>Route</span><b>{c.provider ?? "—"} · class {c.plan.riskClass} · band {c.plan.bandBps[0] / 100}–{c.plan.bandBps[1] / 100} % · gate {c.plan.gate} · {c.plan.concurrency}</b></div>
      <div className="row"><span>Provider exposure (carried or carrying)</span><b data-dashboard="provider-exposure">{Object.keys(shares).length ? Object.entries(shares).map(([p, u]) => `${p}: ${amt(u)}`).join(" · ") : "nothing handed over yet"}</b></div>
      <div className="row"><span>Expected loss per failure</span><b>{c.plan.elpfUsd !== undefined ? formatUsd(c.plan.elpfUsd) : "not valued"}</b></div>
      {timeline.length > 0 && (
        <div style={{ marginTop: 6 }} data-testid="exposure-timeline">
          <div>Exposure over time (in flight after each event; never above the cap)</div>
          {timeline.map((p, i) => <div key={i} className="row" data-timeline-inflight={p.inFlight.toString()}><span>{time(p.at)} · step {p.trancheIndex + 1} {p.note}</span><b>{amt(p.inFlight)}</b></div>)}
        </div>
      )}
      <div style={{ marginTop: 6 }} data-testid="campaign-steps">
        <div>Steps</div>
        {c.tranches.map((t) => (
          <div key={t.index} className="row" data-tranche={t.index} data-tranche-state={t.state}>
            <span>Step {t.index + 1} · {trim(fmtUnits(t.amount, dec, 4))} {sym}{t.provider ? ` · ${t.provider}` : ""}{t.outcome?.deliveredOut ? ` · delivered ${trim(fmtUnits(t.outcome.deliveredOut, outDec, 6))} ${outSym}` : ""}</span>
            <b>{TRANCHE_WORDS[t.state]}{t.handedOverAt ? ` · handed over ${time(t.handedOverAt)}` : ""}{t.settledAt ? ` · settled ${time(t.settledAt)}` : t.notBefore && t.state === "planned" && t.notBefore > now ? ` · not before ${time(t.notBefore)}` : ""}</b>
          </div>
        ))}
      </div>
      {(pauses.length > 0 || (c.alerts ?? []).length > 0) && (
        <div style={{ marginTop: 6 }} data-testid="pause-history">
          <div>Pauses and alerts</div>
          {pauses.map((h, i) => <div key={`h${i}`} className="row"><span>{time(h.at)} · {h.state}</span><b>{h.note ?? ""}</b></div>)}
          {(c.alerts ?? []).map((a, i) => <div key={`a${i}`} className="row"><span>{time(a.at)} · {ALERT_TITLES[a.kind]}</span><b>{a.text}</b></div>)}
        </div>
      )}
    </div>
  );
}
