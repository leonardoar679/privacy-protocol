import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import { useT } from "../app/i18n/useT";
import { SETTLEMENT_STEP_WORDS, SETTLEMENT_WORDS } from "./settlementWords";

// The four-step line of plan §60 and the label of plan §61 (whale spec §19): shown for every swap, in
// the Swap screen and in Activity. A partial fill says what arrived and what came back. In the reader's words (the eleventh review
// round, the critique of slice 2b): the tracker's own sentence — English, in the protocol's terms ("escrow", "re-shielded") — is shown
// under Advanced only; the order card reaches a Simple reader from the swap's own page.
export function SettlementLine({ tracked, compact, advanced }: { tracked: Tracked; compact?: boolean; advanced?: boolean }) {
  const t = useT();
  const words = SETTLEMENT_WORDS[tracked.label];
  return (
    <div data-testid="settlement" data-state={tracked.state} data-label={tracked.label}>
      <div className="row" style={{ alignItems: "center" }}>
        <span className="muted">{t("order.status")}</span>
        <b className={tracked.label === "Needs attention" ? "level-Reduced" : tracked.label === "Completed" || tracked.label === "Refunded" ? "level-Excellent" : ""}>
          {words ? t(words) : tracked.label}
        </b>
      </div>
      <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", margin: "4px 0" }} data-testid="settlement-steps">
        {SETTLEMENT_STEP_WORDS.map((key, i) => (
          <span key={key} className={tracked.steps[i] ? "level-Excellent" : "muted"} data-step={i} data-done={tracked.steps[i] ? "1" : "0"}>
            {tracked.steps[i] ? "✓" : "○"} {t(key)}
          </span>
        ))}
      </div>
      {!compact && advanced && (
        <p className="muted small" style={{ margin: "2px 0 0" }} data-testid="settlement-detail">
          {tracked.detail}
        </p>
      )}
      {!compact && tracked.label === "Partial" && (tracked.deliveredAmount || tracked.refundedAmount) && (
        <p className="muted small" style={{ margin: "2px 0 0" }} data-testid="settlement-partial">
          {t("settlement.partialAmounts", { delivered: tracked.deliveredAmount ?? "?", returned: tracked.refundedAmount ?? "?" })}
        </p>
      )}
    </div>
  );
}
