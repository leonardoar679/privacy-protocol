// The Classic app's few primitives, over the Privacy Wallet's tokens (one visual identity, spec v3.0 §7.8): buttons of
// three levels, a field with a label and an optional "info" paragraph (the original's tooltips, as text a screen reader
// and a touch screen can reach), inputs, a checkbox, a card, a notice, a modal, a status badge. No dependency.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t } from "../app/i18n/messages";

type Variant = "primary" | "secondary" | "text";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  full?: boolean;
  large?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testId?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  const { variant = "secondary" } = props;
  return (
    <button
      type={props.type ?? "button"}
      className={`tc-btn tc-btn-${variant}${props.full ? " tc-btn-full" : ""}${props.large ? " tc-btn-lg" : ""}`}
      data-variant={variant}
      data-testid={props.testId}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy || undefined}
      aria-label={props.ariaLabel}
      aria-expanded={props.ariaExpanded}
      aria-controls={props.ariaControls}
      onClick={props.onClick}
    >
      {props.busy ? <span className="tc-spinner" aria-hidden="true" /> : null}
      <span className="tc-btn-label">{props.children}</span>
    </button>
  );
}

/** A label with an optional "info" toggle revealing a paragraph — the original's (i) tooltips, readable by everyone. */
export function Field(props: {
  label: string;
  htmlFor?: string;
  info?: string;
  infoLabel?: string;
  trailing?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="tc-field" data-testid={props.testId}>
      <div className="tc-field-head">
        {props.htmlFor ? (
          <label className="tc-label" htmlFor={props.htmlFor}>
            {props.label}
          </label>
        ) : (
          <span className="tc-label">{props.label}</span>
        )}
        {props.info ? (
          <button
            type="button"
            className="tc-icon-btn"
            aria-label={props.infoLabel ?? props.label}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            <span aria-hidden="true">i</span>
          </button>
        ) : null}
        {props.trailing ? <span className="tc-field-trailing">{props.trailing}</span> : null}
      </div>
      {props.info && open ? (
        <p className="tc-info" id={id}>
          {props.info}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}

export function Input(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  testId?: string;
  describedBy?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      id={props.id}
      className={`tc-input${props.mono ? " tc-mono" : ""}`}
      value={props.value}
      placeholder={props.placeholder}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props.describedBy}
      data-testid={props.testId}
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      inputMode="text"
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function Checkbox(props: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <label className="tc-check" htmlFor={props.id}>
      <input id={props.id} type="checkbox" checked={props.checked} data-testid={props.testId} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

export function Card(props: { children: ReactNode; title?: string; testId?: string; className?: string }) {
  return (
    <section className={`tc-card${props.className ? ` ${props.className}` : ""}`} data-testid={props.testId}>
      {props.title ? <h2 className="tc-card-title">{props.title}</h2> : null}
      {props.children}
    </section>
  );
}

export function Notice(props: { tone: "info" | "warn" | "danger"; children: ReactNode; testId?: string; role?: "status" | "alert" }) {
  return (
    <div className={`tc-notice tc-notice-${props.tone}`} role={props.role ?? "status"} data-testid={props.testId}>
      {props.children}
    </div>
  );
}

export function Badge(props: { tone: "ok" | "warn" | "off" | "danger"; children: ReactNode; testId?: string }) {
  return (
    <span className={`tc-badge tc-badge-${props.tone}`} data-testid={props.testId}>
      {props.children}
    </span>
  );
}

/** A modal dialog: the focus moves in when it opens and back where it was when it closes; Escape closes it. */
export function Modal(props: { open: boolean; title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // the latest onClose, read by the one key listener (the effect itself runs on open and close only)
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div className="tc-modal-backdrop">
      <div className="tc-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} data-testid={props.testId}>
        <div className="tc-modal-head">
          <h2 className="tc-modal-title" id={titleId}>
            {props.title}
          </h2>
          <button
            type="button"
            className="tc-icon-btn"
            aria-label={t("common.close")}
            onClick={props.onClose}
            data-testid={props.testId ? `${props.testId}-close` : undefined}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** A key → value row (the original's "withdraw-data-item"). */
export function Row(props: { label: string; value: ReactNode; testId?: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={`tc-row${props.strong ? " tc-row-strong" : ""}${props.warn ? " tc-row-warn" : ""}`} data-testid={props.testId}>
      <span className="tc-row-label">{props.label}</span>
      <span className="tc-row-value">{props.value}</span>
    </div>
  );
}
