// The gate (spec §2): nothing renders before the device's store is read; a locked or absent wallet sees only the
// onboarding routes, an unlocked one only the shell; a freshly created wallet shows its recovery phrase before
// anything else, whatever the route. The redirects are declarative, so the browser's back button stays honest. One
// unlocked tab at a time (a V6 follow-up, ../platform/activeTab.ts): while another tab holds the wallet, this one waits
// and says why; nothing behind the gate (the scheduler included) runs here meanwhile.
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Card, Page, Skeleton, TextButton } from "@privacy-wallet/ui";
import { prefs } from "../storage/prefs";
import { session, type SessionState } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { Phrase } from "../features/onboarding/Phrase";
import { usePrefs, useSession } from "../hooks/core";
import { lockedAutomatically } from "../platform/autoLock";
import { useActiveTab } from "../platform/activeTab";
import { useT } from "./i18n/useT";

export function Splash() {
  return <main className="ds-main" data-testid="splash" aria-busy="true"><Skeleton height={120} /></main>;
}

const unlocked = (s: SessionState) => s.status === "unlocked" && !!s.seed && !s.pendingPhrase;

/** The wallet is unlocked in another tab: this one waits until that one locks (as soon as nothing is in progress there). */
export function OtherTab() {
  const t = useT();
  return (
    <main className="ds-main">
      <Page title={t("tab.waitingTitle")} testId="other-tab">
        <Card padding="lg">
          <p>{t("tab.waitingBody")}</p>
          <TextButton onClick={() => session.lock()} data-testid="other-tab-lock">
            {t("tab.lockHere")}
          </TextButton>
        </Card>
      </Page>
    </main>
  );
}

/** Where a visitor without an unlocked wallet belongs. */
export function onboardingRoute(s: SessionState, firstLaunchDone: boolean): string {
  if (s.status === "locked") return "/unlock";
  return firstLaunchDone ? "/create" : "/welcome";
}

export function RequireUnlocked() {
  const s = useSession();
  const p = usePrefs();
  const tab = useActiveTab();
  const location = useLocation();
  if (!s.ready) return <Splash />;
  if (s.pendingPhrase) return <Phrase phrase={s.pendingPhrase} />;
  if (!unlocked(s)) return <Navigate to={onboardingRoute(s, p.firstLaunchDone)} replace state={{ from: location.pathname }} />;
  if (tab === "checking") return <Splash />;
  if (tab === "waiting") return <OtherTab />;
  return <Outlet />;
}

/** Where an unlock returns to: the screen the lock interrupted (an in-app path only), else Home. */
export const returnPath = (state: unknown): string => {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !["/unlock", "/welcome", "/create", "/restore"].includes(from) ? from : "/";
};

export function RequireLocked() {
  const s = useSession();
  const location = useLocation();
  if (!s.ready) return <Splash />;
  if (s.pendingPhrase) return <Phrase phrase={s.pendingPhrase} />;
  // V6 Stage 15 (spec v2.0 §8): after an automatic lock the unlock goes back to the screen it interrupted; after the
  // Lock button, Home
  if (unlocked(s)) return <Navigate to={lockedAutomatically() ? returnPath(location.state) : "/"} replace />;
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
