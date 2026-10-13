// Activity and an operation's detail (spec v2.0 §7.8; doc §39–§41, §73). The list groups by day — Today, Yesterday,
// then the date in the user's locale — one row per movement: a friendly icon, "ETH → BTC" / "Private Send" /
// "Protected USDC", the amount, one status word. The detail: the pair and the amount, the status, what was paid and
// received, the fees, the execution timeline; Advanced holds the identifiers, the transaction, the settlement and
// recovery states and "Remove from this device". A failed or delayed operation shows its recovery (the route passes
// the live card in), never a generic Retry. Pure: view-models in, callbacks out.
import type { ReactNode } from "react";
import {
  Card,
  Collapsible,
  Icon,
  IconButton,
  ListRow,
  Page,
  StateScreen,
  StatusBadge,
  TextButton,
  TransactionTimeline,
  type IconName,
  type StepState,
} from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { Amt, STATUS_TONE, STATUS_WORD, Usd, type Amount, type Status } from "../viewKit";

export interface ActivityRowView {
  id: string;
  icon: IconName;
  title: string;
  amount: Amount;
  usdCents: bigint | null;
  status: Status;
}
export interface ActivityGroupView {
  key: string;
  label: string;
  rows: ActivityRowView[];
}
export interface ActivityModel {
  groups: ActivityGroupView[];
  /** "Tracking 2 open swaps…" while a refresh runs */
  refreshing?: string | null;
  /** the Advanced experience's lines (a scheduled funding that failed, with its technical reason) */
  advanced?: string[] | null;
}

