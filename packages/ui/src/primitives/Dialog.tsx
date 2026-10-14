// The one place Radix's dialog is imported (spec §5): a centered dialog or a bottom sheet, titled, with an accessible
// description, focus trapped and restored, closed by Escape or the overlay. Props mention no Radix type.
import { useLabels } from "../labels";
import * as RD from "@radix-ui/react-dialog";
import { useRef, type ReactNode } from "react";
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

export function Dialog({ open, onOpenChange, title, description, children, variant = "center", danger, closeLabel, testId }: DialogProps) {
  const L = useLabels();
  // V6 Stage 16 (doc §77): the focus goes back to what had it when the dialog opened. Radix gives it to its own Trigger,
  // and these dialogs are opened by the screens' buttons (controlled), so without this it fell to the page's body.
  const restore = useRef<HTMLElement | null>(null);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="ds-overlay" />
        <RD.Content
          className={cx(variant === "sheet" ? "ds-sheet" : "ds-dialog")}
          data-testid={testId}
          data-danger={danger ? "" : undefined}
          data-variant={variant}
          onOpenAutoFocus={() => { restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const back = restore.current;
            restore.current = null;
            if (back?.isConnected) back.focus();
          }}
        >
          <div className="ds-dialog-head">
            <RD.Title className="ds-dialog-title">{title}</RD.Title>
            <RD.Close className="ds-icon-btn" aria-label={closeLabel ?? L.close}><Icon name="close" size={20} /></RD.Close>
          </div>
          <RD.Description className={description ? "ds-dialog-desc" : "sr-only"}>{description ?? title}</RD.Description>
          <div className="ds-dialog-body">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
