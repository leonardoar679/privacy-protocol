// A media query as React state (the shell's breakpoint, spec v2.0 §6): true while the query matches, updated when the
// window crosses it; false without a window (and in a test environment that has no layout).
import { useCallback, useSyncExternalStore } from "react";

const matches = (query: string): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener?.("change", onChange);
      return () => m.removeEventListener?.("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}
