import { lintSummary, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";

// The privacy lint as plan §48's ✓ / ⚠ lines (whale spec §18): one line per item with its category; a
// block item (tier ≥ high-value) shows "I understand" until acknowledged, and the confirmation stays
// disabled while one remains (Stage 6 wires the hold-to-confirm to it).
const MARK: Record<LintItem["level"], string> = { ok: "✓", warn: "⚠", block: "✖" };

export function PrivacyLint({ items, onAcknowledge, compact }: { items: LintItem[]; onAcknowledge?: (id: LintItem["id"]) => void; compact?: boolean }) {
  const s = lintSummary(items);
  return (
    <div style={{ marginTop: 10 }} data-testid="privacy-lint">
      <div className="row"><span className="muted">Privacy check</span><b>{s.block ? `${s.block} to acknowledge` : s.warn ? `${s.warn} warning${s.warn === 1 ? "" : "s"}` : "all clear"}</b></div>
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
        {items.filter((i) => !compact || i.level !== "ok").map((i) => (
          <li key={i.id} className="small" style={{ padding: "3px 0", display: "flex", gap: 8, alignItems: "flex-start" }} data-level={i.level} data-item={i.id}>
            <span className={i.level === "ok" ? "level-Excellent" : i.level === "warn" ? "level-Reduced" : "error"} style={{ width: 16, flex: "0 0 16px" }}>{i.acknowledged ? "✓" : MARK[i.level]}</span>
            <span>
              <span className="muted">{i.category} · </span>{i.text}
              {i.level === "block" && !i.acknowledged && onAcknowledge && <button className="tab" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }} onClick={() => onAcknowledge(i.id)}>I understand</button>}
              {i.acknowledged && <span className="muted"> (acknowledged)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
