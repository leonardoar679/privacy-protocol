// The page's platform services (V6 Stage 15), started once by main.tsx after the engine is configured: the auto-lock,
// the connectivity state and one unlocked tab at a time (a V6 follow-up). What a lock forgets is registered by the
// modules that hold it. Tests start the one they exercise.
import { session } from "@privacy-wallet/sdk/wallet/session";
import { startActiveTab } from "./activeTab";
import { stepAside, startAutoLock } from "./autoLock";
import { startConnectivity } from "./connectivity";
import { prefs } from "../storage/prefs";
import { secureStore } from "../storage/secureStore";

export function startPlatform(): () => void {
  const stops = [
    startAutoLock(),
    startConnectivity(),
    startActiveTab({ session, stepAside, refresh: () => prefs().reload(), flush: () => secureStore().flush() }),
  ];
  return () => {
    for (const s of stops) s();
  };
}
