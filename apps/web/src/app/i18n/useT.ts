import { useCallback, useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, t, type MessageKey, type Vars } from "./messages";

/** The catalog in a component: re-renders when the locale changes. */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return useCallback((key: MessageKey, vars?: Vars) => t(key, vars, locale), [locale]);
}
