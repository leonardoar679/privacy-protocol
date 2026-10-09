// Sheets and dialogs (spec §2, §3.9, §5): the bottom sheet that the back button closes, the dialog for a dangerous
// confirmation only, the confirmation sheet with a tap or a hold, and the hold button itself.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../cx";
import { Dialog } from "../primitives/Dialog";
import { Button } from "./Button";

/** While a sheet is open the history holds one extra entry, so the browser's back button closes the sheet first (spec §2). */
export function useBackClose(open: boolean, onClose: () => void, id: string): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || typeof window === "undefined" || typeof history === "undefined") return;
    let pushed = true;
    history.pushState({ ...(history.state && typeof history.state === "object" ? history.state : {}), dsSheet: id }, "");
    const onPop = () => { pushed = false; closeRef.current(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (pushed && history.state && typeof history.state === "object" && (history.state as { dsSheet?: string }).dsSheet === id) history.back();
    };
  }, [open, id]);
}

export function BottomSheet({ open, onClose, title, description, children, closeLabel, testId = "sheet", id = "sheet" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; closeLabel?: string; testId?: string; id?: string }) {
  useBackClose(open, onClose, id);
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={title} description={description} variant="sheet" closeLabel={closeLabel} testId={testId}>{children}</Dialog>;
}

export function Modal({ open, onClose, title, description, children, danger, closeLabel, testId = "modal" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; danger?: boolean; closeLabel?: string; testId?: string }) {
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={title} description={description} variant="center" danger={danger} closeLabel={closeLabel} testId={testId}>{children}</Dialog>;
}

/** Hold to confirm (spec §3.9): a pointer hold of `holdMs` with a progress ring; releasing early cancels; Enter or Space held works the same. */
export function HoldButton({ label, holdingLabel = "Keep holding…", hint = "Press and hold to confirm", holdMs, onConfirm, disabled, testId = "hold-to-confirm" }: { label: string; holdingLabel?: string; hint?: string; holdMs: number; onConfirm: () => void; disabled?: boolean; testId?: string }) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = useRef(false);
  const stop = (reset = true) => { if (timer.current) clearInterval(timer.current); timer.current = null; start.current = null; if (reset) setProgress(0); };
  const begin = () => {
    if (disabled || start.current !== null) return;
    fired.current = false;
    start.current = Date.now();
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - (start.current ?? Date.now())) / holdMs);
      setProgress(p);
      if (p >= 1 && !fired.current) { fired.current = true; stop(false); onConfirm(); }
    }, 16);
  };
  useEffect(() => () => stop(), []);
  const deg = Math.round(progress * 360);
  return (
    <button type="button" className={cx("ds-btn", "ds-btn-primary", "ds-btn-lg", "ds-btn-full", "ds-hold")} disabled={disabled} title={hint} data-testid={testId} aria-label={`${label} (${hint})`}
      onPointerDown={begin} onPointerUp={() => stop()} onPointerLeave={() => stop()} onPointerCancel={() => stop()}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); begin(); } }} onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") stop(); }}>
      <span aria-hidden className="ds-hold-ring" style={{ background: `conic-gradient(var(--accent-fg) ${deg}deg, rgba(255, 255, 255, 0.3) ${deg}deg)` }} data-progress={progress.toFixed(2)} />
      <span>{progress > 0 && progress < 1 ? holdingLabel : label}</span>
    </button>
  );
}

/** The confirmation (spec §3.9): a summary, then a tap below the protected band and a hold from it; never both. */
export function ConfirmSheet({ open, onCancel, onConfirm, title, summary, mode, holdMs = 1500, confirmLabel = "Confirm", holdLabel = "Hold to Confirm", cancelLabel = "Cancel", disabledReason, testId = "confirm" }: { open: boolean; onCancel: () => void; onConfirm: () => void; title: string; summary: ReactNode; mode: "tap" | "hold"; holdMs?: number; confirmLabel?: string; holdLabel?: string; cancelLabel?: string; disabledReason?: string; testId?: string }) {
  return (
    <BottomSheet open={open} onClose={onCancel} title={title} testId={testId} id={testId}>
      <div data-testid={`${testId}-summary`}>{summary}</div>
      {disabledReason ? <p className="ds-field-error" role="status">{disabledReason}</p> : null}
      {mode === "hold"
        ? <HoldButton label={holdLabel} holdMs={holdMs} onConfirm={onConfirm} disabled={!!disabledReason} />
        : <Button size="lg" full onClick={onConfirm} disabled={!!disabledReason} data-testid="confirm-tap" icon="check">{confirmLabel}</Button>}
      <Button variant="ghost" full onClick={onCancel} data-testid={`${testId}-cancel`}>{cancelLabel}</Button>
    </BottomSheet>
  );
}
