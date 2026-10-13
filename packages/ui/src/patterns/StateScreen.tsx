// The four states of a screen (spec v2.0 §5): empty, loading, error, done — a calm mark, a title, one sentence, the next
// action. An error says what happened to the funds first (the ErrorCard's rule); "done" uses the protection's green.
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";

export type StateKind = "empty" | "loading" | "error" | "done";
const MARK: Record<StateKind, IconName> = { empty: "shield", loading: "spinner", error: "warning", done: "check-circle" };

export function StateScreen({
  kind,
  title,
  body,
  icon,
  actions,
  testId = "state",
}: {
  kind: StateKind;
  title: string;
  body?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section className={cx("ds-state", `ds-state-${kind}`)} data-testid={testId} data-kind={kind} aria-busy={kind === "loading" || undefined}>
      <span className="ds-state-mark" aria-hidden>
        <Icon name={icon ?? MARK[kind]} size={28} className={kind === "loading" ? "ds-spin" : undefined} />
      </span>
      <h2 className="ds-state-title">{title}</h2>
      {body ? <div className="ds-state-body">{body}</div> : null}
      {actions ? <div className="ds-state-actions">{actions}</div> : null}
    </section>
  );
}