export function ActivityView({
  model: m,
  onOpen,
  onRefresh,
  notice,
  wide,
}: {
  model: ActivityModel;
  onOpen: (id: string) => void;
  onRefresh?: () => void;
  notice?: ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  return (
    <Page
      title={t("route.activity")}
      testId="activity"
      width={wide ? "wide" : "phone"}
      actions={
        onRefresh ? (
          <IconButton label={t("activity.refresh")} icon="refresh" onClick={onRefresh} disabled={!!m.refreshing} data-testid="activity-refresh" />
        ) : undefined
      }
    >
      {notice}
      {m.refreshing ? (
        <p className="ds-note" role="status" data-testid="activity-refreshing">
          {m.refreshing}
        </p>
      ) : null}
      {m.groups.length === 0 ? (
        <Card>
          <StateScreen kind="empty" title={t("activity.emptyTitle")} body={t("activity.empty")} testId="activity-empty" />
        </Card>
      ) : null}
      {m.groups.map((g) => (
        <section key={g.key} className="ds-stack-sm" data-testid="activity-group" data-day={g.key} aria-labelledby={`day-${g.key}`}>
          <h2 className="ds-group-title" id={`day-${g.key}`} data-testid="activity-day">
            {g.label}
          </h2>
          <Card padding="sm">
            {g.rows.map((r) => (
              <div key={r.id} data-testid="activity-row" data-status={r.status}>
                <ListRow
                  leading={
                    <span className="ds-row-icon" aria-hidden>
                      <Icon name={r.icon} size={20} />
                    </span>
                  }
                  title={r.title}
                  trailing={
                    <span className="ds-row-end">
                      <span className="ds-numeral">{r.usdCents !== null ? <Usd cents={r.usdCents} /> : <Amt a={r.amount} />}</span>
                      <StatusBadge tone={STATUS_TONE[r.status]}>{t(STATUS_WORD[r.status])}</StatusBadge>
                    </span>
                  }
                  onPress={() => onOpen(r.id)}
                  testId={`activity-row-${r.id}`}
                />
              </div>
            ))}
          </Card>
        </section>
      ))}
      {m.advanced?.length ? (
        <Collapsible summary={t("home.advanced")} testId="activity-advanced">
          {m.advanced.map((l) => (
            <p key={l} className="ds-note-warn" data-testid="activity-failed-action">
              {l}
            </p>
          ))}
        </Collapsible>
      ) : null}
    </Page>
  );
}

export interface DetailStep {
  label: string;
  state: StepState;
}
export interface DetailModel {
  id: string;
  title: string;
  amount: Amount;
  usdCents: bigint | null;
  status: Status;
  pay: Amount;
  /** what was (or will at least be) received */
  receive?: { amount: Amount; approx?: boolean } | null;
  destination?: { label: string; verified: boolean } | null;
  /** a fee in an asset, in USD, or — a record of an earlier pass — the words it was written with */
  fees: { label: string; value: Amount | { usdCents: bigint } | { text: string } }[];
  steps: DetailStep[];
  /** the identifiers and states of Advanced (the full transaction lives only here) */
  advanced: { label: string; value: string }[];
  canRemove: boolean;
}

export function DetailView({
  model: m,
  onBack,
  onRemove,
  onRefresh,
  busy,
  recovery,
  extra,
}: {
  model: DetailModel;
  onBack: () => void;
  onRemove?: () => void;
  onRefresh?: () => void;
  busy?: string | null;
  /** the recovery card of a failed or delayed operation (spec §7.8) */
  recovery?: ReactNode;
  /** a protected execution's progress and its pause switch (moved here from Home, spec §7.1) */
  extra?: ReactNode;
}) {
  const t = useT();
  return (
    <Page
      title={m.title}
      back={onBack}
      testId="activity-detail"
      actions={
        onRefresh ? <IconButton label={t("activity.refresh")} icon="refresh" onClick={onRefresh} disabled={!!busy} data-testid="detail-refresh" /> : undefined
      }
    >
      <Card padding="lg" testId="detail-summary">
        <div className="ds-detail-head">
          <span className="ds-detail-amount" data-testid="detail-value">
            {m.usdCents !== null ? <Usd cents={m.usdCents} /> : <Amt a={m.amount} />}
          </span>
          <span data-testid="detail-status">
            <StatusBadge tone={STATUS_TONE[m.status]}>{t(STATUS_WORD[m.status])}</StatusBadge>
          </span>
        </div>
        <dl className="ds-review-rows ds-detail-rows">
          <div className="ds-review-row">
            <dt>{t("activity.youPay")}</dt>
            <dd>
              <Amt a={m.pay} />
            </dd>
          </div>
          {m.receive ? (
            <div className="ds-review-row" data-testid="detail-receive">
              <dt>{t("activity.youReceive")}</dt>
              <dd>
                <Amt a={m.receive.amount} approx={m.receive.approx} />
              </dd>
            </div>
          ) : null}
          {m.destination ? (
            <div className="ds-review-row" data-testid="detail-destination">
              <dt>{t("activity.destination")}</dt>
              <dd>
                {m.destination.label}
                {m.destination.verified ? ` · ${t("activity.verified")}` : ""}
              </dd>
            </div>
          ) : null}
          {m.fees.map((f) => (
            <div className="ds-review-row" key={f.label}>
              <dt>{f.label}</dt>
              <dd>{"usdCents" in f.value ? <Usd cents={f.value.usdCents} /> : "text" in f.value ? f.value.text : <Amt a={f.value} />}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {extra}
      {m.steps.length ? (
        <Card padding="md" testId="detail-execution">
          <h2 className="ds-card-title">{t("activity.executionTitle")}</h2>
          <TransactionTimeline steps={m.steps} testId="detail-timeline" />
        </Card>
      ) : null}
      {busy ? (
        <p className="ds-note" role="status" data-testid="detail-busy">
          {busy}
        </p>
      ) : null}
      {recovery}
      <Collapsible summary={t("activity.advancedDetails")} testId="detail-advanced">
        <dl className="ds-review-rows ds-note" data-testid="detail-advanced-list">
          {m.advanced.map((r) => (
            <div className="ds-review-row" key={r.label}>
              <dt>{r.label}</dt>
              <dd className="ds-mono-break">{r.value}</dd>
            </div>
          ))}
        </dl>
        {m.canRemove && onRemove ? (
          <TextButton onClick={onRemove} data-testid="detail-remove">
            {t("activity.removeFromDevice")}
          </TextButton>
        ) : null}
      </Collapsible>
    </Page>
  );
}
