// The gate (spec §2): nothing renders before the device's store is read; a locked or absent wallet sees only the
// onboarding routes, an unlocked one only the shell; a freshly created wallet shows its recovery phrase before
// anything else, whatever the route. The redirects are declarative, so the browser's back button stays honest.
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Skeleton } from "../design-system";
import { prefs, usePrefs } from "../storage/prefs";
import { useSession, type SessionState } from "../wallet/session";
import { settings } from "../wallet/settings";
import { Phrase } from "../features/onboarding/Phrase";

export function Splash() {
  return <div className="ds-main" data-testid="splash" aria-busy="true"><Skeleton height={120} /></div>;
}

const unlocked = (s: SessionState) => s.status === "unlocked" && !!s.seed && !s.pendingPhrase;

/** Where a visitor without an unlocked wallet belongs. */
export function onboardingRoute(s: SessionState, firstLaunchDone: boolean): string {
  if (s.status === "locked") return "/unlock";
  return firstLaunchDone ? "/create" : "/welcome";
}

export function RequireUnlocked() {
  const s = useSession();
  const p = usePrefs();
  const location = useLocation();
  if (!s.ready) return <Splash />;
  if (s.pendingPhrase) return <Phrase phrase={s.pendingPhrase} />;
  if (!unlocked(s)) return <Navigate to={onboardingRoute(s, p.firstLaunchDone)} replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireLocked() {
  const s = useSession();
  if (!s.ready) return <Splash />;
  if (s.pendingPhrase) return <Phrase phrase={s.pendingPhrase} />;
  if (unlocked(s)) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** The seed of the unlocked wallet, for a screen under RequireUnlocked (it never renders otherwise). */
export function useUnlockedSeed(): Uint8Array {
  const s = useSession();
  if (!s.seed) throw new Error("wallet locked");
  return s.seed;
}

/** The experience the user chose at first launch or under More, mirrored into the journal's `advanced` flag at unlock. */
export function mirrorExperience(): void {
  const advanced = prefs().get().experience === "advanced";
  if (settings.get().advanced !== advanced) settings.set({ advanced }); // the session journals every settings change
}
