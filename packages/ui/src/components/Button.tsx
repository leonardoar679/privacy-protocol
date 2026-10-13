// The buttons (spec v2.0 §5; doc §10): three levels only — Primary (Protect Assets, Review Swap, Confirm), Secondary (View
// Details, Compare Routes, Advanced), Destructive (Cancel, Reset Wallet, Remove Data) — and a text button for navigation.
// At most one visible primary per screen; a destructive button never sits next to a confirmation (doc §57); every label
// fits on one line at 360 px and every target is at least 44 px.
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "lg";
  full?: boolean;
  loading?: boolean;
  icon?: IconName;
}

export function Button({ variant = "primary", size = "md", full, loading, icon, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("ds-btn", `ds-btn-${variant}`, `ds-btn-${size}`, full && "ds-btn-full", className)}
      data-variant={variant}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Icon name="spinner" size={18} className="ds-spin" /> : icon ? <Icon name={icon} size={20} /> : null}
      <span className="ds-btn-label">{children}</span>
    </button>
  );
}

/** Navigation and low-emphasis actions ("View details", "Edit", "Cancel" under a confirmation): text in the accent colour. */
export function TextButton({ icon, className, children, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName }) {
  return (
    <button type={type} className={cx("ds-text-btn", className)} data-variant="text" {...rest}>
      <span className="ds-btn-label">{children}</span>
      {icon ? <Icon name={icon} size={16} /> : null}
    </button>
  );
}

/** A text link to a route or a page (the same look as TextButton, a real anchor). */
export function TextLink({ icon, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { icon?: IconName }) {
  return (
    <a className={cx("ds-text-btn", className)} data-variant="text" {...rest}>
      <span className="ds-btn-label">{children}</span>
      {icon ? <Icon name={icon} size={16} /> : null}
    </a>
  );
}

/** An icon-only button: the label is its accessible name and its tooltip. */
export function IconButton({
  label,
  icon,
  className,
  size = 22,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label: string; icon: IconName; size?: number }) {
  return (
    <button type="button" className={cx("ds-icon-btn", className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}
