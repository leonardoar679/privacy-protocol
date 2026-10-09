// The exposure dashboard (High-Value Protection spec §15; plan V3 §75), under Advanced: the order, what is in flight, the
// maximum allowed, the provider and its exposure, the remaining amount, the exposure timeline (what was outside the
// private balance and unsettled at every hand-over and settlement — never above the cap, I1), the per-step table, the
// pause history and the expected loss per failure. Everything comes from the journaled campaign; nothing is fetched.
import { exposure, ledger, providerShares, type Campaign, type Tranche } from "@ref/wallet/campaign";
import { formatUsd } from "@ref/wallet/valuation";
import { useT } from "../../../app/i18n/useT";
import { fmtUnits } from "../../../sdk/format";
import { ALERT_TITLES } from "../../../wallet/alerts";
import { TRANCHE_WORDS } from "./words";

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

const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);
const Row = ({ label, children, attr }: { label: string; children: React.ReactNode; attr?: string }) => <div className="ds-kv"><span className="ds-kv-label">{label}</span><b className="ds-kv-value" {...(attr ? { "data-dashboard": attr } : {})}>{children}</b></div>;

export function ExposureDashboard({ campaign: c, now = Date.now() }: { campaign: Campaign; now?: number }) {
  const t = useT();
  const e = exposure(c);
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const usdPer = c.value && typeof c.value === "object" && "usd" in (c.value as object) && e.total > 0n ? (c.value as { usd: number }).usd / (Number(e.total) / 10 ** dec) : null;
  const amt = (u: bigint) => `${trim(fmtUnits(u, dec, 4))} ${sym}${usdPer !== null ? ` (≈ ${formatUsd(usdPer * (Number(u) / 10 ** dec), { compact: true })})` : ""}`;
  const shares = providerShares(c);
  const book = ledger(c); // V4 (contract §3.5): the in-flight amount per provider against its limit (I6)
  const timeline = exposureTimeline(c);
  const pauses = c.history.filter((h) => h.state === "paused" || h.state === "reassessing" || h.state === "requoting" || h.state === "rerouting" || h.state === "winding-down");
  const outDec = c.request.to.decimals, outSym = c.request.to.symbol;
  const time = (x: number) => new Date(x).toLocaleTimeString();
  void now;
  return (
    <div className="ds-note ds-stack-sm" data-testid="exposure-dashboard">
      <Row label={t("dashboard.order")}>{amt(e.total)}</Row>
      <Row label={t("dashboard.inFlight")} attr="in-flight">{amt(e.inFlight)}</Row>
      <Row label={t("dashboard.prepared")}>{amt(e.prepared)}</Row>
      <Row label={t("dashboard.cap")} attr="cap">{amt(e.cap)} ({c.plan.capBps / 100} %)</Row>
      <Row label={t("dashboard.maxLoss")}>{amt(e.maxLoss)}</Row>
      <Row label={t("dashboard.remaining")}>{amt(e.remaining)}</Row>
      <Row label={t("dashboard.route")}>{c.provider ?? "—"} · {t("dashboard.classWord", { cls: c.plan.riskClass })} · {t("dashboard.bandWord", { lo: c.plan.bandBps[0] / 100, hi: c.plan.bandBps[1] / 100 })} · {t("dashboard.gateWord", { gate: c.plan.gate })} · {c.plan.concurrency}</Row>
      <Row label={t("dashboard.providerExposure")} attr="provider-exposure">{Object.keys(shares).length ? Object.entries(shares).map(([p, u]) => `${p}: ${amt(u)}`).join(" · ") : t("dashboard.nothingHandedOver")}</Row>
      <Row label={t("dashboard.providerLimits")} attr="provider-limits">{Object.keys(book.byProvider).length ? Object.entries(book.byProvider).map(([p, v]) => `${p}: ${amt(BigInt(v.inFlight))} ${t("dashboard.of")} ${amt(BigInt(v.limit))}`).join(" · ") : t("dashboard.nothingHandedOver")}</Row>
      <Row label={t("dashboard.elpf")}>{c.plan.elpfUsd !== undefined ? formatUsd(c.plan.elpfUsd) : t("dashboard.notValued")}</Row>
      {timeline.length > 0 ? (
        <div data-testid="exposure-timeline">
          <div>{t("dashboard.timelineTitle")}</div>
          {timeline.map((p, i) => <div key={i} className="ds-kv" data-timeline-inflight={p.inFlight.toString()}><span>{time(p.at)} · {t("dashboard.stepWord", { n: p.trancheIndex + 1 })} {p.note}</span><b>{amt(p.inFlight)}</b></div>)}
        </div>
      ) : null}
      <div data-testid="campaign-steps">
        <div>{t("dashboard.steps")}</div>
        {c.tranches.map((x) => (
          <div key={x.index} className="ds-kv" data-tranche={x.index} data-tranche-state={x.state}>
            <span>{t("dashboard.stepWord", { n: x.index + 1 })} · {trim(fmtUnits(x.amount, dec, 4))} {sym}{x.provider ? ` · ${x.provider}` : ""}{x.outcome?.deliveredOut ? ` · ${t("dashboard.delivered", { amount: trim(fmtUnits(x.outcome.deliveredOut, outDec, 6)), symbol: outSym })}` : ""}</span>
            <b>{x.lastReadFailedAt !== undefined && IN_FLIGHT_STATES.has(x.state) ? t("dashboard.unknownReconnecting") : TRANCHE_WORDS[x.state]}{x.handedOverAt ? ` · ${t("dashboard.handedOver", { time: time(x.handedOverAt) })}` : ""}{x.settledAt ? ` · ${t("dashboard.settledAt", { time: time(x.settledAt) })}` : x.notBefore && !x.handedOverAt ? ` · ${t("dashboard.notBefore", { time: time(x.notBefore) })}` : ""}</b>
          </div>
        ))}
      </div>
      {pauses.length > 0 || (c.alerts ?? []).length > 0 ? (
        <div data-testid="pause-history">
          <div>{t("dashboard.pausesTitle")}</div>
          {pauses.map((h, i) => <div key={`h${i}`} className="ds-kv"><span>{time(h.at)} · {h.state}</span><b>{h.note ?? ""}</b></div>)}
          {(c.alerts ?? []).map((a, i) => <div key={`a${i}`} className="ds-kv"><span>{time(a.at)} · {ALERT_TITLES[a.kind]}</span><b>{a.text}</b></div>)}
        </div>
      ) : null}
    </div>
  );
}
