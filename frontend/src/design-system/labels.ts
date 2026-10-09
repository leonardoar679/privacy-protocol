// The design system's own words (spec §19; Stage 11): the labels its components show when a screen passes none — Back,
// Close, Cancel, Confirm, the hold-to-confirm words, Paste, Search, Max, the sheet titles, the fee summary's lines.
// English here; the application sets them from its catalog whenever the locale changes (app/Providers.tsx →
// setLabels), so the design system localizes without depending on the catalog. A screen can still pass its own.
import { useSyncExternalStore } from "react";

export interface Labels {
  back: string; close: string; cancel: string; confirm: string;
  holdToConfirm: string; keepHolding: string; pressAndHold: string;
  paste: string; search: string; max: string; commonSizes: string; addressBook: string; chooseAsset: string;
  totalFees: string; viewFeeDetails: string; compareRoutes: string;
  loading: string; notifications: string; mainNav: string;
}

export const DEFAULT_LABELS: Readonly<Labels> = Object.freeze({
  back: "Back", close: "Close", cancel: "Cancel", confirm: "Confirm",
  holdToConfirm: "Hold to Confirm", keepHolding: "Keep holding…", pressAndHold: "Press and hold to confirm",
  paste: "Paste", search: "Search", max: "Max", commonSizes: "Common sizes", addressBook: "Address book", chooseAsset: "Choose asset",
  totalFees: "Total fees", viewFeeDetails: "View fee details", compareRoutes: "Compare routes",
  loading: "Loading…", notifications: "Notifications", mainNav: "Main",
});

let current: Labels = { ...DEFAULT_LABELS };
const listeners = new Set<() => void>();

/** The words in force (outside React: the gallery, tests). */
export const labels = (): Labels => current;

/** Sets some or all of the words (the application, on every locale change); unchanged values cause no re-render. */
export function setLabels(patch: Partial<Labels>): void {
  const next = { ...current, ...patch };
  if ((Object.keys(next) as (keyof Labels)[]).every((k) => next[k] === current[k])) return;
  current = next;
  for (const l of listeners) l();
}

/** Tests: English again. */
export function resetLabels(): void { setLabels({ ...DEFAULT_LABELS }); }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The words in a component: re-renders when the application changes them. */
export const useLabels = (): Labels => useSyncExternalStore(subscribe, labels, labels);
