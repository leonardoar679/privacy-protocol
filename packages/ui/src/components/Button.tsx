import type { ButtonHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  full?: boolean;
  loading?: boolean;
  icon?: IconName;
}

/** The button (spec §5): one primary per screen, 44 px tall, a spinner while busy. */
export function Button({ variant = "primary", size = "md", full, loading, icon, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx("ds-btn", `ds-btn-${variant}`, `ds-btn-${size}`, full && "ds-btn-full", className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Icon name="spinner" size={18} className="ds-spin" /> : icon ? <Icon name={icon} size={20} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** An icon-only button: the label is its accessible name and its tooltip. */
export function IconButton({ label, icon, className, size = 22, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label: string; icon: IconName; size?: number }) {
  return (
    <button type="button" className={cx("ds-icon-btn", className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}
