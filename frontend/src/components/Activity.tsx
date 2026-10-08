import { formatUnits } from "viem";
import { activityOf, activityStatusLabel, deleteActivity, isFinished, KIND_LABELS } from "../wallet/activity";
import { session, useSession } from "../wallet/session";
import { useSchedulerStatus } from "../wallet/schedule";
import { shortRef } from "../sdk/format";

// Activity (plan V2 §49–§50; whale spec §25): one local list of everything this wallet moved — date,
// asset, amount, status, the private reference — from the encrypted journal, never from a server.
// Scheduled actions that failed show their error and the next attempt. Finished rows can be removed.
export function Activity() {
  useSession(); // re-render on every journal write
  const unlocked = session.isUnlocked();
  const j = unlocked ? session.journal() : null;
  const rows = j ? [...activityOf(j)].sort((a, b) => b.at - a.at) : [];
  const failed = j ? j.schedule.filter((a) => !a.done && a.error) : [];
  const running = useSchedulerStatus();
  const amount = (r: (typeof rows)[number]) => { try { return `${formatUnits(BigInt(r.amount), r.decimals)} ${r.asset}`; } catch { return `${r.amount} ${r.asset}`; } };
  return (
    <div data-testid="activity">
      <h2>Activity</h2>
      {running.running && <p className="notice">{running.running.line}</p>}
      {failed.map((a) => (
        <p key={a.id} className="notice">
          Scheduled funding of swap {shortRef(a.orderId)} failed: {a.error}. {a.nextAttemptAt ? `Next attempt ${new Date(a.nextAttemptAt).toLocaleString()} (attempt ${(a.attempts ?? 0) + 1}).` : ""} Open the swap to fund it now or return it.
        </p>
      ))}
      <div className="panel">
        {rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing yet. Activity is kept only on this device, inside your encrypted journal.</p>}
        {rows.map((r) => (
          <div key={r.id} className="list-row" data-testid="activity-row">
            <div style={{ minWidth: 0 }}>
              <div><b>{KIND_LABELS[r.kind]}</b> <span className="muted small">· {new Date(r.at).toLocaleString()}</span></div>
              <div className="muted small">{amount(r)}{r.note ? ` · ${r.note}` : ""}</div>
              <div className="muted small"><code>{shortRef(r.ref)}</code> <button className="tab" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(r.ref)}>Copy</button></div>
            </div>
            <div style={{ textAlign: "right", flex: "0 0 auto" }}>
              <div><b>{activityStatusLabel(r)}</b></div>
              {isFinished(r) && <button className="tab" style={{ padding: "2px 8px", fontSize: 12, marginTop: 4 }} onClick={() => deleteActivity(r.id)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small">Statuses: Pending, Funded, Executing, Refunding, Refunded, Completed, Needs attention. A swap is not atomic: a refund is a normal outcome and returns to your private balance by itself.</p>
    </div>
  );
}
