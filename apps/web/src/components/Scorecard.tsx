import { useState } from "react";
import { scorecard, type ActionKind, type ScorecardFacts } from "@privacy-wallet/protocol/wallet/scorecard";
import { usePoolStats } from "../hooks";

// The privacy scorecard (plan §78) every action shows before it runs: six 0–100 scores from the
// lab-calibrated model in packages/protocol/src/wallet/scorecard.ts, the overall, and — on
// request — what limits each score. Pool size comes from the last sync; until then it is unknown.
const ROWS: { key: keyof ReturnType<typeof scorecard>; label: string }[] = [
  { key: "financial", label: "Financial privacy" },
  { key: "network", label: "Network privacy" },
  { key: "recipient", label: "Recipient privacy" },
  { key: "timing", label: "Timing privacy" },
  { key: "amount", label: "Amount privacy" },
  { key: "provider", label: "Provider privacy" },
];

export function Scorecard({ action, facts }: { action: ActionKind; facts: Omit<ScorecardFacts, "poolSize"> }) {
  const stats = usePoolStats();
  const [why, setWhy] = useState(false);
  const known = stats !== null;
  const s = scorecard(action, { ...facts, poolSize: stats?.notes ?? 0 });
  const financialUnknown = !known && (action === "withdraw" || action === "swap" || action === "credit");
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }} data-testid="scorecard">
      <div className="row"><span className="muted">Privacy</span><b>{financialUnknown ? "—" : `${s.overall}/100`}</b></div>
      {ROWS.map((r) => (
        <div key={r.key} className="row" style={{ fontSize: 13 }}>
          <span className="muted" style={{ width: 150 }}>{r.label}</span>
          <div className="bar" style={{ flex: 1, alignSelf: "center" }}><span style={{ width: `${r.key === "financial" && financialUnknown ? 0 : s[r.key]}%` }} /></div>
          <span style={{ width: 36, textAlign: "right" }}>{r.key === "financial" && financialUnknown ? "n/a" : s[r.key]}</span>
        </div>
      ))}
      <button className="tab" style={{ marginTop: 6 }} onClick={() => setWhy((v) => !v)}>{why ? "Hide" : "Why"}</button>
      {why && (
        <ul className="muted" style={{ fontSize: 12, paddingLeft: 18, margin: "6px 0 0" }}>
          {financialUnknown && <li>the pool size is unknown until the first sync (rescan or any transaction); the financial score needs it</li>}
          {known && <li>pool: {stats!.notes} notes in {stats!.leaves} leaves (last sync {new Date(stats!.at).toLocaleTimeString()})</li>}
          {s.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
