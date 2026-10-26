// The History page (the original's Txs.vue, Tx.vue, Job.vue): this device's deposits and withdrawal jobs — time
// passed, amount, subsequent deposits, the transaction hash, the status — filtered by Spent / Unspent. Never a note.
import { depositsCount, passedWords, t } from "../app/i18n/messages";
import { shortHash } from "../model/format";
import { poolOf } from "../model/pools";
import { timePassed } from "../model/time";
import type { HistoryRow } from "../model/types";
import { Badge, Card } from "./ui";

export type HistoryFilter = "all" | "spent" | "unspent";

const toneOf = (s: HistoryRow["status"]): "ok" | "warn" | "off" | "danger" =>
  s === "failed" || s === "FAILED" ? "danger" : s === "deposited" || s === "withdrawn" || s === "CONFIRMED" ? "ok" : "warn";
const wordOf = (s: HistoryRow["status"]): string => t(`status.${s}` as "status.waiting");

export function History(props: { rows: HistoryRow[]; filter: HistoryFilter; onFilter: (f: HistoryFilter) => void; now: number }) {
  const rows = props.rows.filter((r) => (props.filter === "all" ? true : props.filter === "spent" ? r.spent === true : r.spent === false));
  return (
    <Card title={t("history.title")} testId="classic-history">
      <div className="tc-filters" role="radiogroup" aria-label={t("history.filterBy")}>
        <span className="tc-label">{t("history.filterBy")}</span>
        {(["all", "unspent", "spent"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={props.filter === f}
            className={`tc-segment${props.filter === f ? " tc-segment-active" : ""}`}
            data-testid={`classic-filter-${f}`}
            onClick={() => props.onFilter(f)}
          >
            {t(f === "all" ? "history.all" : f === "spent" ? "history.spent" : "history.unspent")}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="tc-text tc-muted" data-testid="classic-history-empty">
          {t("history.empty")}
        </p>
      ) : (
        <ul className="tc-tx-list">
          {rows.map((r) => {
            const pool = poolOf(r.pool);
            return (
              <li key={r.id} className={`tc-tx${toneOf(r.status) === "danger" ? " tc-tx-failed" : ""}`} data-testid={`classic-tx-${r.id}`}>
                <div className="tc-tx-cell">
                  <span className="tc-tx-label">{t("history.timePassed")}</span>
                  <span>{passedWords(timePassed(r.timestamp, props.now))}</span>
                </div>
                <div className="tc-tx-cell">
                  <span className="tc-tx-label">{t("history.amount")}</span>
                  <span>{pool.amount} ETH</span>
                </div>
                <div className="tc-tx-cell">
                  <span className="tc-tx-label">{t("history.subsequent")}</span>
                  <span>{r.depositsSince === undefined ? t("history.pending") : depositsCount(r.depositsSince)}</span>
                </div>
                <div className="tc-tx-cell">
                  <span className="tc-tx-label">{t("history.txHash")}</span>
                  <span className="tc-mono">{r.txHash ? shortHash(r.txHash, 8, 6) : t("history.pending")}</span>
                </div>
                <div className="tc-tx-cell">
                  <span className="tc-tx-label">{t("history.status")}</span>
                  <Badge tone={toneOf(r.status)}>{wordOf(r.status)}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
