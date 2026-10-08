import { useState } from "react";
import type { Deployment } from "../sdk/chain";
import { usePosture } from "../wallet/posture";
import { usePoolStats } from "../wallet/poolStats";

// The Privacy Center (plan V2 §75, §93; whale spec §23): six categories — Financial history, Address
// separation, Network privacy, RPC privacy, Timing privacy, Cross-chain privacy — each with a word level
// beside its number and a plain explanation, then what this wallet cannot promise (plan §69). The numbers
// come from the same lab-calibrated model as every action's scorecard; nothing here is fetched.
export function PrivacyCenter({ deployment }: { deployment: Deployment | null }) {
  const p = usePosture(deployment);
  const stats = usePoolStats();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div data-testid="privacy-center">
      <div className="panel">
        <div className="row">
          <span className="muted">Overall</span>
          <b className={p.overall ? `level-${p.overall}` : ""}>{p.overall ?? "—"}</b>
        </div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          {stats ? `The pool holds ${stats.notes} notes (last sync ${new Date(stats.at).toLocaleTimeString()}).` : "The pool size is unknown until the first sync (a rescan or any transaction)."} Levels are bounds from the privacy lab, not promises.
        </p>
      </div>
      <div className="panel">
        {p.categories.map((c) => (
          <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <div className="row" style={{ alignItems: "center" }}>
              <span>{c.label}</span>
              <span>
                <span className="muted small" style={{ marginRight: 8 }}>{c.score === null ? "—" : `${c.score}/100`}</span>
                <b className={c.level ? `level-${c.level}` : ""}>{c.level ?? "Unknown"}</b>
                <button className="tab" style={{ marginLeft: 8, padding: "4px 10px" }} onClick={() => setOpen((v) => (v === c.id ? null : c.id))}>{open === c.id ? "Hide" : "Why"}</button>
              </span>
            </div>
            {open === c.id && <ul className="muted small" style={{ paddingLeft: 18, margin: "6px 0 0" }}>{c.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>What this wallet cannot promise</h3>
        <ul className="muted small" style={{ paddingLeft: 18, margin: 0 }}>{p.limits.map((l, i) => <li key={i} style={{ marginBottom: 4 }}>{l}</li>)}</ul>
      </div>
    </div>
  );
}
