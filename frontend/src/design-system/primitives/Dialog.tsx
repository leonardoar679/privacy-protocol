// The one place Radix's dialog is imported (spec §5): a centered dialog or a bottom sheet, titled, with an accessible
// description, focus trapped and restored, closed by Escape or the overlay. Props mention no Radix type.
import * as RD from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon } from "../icons";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** read to assistive technology beneath the title; the title alone when absent */
  description?: string;
  children: ReactNode;
  variant?: "center" | "sheet";
  /** a dangerous confirmation (forget, replace, protection off): a visible border, never the default action */
  danger?: boolean;
  closeLabel?: string;
  testId?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, variant = "center", danger, closeLabel = "Close", testId }: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="ds-overlay" />
        <RD.Content className={cx(variant === "sheet" ? "ds-sheet" : "ds-dialog")} data-testid={testId} data-danger={danger ? "" : undefined} data-variant={variant}>
          <div className="ds-dialog-head">
            <RD.Title className="ds-dialog-title">{title}</RD.Title>
            <RD.Close className="ds-icon-btn" aria-label={closeLabel}><Icon name="close" size={20} /></RD.Close>
          </div>
          <RD.Description className={description ? "ds-dialog-desc" : "sr-only"}>{description ?? title}</RD.Description>
          <div className="ds-dialog-body">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
