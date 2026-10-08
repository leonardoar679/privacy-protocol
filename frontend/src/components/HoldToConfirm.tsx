import { useEffect, useRef, useState } from "react";
import { HOLD_MS } from "../sdk/tiers";

// Hold to confirm (whale spec §24, plan V2 §12): a pointer hold of HOLD_MS with a visible progress ring;
// releasing early cancels; a tap is never enough. The keyboard equivalent is holding Enter or Space on the
// button for the same time. Fires once per completed hold.
export function HoldToConfirm({ label, onConfirm, disabled, holdMs = HOLD_MS, title }: { label: string; onConfirm: () => void; disabled?: boolean; holdMs?: number; title?: string }) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = useRef(false);

  const stop = (reset = true) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null; start.current = null;
    if (reset) setProgress(0);
  };
  const begin = () => {
    if (disabled || start.current !== null) return;
    fired.current = false;
    start.current = Date.now();
    timer.current = setInterval(() => {
      const elapsed = Date.now() - (start.current ?? Date.now());
      const p = Math.min(1, elapsed / holdMs);
      setProgress(p);
      if (p >= 1 && !fired.current) { fired.current = true; stop(false); onConfirm(); }
    }, 16);
  };
  useEffect(() => () => stop(), []);

  const deg = Math.round(progress * 360);
  return (
    <button
      className="primary hold" disabled={disabled} title={title ?? "Press and hold to confirm"} data-testid="hold-to-confirm" aria-label={`${label} (press and hold)`}
      onPointerDown={begin} onPointerUp={() => stop()} onPointerLeave={() => stop()} onPointerCancel={() => stop()}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); begin(); } }} onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") stop(); }}
      style={{ display: "inline-flex", alignItems: "center", gap: 10, width: "100%", justifyContent: "center" }}
    >
      <span aria-hidden style={{ width: 22, height: 22, borderRadius: "50%", background: `conic-gradient(var(--accent-fg) ${deg}deg, rgba(255,255,255,0.3) ${deg}deg)`, flex: "0 0 22px" }} data-progress={progress.toFixed(2)} />
      {progress > 0 && progress < 1 ? "Keep holding…" : label}
    </button>
  );
}
