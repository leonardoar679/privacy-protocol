// The primary action stays visible (spec v2.0 §5; doc §56): it sticks to the bottom of the screen above the bottom bar,
// scrolls into view when an input takes focus, and rises above the on-screen keyboard — the keyboard's height is read
// from `visualViewport` into --keyboard-inset, and the action sits at whichever is higher, the bar or the keyboard.
import { useEffect, useRef, type ReactNode } from "react";

const typing = (el: Element | null): boolean => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);

export function StickyAction({ children, testId = "sticky-action" }: { children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const vv = window.visualViewport;
    const update = () => {
      const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      el.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    };
    const onFocus = (e: FocusEvent) => {
      if (!typing(e.target as Element | null)) return;
      // after the keyboard has opened and the viewport has resized
      setTimeout(() => {
        update();
        el.scrollIntoView?.({ block: "nearest" });
      }, 50);
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", onFocus);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return (
    <div ref={ref} className="ds-sticky-action" data-testid={testId}>
      {children}
    </div>
  );
}
