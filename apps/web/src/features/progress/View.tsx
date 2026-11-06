// Progress (spec v2.0 §7.7; doc §40, §50, §58): what the wallet is doing, in words a person reads — "Securing your
// transaction" in Simple, never "proof" — with a determinate bar from this device's own estimate. A large operation shows
// amounts, never step counts: completed, executing, remaining. Pure: the flows drive it from Stage 10.
import { Card, Page, ProgressIndicator, TransactionTimeline, type StepState } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Usd } from "../viewKit";

export type ProgressStepKind = "balance" | "fees" | "securing" | "confirmation";
export interface ProgressModel {
  steps: { kind: ProgressStepKind; state: StepState }[];
  /** 0…1 from this device's estimate; null while a step has no fraction */
  fraction: number | null;
  /** a large operation (doc §50): "$80,000 ETH → BTC", then the amounts; what did not arrive as asked on a line of its own (VE-1) */
  large?: {
    title: string;
    totalUsdCents: bigint;
    completedUsdCents: bigint;
    executingUsdCents: bigint;
    remainingUsdCents: bigint;
    notDeliveredUsdCents?: bigint;
    returnCostsUsdCents?: bigint;
  } | null;
}

const STEP: Record<ProgressStepKind, MessageKey> = {
  balance: "screen.progress.balance",
  fees: "screen.progress.fees",
  securing: "screen.progress.securing",
  confirmation: "screen.progress.confirmation",
};

export function ProgressView({ model: m }: { model: ProgressModel }) {
  const t = useT();
  // the step in hand, read out as it changes (the eleventh review round, 2026-11-04, E11-6): the page's one live region had been a fixed
  // sentence, so a screen reader never heard "Calculating fees" give way to "Securing your transaction"
  const current = m.steps.find((s) => s.state === "active" || s.state === "failed");
  return (
    <Page title={t("screen.progress.title")} testId="progress-view">
      {m.large ? (
        <Card padding="lg" testId="progress-large">
          <h2 className="ds-card-title">
            <Usd cents={m.large.totalUsdCents} /> {m.large.title}
          </h2>
          <p className="ds-callout-body">{t("screen.review.large.title")}</p>
          <dl className="ds-review-rows ds-detail-rows">
            <div className="ds-review-row ds-review-row-positive">
              <dt>{t("screen.progress.completed")}</dt>
              <dd>
                <Usd cents={m.large.completedUsdCents} />
              </dd>
            </div>
            <div className="ds-review-row">
              <dt>{t("screen.progress.executing")}</dt>
              <dd>
                <Usd cents={m.large.executingUsdCents} />
              </dd>
            </div>
            <div className="ds-review-row">
              <dt>{t("screen.progress.remaining")}</dt>
              <dd>
                <Usd cents={m.large.remainingUsdCents} />
              </dd>
            </div>
            {/* what neither arrived as asked nor came back: its own line, never Remaining (the eleventh review round, 2026-11-04, VE-1) */}
            {m.large.notDeliveredUsdCents ? (
              <div className="ds-review-row ds-review-row-warn" data-testid="progress-not-delivered">
                <dt>{t("screen.progress.notDelivered")}</dt>
                <dd>
                  <Usd cents={m.large.notDeliveredUsdCents} />
                </dd>
              </div>
            ) : null}
            {/* what returned steps did not bring back (their fees): a cost of those steps, never "not delivered" (the critique of E11-1) */}
            {m.large.returnCostsUsdCents ? (
              <div className="ds-review-row" data-testid="progress-return-costs">
                <dt>{t("screen.progress.returnCosts")}</dt>
                <dd>
                  <Usd cents={m.large.returnCostsUsdCents} />
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ) : null}
      <Card padding="lg" testId="progress-steps">
        <p className="ds-progress-title" role="status" aria-live="polite" aria-atomic="true" data-testid="progress-live">
          {t("screen.progress.preparing")}
          {current ? <span className="sr-only"> {t(STEP[current.kind])}</span> : null}
        </p>
        <TransactionTimeline steps={m.steps.map((s) => ({ label: t(STEP[s.kind]), state: s.state }))} testId="progress-timeline" />
        <ProgressIndicator value={m.fraction} label={t("screen.progress.preparing")} testId="progress-bar" />
      </Card>
    </Page>
  );
}
