// The page's platform services (V6 Stage 15), started once by main.tsx after the engine is configured: the auto-lock,
// the unload guard (V7 Stage 16), the connectivity state and one unlocked tab at a time (a V6 follow-up). What a lock forgets is registered by the
// modules that hold it. Tests start the one they exercise.
import { session } from "@privacy-wallet/sdk/wallet/session";
import { anotherTabHoldsWallet, startActiveTab } from "./activeTab";
import { cancelStepAside, stepAside, startAutoLock } from "./autoLock";
import { startConnectivity } from "./connectivity";
import { startUnloadGuard } from "./unloadGuard";
import { prefs } from "../storage/prefs";
import { wipePending } from "./pendingWipe";
import { secureStore } from "../storage/secureStore";

/** The platform's word on a REPLACE (the fourth review round, 2026-11-03): refused while another tab of this browser holds the wallet. */
export const replaceGuard = async (): Promise<string | null> =>
  (await anotherTabHoldsWallet()) ? "another tab of this browser holds the wallet: lock it there first" : null;

export function startPlatform(): () => void {
  session.setReplaceGuard(replaceGuard);
  // what an earlier page could not delete under its own connection (A11-3/H11-4), before anything loads WalletConnect again
  void wipePending().catch(() => undefined);
  const stops = [
    startAutoLock(),
    startConnectivity(),
    startUnloadGuard(),
    startActiveTab({ session, stepAside, cancelStepAside, refresh: () => prefs().reload(), flush: () => secureStore().flush() }),
  ];
  return () => {
    session.setReplaceGuard(null);
    for (const s of stops) s();
  };
}
