import { useState } from "react";
import { formatUnits } from "viem";
import { activityId, activityOf, activityStatusLabel, deleteActivity, isFinished, KIND_LABELS } from "../wallet/activity";
import { session, useSession } from "../wallet/session";
import { useSchedulerStatus } from "../wallet/schedule";
import { useSettings } from "../wallet/settings";
import { shortRef } from "../sdk/format";
import { STEPS, trackOrder } from "../sdk/orderTracker";
import { isOpenSwap } from "../sdk/swapFunding";
import type { Deployment } from "../sdk/chain";
import type { StoredSwap } from "../wallet/journal";
import { campaignById } from "../wallet/campaigns";
import { planWords } from "../sdk/tiers";
import { exposure } from "@ref/wallet/campaign";
import { levelOf } from "@ref/wallet/privacyCenter";
import { formatUsd } from "@ref/wallet/valuation";

// Activity (plan V2 §49–§50, §96; whale spec §19, §25): one local list of everything this wallet moved —
// date, asset, amount, status, the private reference — from the encrypted journal, never from a server.
// A swap row carries the plan §61 label the tracker last derived and the four-step line of plan §60; a
// wide screen (or Advanced) adds the provider and the transaction hashes. "Refresh" tracks every open
// swap once. Scheduled actions that failed show their error and the next attempt. Finished rows can be removed.
export function Activity({ deployment = null }: { deployment?: Deployment | null }) {
  useSession(); // re-render on every journal write
  const { submission, advanced } = useSettings();
  const [refreshing, setRefreshing] = useState("");
  const unlocked = session.isUnlocked();
  const j = unlocked ? session.journal() : null;
  // V3 (High-Value Protection spec §15): a protected execution is one row; its steps (orders with `campaign`) show under Advanced only
  const stepIds = new Set((j?.swaps ?? []).filter((s) => s.campaign).map((s) => activityId("swap", s.orderId)));
  const rows = j ? [...activityOf(j)].filter((r) => advanced || !stepIds.has(r.id)).sort((a, b) => b.at - a.at) : [];
  const failed = j ? j.schedule.filter((a) => !a.done && a.error) : [];
  const swaps = new Map<string, StoredSwap>((j?.swaps ?? []).map((s) => [activityId("swap", s.orderId), s]));
  const running = useSchedulerStatus();
  const amount = (r: (typeof rows)[number]) => { try { return `${formatUnits(BigInt(r.amount), r.decimals)} ${r.asset}`; } catch { return `${r.amount} ${r.asset}`; } };
  const stepsOf = (s: StoredSwap): boolean[] | null => {
    const st = s.track?.state;
    if (!st) return null;
    const i = ["COMMITTED", "SOURCE_SUBMITTED", "SOURCE_FINAL", "PROVIDER_EXECUTING", "DESTINATION_SUBMITTED", "DESTINATION_FINAL", "COMPLETED"].indexOf(st);
    if (st === "PARTIAL") return [true, true, true, false];
    if (["REFUND_PENDING", "PROVIDER_TIMEOUT", "DESTINATION_FAILED", "REFUNDED", "FAILED"].includes(st)) return [true, true, false, false];
    if (["CANCELLED", "EXPIRED"].includes(st)) return [true, false, false, false];
    return [i >= 0, i >= 2, i >= 4, i >= 5];
  };

  async function refresh() {
    if (!j) return;
    const open = j.swaps.filter((s) => isOpenSwap(s) && !["committed"].includes(s.state) || (isOpenSwap(s) && !!s.fundedTx));
    setRefreshing(`Tracking ${open.length} open swap${open.length === 1 ? "" : "s"}…`);
    for (const s of open) { try { await trackOrder(s, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null }); } catch { /* next */ } }
    setRefreshing("");
  }

  return (
    <div data-testid="activity">
      <div className="row" style={{ alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Activity</h2>
        <button className="tab" onClick={refresh} disabled={!!refreshing}>Refresh</button>
      </div>
      {refreshing && <p className="muted small">{refreshing}</p>}
      {running.running && <p className="notice">{running.running.line}</p>}
      {failed.map((a) => (
        <p key={a.id} className="notice">
          Scheduled funding of swap {shortRef(a.orderId)} failed: {a.error}. {a.nextAttemptAt ? `Next attempt ${new Date(a.nextAttemptAt).toLocaleString()} (attempt ${(a.attempts ?? 0) + 1}).` : ""} Open the swap to fund it now or return it.
        </p>
      ))}
      <div className="panel">
        {rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing yet. Activity is kept only on this device, inside your encrypted journal.</p>}
        {rows.map((r) => {
          const swap = r.kind === "swap" ? swaps.get(r.id) : undefined;
          const steps = swap ? stepsOf(swap) : null;
          const label = swap?.track?.label ?? activityStatusLabel(r);
          return (
            <div key={r.id} className="list-row" data-testid="activity-row" data-label={label}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div><b>{KIND_LABELS[r.kind]}</b> <span className="muted small">· {new Date(r.at).toLocaleString()}</span></div>
                <div className="muted small">{amount(r)}{r.note ? ` · ${r.note.replace(/ · (Preparing|Waiting for source|Executing|Waiting for destination|Partial|Refunding|Refunded|Completed|Not started|Needs attention)$/, "")}` : ""}</div>
                {steps && (
                  <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px" }} data-testid="activity-steps">
                    {STEPS.map((name, i) => <span key={name} className={steps[i] ? "level-Excellent" : "muted"}>{steps[i] ? "✓" : "○"} {name}</span>)}
                  </div>
                )}
                {swap?.track?.label === "Partial" && <div className="muted small">Delivered {swap.track.deliveredAmount ?? "?"} · returned {swap.track.refundedAmount ?? "?"}</div>}
                {r.kind === "campaign" && (() => {
                  // V4 (plan §100): execution, protection, privacy, duration
                  const c = campaignById(r.ref);
                  if (!c) return null;
                  const e = exposure(c);
                  const usd = c.value && typeof c.value === "object" && "usd" in (c.value as object) ? (c.value as { usd: number }).usd : null;
                  const capUsd = usd !== null && e.total > 0n ? formatUsd((usd * Number(e.cap)) / Number(e.total), { compact: true }) : `${formatUnits(e.cap, r.decimals)} ${r.asset}`;
                  const snap = (c.riskSnapshot ?? {}) as { privacyScore?: number; quote?: { plan?: { mode: string; parts: number; intervalBlocks: number; expectedSeconds: number } } };
                  const finished = c.state === "completed" || c.state === "cancelled";
                  const end = finished ? c.history[c.history.length - 1]?.at ?? Date.now() : Date.now();
                  const ms = Math.max(0, end - c.createdAt);
                  const dur = ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
                  return <div className="muted small" data-testid="activity-campaign">Execution: {planWords(snap.quote?.plan as never)} · Protection: {capUsd} max exposure · Privacy: {typeof snap.privacyScore === "number" ? levelOf(snap.privacyScore) : "—"} · Duration: {dur}{finished ? "" : " so far"}</div>;
                })()}
                <div className="muted small"><code>{shortRef(r.ref)}</code> <button className="tab" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(r.ref)}>Copy</button></div>
                {swap && (
                  <div className={advanced ? "muted small" : "muted small wide-only"} data-testid="activity-wide">
                    {swap.provider}{swap.fundedTx ? ` · funded ${shortRef(swap.fundedTx)}` : ""}{swap.executionTx ? ` · execution ${shortRef(swap.executionTx)}` : ""}{swap.track?.destinationTxHash ? ` · destination ${shortRef(swap.track.destinationTxHash)}` : ""}{swap.history?.length ? ` · ${swap.history.length} transition${swap.history.length === 1 ? "" : "s"}, last ${new Date(swap.history[swap.history.length - 1].at).toLocaleTimeString()}` : ""}
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                <div><b>{label}</b></div>
                {isFinished(r) && <button className="tab" style={{ padding: "2px 8px", fontSize: 12, marginTop: 4 }} onClick={() => deleteActivity(r.id)}>Remove</button>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">Statuses: Preparing, Waiting for source, Executing, Waiting for destination, Partial, Refunding, Refunded, Completed, Not started, Needs attention. A swap is not atomic: a refund is a normal outcome and returns to your private balance by itself.</p>
    </div>
  );
}
