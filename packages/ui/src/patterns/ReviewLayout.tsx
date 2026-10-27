// The Review (spec v2.0 §5, §7; doc §57, §86): the amount first and largest, the sections of facts as label / value rows,
// the notices, then the one primary action (a tap or a hold) — and, apart from it, the way back as a text button, never
// a destructive button beside the confirmation.
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Card } from "../components/Layout";
import { StickyAction } from "./StickyAction";

export interface ReviewRow {
  label: string;
  value: ReactNode;
  tone?: "default" | "positive" | "warn";
  testId?: string;
}
export interface ReviewSection {
  title?: string;
  rows: ReviewRow[];
  /** a sentence under the rows (V7 Stage 12: the fee statement) */
  note?: ReactNode;
  testId?: string;
}

export function ReviewLayout({
  amount,
  sections,
  notices,
  action,
  secondaryAction,
  testId = "review",
}: {
  amount: { label?: string; primary: ReactNode; secondary?: ReactNode };
  sections: ReviewSection[];
  notices?: ReactNode;
  /** the one primary action: a Button or a HoldButton */
  action: ReactNode;
  /** a TextButton ("Edit", "Back"), kept apart from the action */
  secondaryAction?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="ds-review-layout" data-testid={testId}>
      <div className="ds-review-amount">
        {amount.label ? <span className="ds-review-amount-label">{amount.label}</span> : null}
        <span className="ds-review-amount-primary" data-testid={`${testId}-amount`}>
          {amount.primary}
        </span>
        {amount.secondary ? <span className="ds-review-amount-secondary">{amount.secondary}</span> : null}
      </div>
      {sections.map((s, i) => (
        <Card key={s.title ?? i} padding="md" testId={s.testId}>
          {s.title ? <h2 className="ds-review-section-title">{s.title}</h2> : null}
          <dl className="ds-review-rows">
            {s.rows.map((r) => (
              <div key={r.label} className={cx("ds-review-row", r.tone && r.tone !== "default" && `ds-review-row-${r.tone}`)} data-testid={r.testId}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {s.note ? (
            <p className="ds-note" data-testid={s.testId ? `${s.testId}-note` : undefined}>
              {s.note}
            </p>
          ) : null}
        </Card>
      ))}
      {notices ? <div className="ds-review-notices">{notices}</div> : null}
      <StickyAction testId={`${testId}-action`}>{action}</StickyAction>
      {secondaryAction ? <div className="ds-review-secondary">{secondaryAction}</div> : null}
    </div>
  );
}
