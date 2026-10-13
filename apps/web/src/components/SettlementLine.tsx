import { STEPS, type Tracked } from "@privacy-wallet/sdk/orderTracker";

// The four-step line of plan §60 and the label of plan §61 (whale spec §19): shown for every swap, in
// the Swap screen and in Activity. A partial fill says what arrived and what came back.
export function SettlementLine({ tracked, compact }: { tracked: Tracked; compact?: boolean }) {
  return (
    <div data-testid="settlement" data-state={tracked.state} data-label={tracked.label}>
      <div className="row" style={{ alignItems: "center" }}>
        <span className="muted">Status</span>
        <b className={tracked.label === "Needs attention" ? "level-Reduced" : tracked.label === "Completed" || tracked.label === "Refunded" ? "level-Excellent" : ""}>{tracked.label}</b>
      </div>
      <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", margin: "4px 0" }} data-testid="settlement-steps">
        {STEPS.map((name, i) => (
          <span key={name} className={tracked.steps[i] ? "level-Excellent" : "muted"} data-step={i} data-done={tracked.steps[i] ? "1" : "0"}>{tracked.steps[i] ? "✓" : "○"} {name}</span>
        ))}
      </div>
      {!compact && <p className="muted small" style={{ margin: "2px 0 0" }}>{tracked.detail}</p>}
      {!compact && tracked.label === "Partial" && (tracked.deliveredAmount || tracked.refundedAmount) && (
        <p className="muted small" style={{ margin: "2px 0 0" }}>Delivered: {tracked.deliveredAmount ?? "?"} · Returned to the escrow: {tracked.refundedAmount ?? "?"}</p>
      )}
    </div>
  );
}
