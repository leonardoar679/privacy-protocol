// Activity (spec §3.10, §14; plan §27–§28; whale spec §19, §25): one local list of everything this wallet moved —
// from the encrypted journal, never from a server — in groups by day, an icon per kind, the amount and the status
// word; a swap row carries the four-step line of plan §60; a protected execution is one row unless Advanced; the
// scheduled fundings that failed say so; Refresh tracks every open swap once; finished rows can be removed; a row
// opens its detail.
import { useState } from "react";
import { Button, Card, Icon, IconButton, ListRow, Page, StatusBadge } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { Deployment } from "../../sdk/chain";
import { shortRef } from "../../sdk/format";
import { STEPS, trackOrder } from "../../sdk/orderTracker";
import { isOpenSwap } from "../../sdk/swapFunding";
import { deleteActivity } from "../../wallet/activity";
import { session, useSession } from "../../wallet/session";
import { useSchedulerStatus } from "../../wallet/schedule";
import { useSettings } from "../../wallet/settings";
import type { StoredSwap } from "../../wallet/journal";
import { useAllOperations } from "../operations/store";
import { buildRows, groupByDay, type ActivityRow } from "./rows";

export interface ActivityProps { deployment?: Deployment | null; onOpen?: (rowId: string) => void; onBack?: () => void }

/** The four steps of plan §60 from the tracker's last derivation. */
export function stepsOf(s: StoredSwap): boolean[] | null {
  const st = s.track?.state;
  if (!st) return null;
  const i = ["COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED"].indexOf(st);
  if (st === "PARTIAL") return [true, true, true, false];
  if (["REFUND_PENDING", "PROVIDER_TIMEOUT", "DESTINATION_FAILED", "REFUNDED", "FAILED"].includes(st)) return [true, true, false, false];
  if (["CANCELLED", "EXPIRED"].includes(st)) return [true, false, false, false];
  return [i >= 0, i >= 2, i >= 4, i >= 5];
}

export function Activity({ deployment = null, onOpen, onBack }: ActivityProps) {
  const t = useT();
  useSession(); // re-render on every journal write
  const { submission, advanced } = useSettings();
  const records = useAllOperations();
  const [refreshing, setRefreshing] = useState("");
  const unlocked = session.isUnlocked();
  const j = unlocked ? session.journal() : null;
  const rows = buildRows(j, records, advanced, t);
  const groups = groupByDay(rows, t);
  const failed = j ? j.schedule.filter((a) => !a.done && a.error) : [];
  const running = useSchedulerStatus();

  async function refresh() {
    if (!j) return;
    const open = j.swaps.filter((s) => (isOpenSwap(s) && !["committed"].includes(s.state)) || (isOpenSwap(s) && !!s.fundedTx));
    setRefreshing(t("activity.tracking", { n: open.length, plural: open.length === 1 ? "" : "s" }));
    for (const s of open) { try { await trackOrder(s, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null }); } catch { /* next */ } }
    setRefreshing("");
  }

  const row = (r: ActivityRow) => {
    const steps = r.swap ? stepsOf(r.swap) : null;
    return (
      <div key={r.id} data-testid="activity-row" data-label={r.status} data-kind={r.kind} data-state={r.record?.state ?? ""}>
        <ListRow leading={<Icon name={r.icon} size={22} />} title={<><b>{r.title}</b> <span className="ds-note">· {new Date(r.at).toLocaleTimeString()}</span></>} subtitle={`${r.amount}${r.note ? ` · ${r.note}` : ""}`}
          trailing={<StatusBadge tone={r.tone}>{r.status}</StatusBadge>}
          onPress={onOpen ? () => onOpen(r.id) : undefined} testId={`activity-row-${r.id}`} />
        {r.finished ? <div className="ds-row-actions"><Button variant="ghost" onClick={() => deleteActivity(r.id)} data-testid="activity-remove">{t("activity.remove")}</Button></div> : null}{/* outside the pressable row: a button never nests in a button */}
        {steps ? <div className="ds-checks-line ds-note" data-testid="activity-steps">{STEPS.map((name, i) => <span key={name} data-ok={steps[i] ? "1" : "0"}>{steps[i] ? "✓" : "○"} {name}</span>)}</div> : null}
        {r.swap?.track?.label === "Partial" ? <p className="ds-note">{t("activity.partial", { delivered: r.swap.track.deliveredAmount ?? "?", returned: r.swap.track.refundedAmount ?? "?" })}</p> : null}
        {r.campaignLine ? <p className="ds-note" data-testid="activity-campaign">{r.campaignLine}</p> : null}
        {advanced && r.swap ? <p className="ds-note" data-testid="activity-wide">{r.swap.provider}{r.swap.fundedTx ? ` · ${t("activity.funded", { ref: shortRef(r.swap.fundedTx) })}` : ""}{r.swap.executionTx ? ` · ${t("activity.execution", { ref: shortRef(r.swap.executionTx) })}` : ""}{r.swap.track?.destinationTxHash ? ` · ${t("activity.destinationTx", { ref: shortRef(r.swap.track.destinationTxHash) })}` : ""}</p> : null}
      </div>
    );
  };

  return (
    <Page title={t("route.activity")} back={onBack} testId="activity" actions={<IconButton label={t("activity.refresh")} icon="refresh" onClick={() => void refresh()} disabled={!!refreshing} data-testid="activity-refresh" />}>
      <div className="ds-stack">
        {refreshing ? <p className="ds-note" data-testid="activity-refreshing">{refreshing}</p> : null}
        {running.running ? <p className="ds-note-warn" role="status">{running.running.line}</p> : null}
        {failed.map((a) => <p key={a.id} className="ds-note-warn" data-testid="activity-failed-action">{t("activity.fundingFailed", { ref: shortRef(a.orderId), error: a.error ?? "", next: a.nextAttemptAt ? t("activity.nextAttempt", { time: new Date(a.nextAttemptAt).toLocaleString(), n: (a.attempts ?? 0) + 1 }) : "" })}</p>)}
        {rows.length === 0 ? <Card><p className="ds-note" data-testid="activity-empty">{t("activity.empty")}</p></Card> : null}
        {groups.map((g) => (
          <section key={g.key} className="ds-stack-sm" data-testid="activity-group" data-day={g.key}>
            <h3 className="ds-kv-label" data-testid="activity-day">{g.label}</h3>
            <Card padding="none">{g.rows.map(row)}</Card>
          </section>
        ))}
        <p className="ds-note">{t("activity.footnote")}</p>
      </div>
    </Page>
  );
}
