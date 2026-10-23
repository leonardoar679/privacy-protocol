import { lintSummary, type LintCategory, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import { useT } from "../app/i18n/useT";
import type { MessageKey } from "../app/i18n/en";
import { hoursText } from "../app/i18n/duration";

// The privacy lint as plan §48's ✓ / ⚠ lines (whale spec §18): one line per item with its category; a
// block item (tier ≥ high-value) shows "I understand" until acknowledged, and the confirmation stays
// disabled while one remains (Stage 6 wires the hold-to-confirm to it). Every word is the catalog's, each
// sentence by its code (audit round 2, r55): the check had read in English to a Korean reader.
const MARK: Record<LintItem["level"], string> = { ok: "✓", warn: "⚠", block: "✖" };
const CATEGORY: Record<LintCategory, MessageKey> = {
  "Financial privacy": "lint.category.financial",
  "Destination linkage": "lint.category.destination",
  "Provider visibility": "lint.category.provider",
  "Timing risk": "lint.category.timing",
  "Amount fingerprint": "lint.category.amount",
  "Network privacy": "lint.category.network",
};

/** An item's sentence in the reader's words: its code's catalog words with its values (an item without a code keeps its text). */
export function lintWords(t: ReturnType<typeof useT>, i: LintItem): string {
  const w = i.words;
  if (!w) return i.text;
  return t(`lint.${w.code}` as MessageKey, {
    ...(w.delaySeconds !== undefined ? { delay: hoursText(t, w.delaySeconds) } : {}),
    ...(w.holders !== undefined ? { holders: w.holders, plural: w.holders === 1 ? "" : "s" } : {}),
    ...(w.gaps ? { gaps: w.gaps.map((g) => t(`lint.gap.${g}` as MessageKey)).join("; ") } : {}),
  });
}

export function PrivacyLint({ items, onAcknowledge, compact }: { items: LintItem[]; onAcknowledge?: (id: LintItem["id"]) => void; compact?: boolean }) {
  const t = useT();
  const s = lintSummary(items);
  return (
    <div style={{ marginTop: 10 }} data-testid="privacy-lint">
      <div className="row"><span className="muted">{t("lint.title")}</span><b>{s.block ? t("lint.toAcknowledge", { n: s.block }) : s.warn ? t("lint.warnings", { n: s.warn, plural: s.warn === 1 ? "" : "s" }) : t("lint.allClear")}</b></div>
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
        {items.filter((i) => !compact || i.level !== "ok").map((i) => (
          <li key={i.id} className="small" style={{ padding: "3px 0", display: "flex", gap: 8, alignItems: "flex-start" }} data-level={i.level} data-item={i.id}>
            <span className={i.level === "ok" ? "level-Excellent" : i.level === "warn" ? "level-Reduced" : "error"} style={{ width: 16, flex: "0 0 16px" }}>{i.acknowledged ? "✓" : MARK[i.level]}</span>
            <span>
              <span className="muted">{t(CATEGORY[i.category])} · </span>{lintWords(t, i)}
              {i.level === "block" && !i.acknowledged && onAcknowledge && <button className="tab" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }} onClick={() => onAcknowledge(i.id)}>{t("lint.understand")}</button>}
              {i.acknowledged && <span className="muted"> {t("lint.acknowledged")}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
