// The Statistics panel (the original's Statistics.vue), spec v3.0 §7.9: the selected pool, its "Anonymity set" — the
// number of deposits a withdrawal could originate from — and the ten latest deposits with the time since each.
import { intlLocale, passedWords, t } from "../app/i18n/messages";
import { poolOf, type PoolId } from "../model/pools";
import { timePassed } from "../model/time";
import type { PoolStats } from "../model/types";
import { Field } from "./ui";

export function Statistics(props: { pool: PoolId; stats: PoolStats | null; now: number }) {
  const pool = poolOf(props.pool);
  const n = props.stats?.deposits ?? null;
  return (
    <section className="tc-card tc-stats" data-testid="classic-statistics" aria-busy={props.stats ? undefined : true}>
      <div className="tc-stats-head">
        <h2 className="tc-card-title">{t("stats.title")}</h2>
        <span className="tc-chip" data-testid="classic-stats-pool">
          {pool.amount} ETH
        </span>
      </div>
      <Field label={t("stats.set")} info={t("stats.setTooltip")} infoLabel={t("stats.setInfo")}>
        <p className="tc-stats-set" data-testid="classic-stats-set">
          {n === null ? (
            <span className="tc-skeleton tc-skeleton-wide" aria-label={t("stats.loading")} />
          ) : (
            <>
              {t("stats.equal", { n: new Intl.NumberFormat(intlLocale()).format(n) })}
              {props.stats?.verified === false ? (
                <span className="tc-muted" data-testid="classic-stats-unverified">
                  {" "}
                  · {t("stats.unverified")}
                </span>
              ) : null}
            </>
          )}
        </p>
      </Field>
      <h3 className="tc-label">{t("stats.latest")}</h3>
      <ol className="tc-latest" data-testid="classic-stats-latest">
        {props.stats
          ? props.stats.latest.map((d) => (
              <li key={d.leafIndex} className="tc-latest-row">
                <span className="tc-latest-index">{new Intl.NumberFormat(intlLocale()).format(d.leafIndex + 1)}.</span>
                <span className="tc-latest-time">{passedWords(timePassed(d.timestamp, props.now))}</span>
              </li>
            ))
          : Array.from({ length: 10 }, (_, i) => (
              <li key={i} className="tc-latest-row">
                <span className="tc-skeleton" aria-hidden="true" />
              </li>
            ))}
      </ol>
    </section>
  );
}
