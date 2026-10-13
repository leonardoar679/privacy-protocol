// Status on screen (spec v2.0 §5, §7; doc §9): the timeline of an operation, the error card with the sentence about the
// funds, the warning and success cards, the security card, the collapsible, the progress indicator, the skeleton and a
// list row.
import { useState, type ReactNode } from "react";
import { cx, nextId } from "../cx";
import { Icon, type IconName } from "../icons";
import { Card } from "./Layout";

export type StepState = "done" | "active" | "waiting" | "failed";
export interface TimelineStep { label: string; state: StepState; detail?: string }

export function TransactionTimeline({ steps, testId = "timeline" }: { steps: TimelineStep[]; testId?: string }) {
  return (
    <ol className="ds-timeline" data-testid={testId}>
      {steps.map((s, i) => (
        <li key={`${i}-${s.label}`} data-state={s.state} aria-current={s.state === "active" ? "step" : undefined}>
          <span className="ds-timeline-dot" aria-hidden />
          <span><span>{s.label}</span>{s.detail ? <small>{s.detail}</small> : null}</span>
        </li>
      ))}
    </ol>
  );
}

export type FundsState = "not-moved" | "still-protected" | "unknown";

/** Plan §38: a title, the sentence about the funds first, the reason, the actions — never a raw code. */
export function ErrorCard({ title, fundsLine, fundsState, reason, actions, testId = "error" }: { title: string; fundsLine: string; fundsState: FundsState; reason?: string; actions?: ReactNode; testId?: string }) {
  return (
    <Card elevation={1} className="ds-error-card" testId={testId} as="section">
      <h2 className="ds-error-title">{title}</h2>
      <p className="ds-error-funds" data-state={fundsState} data-testid={`${testId}-funds`}>{fundsLine}</p>
      {reason ? <p className="ds-error-reason" data-testid={`${testId}-reason`}>{reason}</p> : null}
      {actions ? <div className="ds-error-actions">{actions}</div> : null}
    </Card>
  );
}

/** A caution that does not stop anything (doc §9): amber, a title, one or two sentences, an optional action. */
export function WarningCard({ title, body, action, testId = "warning" }: { title: string; body?: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <Card elevation={0} className="ds-warning-card" testId={testId} as="section">
      <div className="ds-callout">
        <span className="ds-callout-icon ds-callout-icon-warn">
          <Icon name="warning" size={22} />
        </span>
        <div className="ds-callout-text">
          <h2 className="ds-callout-title">{title}</h2>
          {body ? <div className="ds-callout-body">{body}</div> : null}
          {action ? <div className="ds-error-actions">{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

/** A finished operation (doc §9, §58): the protection's green, a title, the facts, the next actions. */
export function SuccessCard({ title, body, details, actions, testId = "success" }: { title: string; body?: ReactNode; details?: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <Card elevation={1} className="ds-success-card" testId={testId} as="section">
      <div className="ds-callout">
        <span className="ds-callout-icon ds-callout-icon-success">
          <Icon name="check-circle" size={22} />
        </span>
        <div className="ds-callout-text">
          <h2 className="ds-callout-title">{title}</h2>
          {body ? <div className="ds-callout-body">{body}</div> : null}
        </div>
      </div>
      {details ? <div className="ds-success-details">{details}</div> : null}
      {actions ? <div className="ds-error-actions">{actions}</div> : null}
    </Card>
  );
}

export function SecurityCard({ icon = "shield-check", title, body, action, testId }: { icon?: IconName; title: string; body: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <Card elevation={1} testId={testId} as="section">
      <div className="ds-security">
        <span className="ds-security-icon"><Icon name={icon} size={28} /></span>
        <div>
          <h2 className="ds-security-title">{title}</h2>
          <div className="ds-security-body">{body}</div>
          {action ? <div className="ds-error-actions">{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export function Collapsible({ summary, children, defaultOpen = false, testId = "collapsible" }: { summary: string; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [id] = useState(() => nextId("collapsible"));
  return (
    <div className="ds-collapsible" data-testid={testId}>
      <button type="button" className="ds-collapsible-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-testid={`${testId}-toggle`}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={16} /><span>{summary}</span>
      </button>
      {open ? <div className="ds-collapsible-body" id={id}>{children}</div> : null}
    </div>
  );
}

/** A determinate bar for 0…1, indeterminate for null (while the step has no fraction; doc §58). */
export function ProgressIndicator({ value, label, testId = "progress" }: { value: number | null; label: string; testId?: string }) {
  const pct = value === null ? undefined : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cx("ds-progress", value === null && "ds-progress-indeterminate")} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-testid={testId}>
      <span className="ds-progress-bar" style={value === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ width = "100%", height = 16 }: { width?: number | string; height?: number | string }) {
  return <span className="ds-skeleton" aria-hidden style={{ width, height }} />;
}

export function ListRow({ title, subtitle, leading, trailing, onPress, testId }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; testId?: string }) {
  const body = (
    <>
      {leading}
      <span className="ds-list-main"><span>{title}</span>{subtitle ? <span className="ds-list-sub">{subtitle}</span> : null}</span>
      {trailing ?? (onPress ? <Icon name="chevron-right" size={18} /> : null)}
    </>
  );
  return onPress
    ? <button type="button" className="ds-list-row" onClick={onPress} data-testid={testId}>{body}</button>
    : <div className="ds-list-row" data-testid={testId}>{body}</div>;
}
