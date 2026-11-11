// Sheets and dialogs (spec §2, §3.9, §5): the bottom sheet that the back button closes, the dialog for a dangerous
// confirmation only, the confirmation sheet with a tap or a hold, and the hold button itself.
import { useLabels } from "../labels";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../cx";
import { Dialog } from "../primitives/Dialog";
import { Button, TextButton } from "./Button";

type SheetEntry = { dsSheet?: string; dsHandOver?: boolean };
const entryNow = (): SheetEntry | null => (history.state && typeof history.state === "object" ? (history.state as SheetEntry) : null);

/**
 * While a sheet is open the history holds one extra entry, so the browser's back button closes the sheet first (spec §2). A sheet that
 * closes while another opens in its place hands its entry over (`handOver`: the id of the sheet taking it, read as it closes; the twelfth
 * review round, B12-1): it goes back no more, and the one opening adopts the entry instead of pushing its own — a back() and a push in one
 * task had the traversal's popstate, which comes a task later, close the sheet just opened.
 */
export function useBackClose(open: boolean, onClose: () => void, id: string, handOver?: () => string | null): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const handOverRef = useRef(handOver);
  handOverRef.current = handOver;
  useEffect(() => {
    if (!open || typeof window === "undefined" || typeof history === "undefined") return;
    let pushed = true;
    const now = entryNow();
    // an entry handed to this sheet is its own now: the flag dropped, nothing pushed
    if (now?.dsSheet === id && now.dsHandOver === true) { const { dsHandOver: _flag, ...kept } = now; history.replaceState(kept, ""); }
    else history.pushState({ ...(now ?? {}), dsSheet: id }, "");
    const onPop = () => { pushed = false; closeRef.current(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const entry = entryNow();
      if (!pushed || entry?.dsSheet !== id) return;
      const to = handOverRef.current?.() ?? null;
      if (to !== null && to !== id) history.replaceState({ ...entry, dsSheet: to, dsHandOver: true }, "");
      else history.back();
    };
  }, [open, id]);
}

export function BottomSheet({ open, onClose, title, description, children, closeLabel, testId = "sheet", id = "sheet", handOver }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; closeLabel?: string; testId?: string; id?: string; /** the sheet that takes this one's history entry as it closes, if any (useBackClose) */ handOver?: () => string | null }) {
  useBackClose(open, onClose, id, handOver);
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={title} description={description} variant="sheet" closeLabel={closeLabel} testId={testId}>{children}</Dialog>;
}

export function Modal({ open, onClose, title, description, children, danger, closeLabel, testId = "modal" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; danger?: boolean; closeLabel?: string; testId?: string }) {
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={title} description={description} variant="center" danger={danger} closeLabel={closeLabel} testId={testId}>{children}</Dialog>;
}

/**
 * Hold to confirm (spec §3.9): a pointer hold of `holdMs` with a progress ring; releasing early cancels; Enter or Space
 * held works the same. V6 Stage 16 (spec v2.0 §18, doc §77): a reader who cannot hold — a switch, a screen reader's
 * double tap, a tremor — confirms through a dialog instead ("Confirm without holding" → the dialog's Confirm): the same
 * deliberate second step, never a single tap.
 */
