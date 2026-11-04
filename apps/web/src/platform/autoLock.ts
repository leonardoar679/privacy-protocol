// The page's side of auto-lock (spec v2.0 §8; doc §18; V6 Stage 15): the engine's controller
// (packages/sdk/src/session/autoLock.ts) fed with this page's events. The events:
//   - a pointer, a key, a wheel or a touch is activity (at most once a second) — never a scroll, which the wallet's own updates cause
//     (Chrome scrolls to anchor the page as content above it grows: a trusted event, nobody at the machine; the eleventh review round, H11-8);
//   - a focus or a resume only checks the deadline (a suspend with the page visible ran no timer), never counts as activity;
//   - `visibilitychange` is the hidden clock;
//   - `pagehide` locks at once — unless a hold is live (a wallet prompt, a proof, a submission: a phone's wallet handoff fires
//     it mid-prompt), then at the release; `pageshow` before that resumes (V7 Stage 16, spec v3.0 §9);
//   - another tab of this wallet unlocked (./activeTab.ts): `stepAside`, as soon as nothing is in progress; `cancelStepAside` when that tab
//     no longer waits.
// Blur is not listened to: losing focus to a wallet pop-up or the WalletConnect modal is idleness, nothing more. A lock — automatic or the Lock button — also forgets the runners' caches, the drafts and the crypto worker:
// each of those modules registers its own hook when it loads (V6 Stage 16: so the first route does not load them).
import { AutoLock, autoLockMinutesOf, type LockTrigger } from "@privacy-wallet/sdk/session/autoLock";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** The last lock was automatic: the unlock returns to the screen it interrupted (an explicit Lock opens Home). */
let automatic = false;
export const lockedAutomatically = (): boolean => automatic;
/** Why the last automatic lock happened (null after an explicit Lock). */
let lastTrigger: LockTrigger | null = null;
/** The last lock happened because the wallet was unlocked in another tab: the lock screen says so. */
export const lockedElsewhere = (): boolean => lastTrigger === "elsewhere";
let controller: AutoLock | null = null;
/** Another tab of this wallet was unlocked: this one locks as soon as nothing is in progress (./activeTab.ts). */
export const stepAside = (): void => controller?.stepAside();
/** The tab that asked no longer waits (./activeTab.ts, H11-3): this one stays. */
export const cancelStepAside = (): void => controller?.cancelStepAside();

/** Starts the auto-lock for this page; returns the stop. */
export function startAutoLock(): () => void {
  const offHook = session.onLock(() => {
    automatic = false; // every lock starts as explicit (the hooks run inside session.lock()); the controller marks its own right after
    lastTrigger = null;
  });
  const ctrl = new AutoLock({
    session,
    minutes: () => autoLockMinutesOf(settings.get().autoLockMinutes),
    onLock: (trigger) => {
      automatic = true;
      lastTrigger = trigger;
    },
  });
  controller = ctrl;
  const stopCtrl = ctrl.start();
  let last = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    ctrl.activity();
  };
  const onCheck = () => ctrl.check();
  const onVisibility = () => ctrl.visibility(document.visibilityState === "hidden");
  const onPageHide = () => ctrl.pageHide();
  const onPageShow = () => ctrl.pageShow();
  for (const e of ACTIVITY) window.addEventListener(e, onActivity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onCheck);
  document.addEventListener("resume", onCheck);
  if (document.visibilityState === "hidden") ctrl.visibility(true);
  return () => {
    offHook();
    stopCtrl();
    if (controller === ctrl) controller = null;
    for (const e of ACTIVITY) window.removeEventListener(e, onActivity, { capture: true });
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("focus", onCheck);
    document.removeEventListener("resume", onCheck);
  };
}
