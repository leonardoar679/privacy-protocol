// The Classic app's routes (spec v3.0 §2, §7.8): /classic (the deposit tab), /classic/deposit, /classic/withdraw,
// /classic/history, /classic/settings — the original's one page with its two tabs, each tab addressable as the owner's
// document asks. A tiny history-API router: no dependency, no query string, no fragment (nothing of a note or a
// recipient ever reaches a URL).
import { useEffect, useState } from "react";
import { config } from "../config";

export type Route = "deposit" | "withdraw" | "history" | "settings";
export const ROUTES: readonly Route[] = ["deposit", "withdraw", "history", "settings"];

/** The route of a path under the app's base ("/classic/"): the base alone is the deposit tab; anything else is too. */
export function routeOf(pathname: string, base = config().base): Route {
  const rel = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\/+/, "");
  const seg = rel.replace(/^\/+|\/+$/g, "").split("/")[0];
  return (ROUTES as readonly string[]).includes(seg) ? (seg as Route) : "deposit";
}

/** The path of a route under the base. */
export const pathOf = (route: Route, base = config().base): string => `${base}${route}`;

// the current route, read from the location once and then kept by navigate() and the back button
let current: Route | null = null;
const read = (): Route => (current ??= typeof window === "undefined" ? "deposit" : routeOf(window.location.pathname));
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    current = routeOf(window.location.pathname);
    notify();
  });

export function navigate(route: Route, replace = false): void {
  current = route;
  if (typeof window !== "undefined") {
    const path = pathOf(route);
    if (window.location.pathname !== path) {
      if (replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
  }
  notify();
}

/** The tests' reset: forget the route (the next read takes it from the location) or set it. */
export function resetRoute(route: Route | null = null): void {
  current = route;
}

/** The current route, kept in step with the history. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    listeners.add(on);
    on();
    return () => {
      listeners.delete(on);
    };
  }, []);
  return route;
}
