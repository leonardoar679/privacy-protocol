// The page's side of auto-lock (spec v2.0 §8; doc §18; V6 Stage 15): the engine's controller
// (packages/sdk/src/session/autoLock.ts) fed with this page's events. The events:
//   - a pointer, a key, a wheel, a touch or a scroll is activity (at most once a second);
//   - `visibilitychange` is the hidden clock;
//   - `pagehide` locks at once.
// Focus and blur are not listened to: losing focus to a wallet pop-up or the WalletConnect modal is idleness, nothing
// more. A lock — automatic or the Lock button — also forgets the runners' caches and the drafts; the crypto worker
// registers its own hook.
import { AutoLock, autoLockMinutesOf } from "@privacy-wallet/sdk/session/autoLock";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { resetRunnerMemory } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { resetOrderRunnerMemory } from "@privacy-wallet/sdk/wallet/orderRunner";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

/** The last lock was automatic: the unlock returns to the screen it interrupted (an explicit Lock opens Home). */
let automatic = false;
export const lockedAutomatically = (): boolean => automatic;

/** What a lock forgets besides the keys and the notes (the session clears those). */
export function wipeOnLock(): () => void {
  return session.onLock(() => {
    resetOperationsMemory();
    resetOrderRunnerMemory();
    resetRunnerMemory();
  });
}

/** Starts the auto-lock for this page; returns the stop. */
export function startAutoLock(): () => void {
  const offHook = session.onLock(() => {
    automatic = false; // every lock starts as explicit (the hooks run inside session.lock()); the controller marks its own right after
  });
  const ctrl = new AutoLock({
    session,
    minutes: () => autoLockMinutesOf(settings.get().autoLockMinutes),
    onLock: () => {
      automatic = true;
    },
  });
  const stopCtrl = ctrl.start();
  let last = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    ctrl.activity();
  };
  const onVisibility = () => ctrl.visibility(document.visibilityState === "hidden");
  const onPageHide = () => ctrl.pageHide();
  for (const e of ACTIVITY) window.addEventListener(e, onActivity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  if (document.visibilityState === "hidden") ctrl.visibility(true);
  return () => {
    offHook();
    stopCtrl();
    for (const e of ACTIVITY) window.removeEventListener(e, onActivity, { capture: true });
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  };
}