export function HoldButton({ label, holdingLabel, hint, holdMs, onConfirm, disabled, testId = "hold-to-confirm" }: { label: string; holdingLabel?: string; hint?: string; holdMs: number; onConfirm: () => void; disabled?: boolean; testId?: string }) {
  const L = useLabels();
  const [asking, setAsking] = useState(false);
  const holding = holdingLabel ?? L.keepHolding;
  const hintText = hint ?? L.pressAndHold;
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = useRef(false);
  // whether the button can confirm right now, read at every tick (the eleventh review round's local run): a hold whose button turned disabled
  // midway had filled its ring and confirmed nothing, without a word — it is cancelled, the ring empty again, to be held once more
  const disabledNow = useRef(disabled);
  disabledNow.current = disabled;
  const stop = (reset = true) => { if (timer.current) clearInterval(timer.current); timer.current = null; start.current = null; if (reset) setProgress(0); };
  const begin = () => {
    if (disabled || start.current !== null) return;
    fired.current = false;
    start.current = Date.now();
    timer.current = setInterval(() => {
      if (disabledNow.current) return stop();
      const p = Math.min(1, (Date.now() - (start.current ?? Date.now())) / holdMs);
      setProgress(p);
      if (p >= 1 && !fired.current) { fired.current = true; stop(false); onConfirm(); }
    }, 16);
  };
  useEffect(() => () => stop(), []);
  useEffect(() => {
    if (disabled && timer.current) stop();
  }, [disabled]);
  const deg = Math.round(progress * 360);
  const holdingNow = progress > 0 && progress < 1;
  // The button keeps its size while holding: the full label stays in place (hidden) under the holding words. A label that
  // shrank under the pointer made the browser fire pointerleave and cancel the hold within a frame (the local-stack run
  // found it on the campaign Review's three-line label); the pointer is captured so a layout shift cannot end a hold.
  return (
    <div className="ds-hold-wrap">
    <button type="button" className={cx("ds-btn", "ds-btn-primary", "ds-btn-lg", "ds-btn-full", "ds-hold")} data-variant="primary" disabled={disabled} title={hintText} data-testid={testId} aria-label={`${label} (${hintText})`}
      onPointerDown={(e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a synthetic event without a pointer: nothing to capture */ } begin(); }} onPointerUp={() => stop()} onPointerLeave={() => stop()} onPointerCancel={() => stop()}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); begin(); } }} onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") stop(); }}>
      <span aria-hidden className="ds-hold-ring" style={{ background: `conic-gradient(var(--accent-fg) ${deg}deg, rgba(255, 255, 255, 0.3) ${deg}deg)` }} data-progress={progress.toFixed(2)} />
      <span className="ds-hold-labels">
        <span className={holdingNow ? "ds-hold-hidden" : undefined} aria-hidden={holdingNow || undefined}>{label}</span>
        {holdingNow ? <span className="ds-hold-overlay">{holding}</span> : null}
      </span>
    </button>
    <TextButton onClick={() => setAsking(true)} disabled={disabled} data-testid={`${testId}-alternative`}>{L.confirmWithoutHolding}</TextButton>
    <Modal open={asking} onClose={() => setAsking(false)} title={L.confirmDialogTitle} description={L.confirmDialogBody} testId={`${testId}-dialog`}>
      <div className="ds-hold-dialog-actions">
        <Button size="lg" full onClick={() => { setAsking(false); onConfirm(); }} disabled={disabled} data-testid={`${testId}-dialog-confirm`}>{L.confirm}</Button>
        <TextButton onClick={() => setAsking(false)} data-testid={`${testId}-dialog-cancel`}>{L.cancel}</TextButton>
      </div>
    </Modal>
    </div>
  );
}

/** The confirmation (spec §3.9): a summary, then a tap below the protected band and a hold from it; never both. */
export function ConfirmSheet({ open, onCancel, onConfirm, title, summary, mode, holdMs = 1500, confirmLabel, holdLabel, cancelLabel, disabledReason, testId = "confirm" }: { open: boolean; onCancel: () => void; onConfirm: () => void; title: string; summary: ReactNode; mode: "tap" | "hold"; holdMs?: number; confirmLabel?: string; holdLabel?: string; cancelLabel?: string; disabledReason?: string; testId?: string }) {
  const L = useLabels();
  return (
    <BottomSheet open={open} onClose={onCancel} title={title} testId={testId} id={testId}>
      <div data-testid={`${testId}-summary`}>{summary}</div>
      {disabledReason ? <p className="ds-field-error" role="status">{disabledReason}</p> : null}
      {mode === "hold"
        ? <HoldButton label={holdLabel ?? L.holdToConfirm} holdMs={holdMs} onConfirm={onConfirm} disabled={!!disabledReason} />
        : <Button size="lg" full onClick={onConfirm} disabled={!!disabledReason} data-testid="confirm-tap" icon="check">{confirmLabel ?? L.confirm}</Button>}
      <div className="ds-confirm-cancel"><TextButton onClick={onCancel} data-testid={`${testId}-cancel`}>{cancelLabel ?? L.cancel}</TextButton></div>
    </BottomSheet>
  );
}
