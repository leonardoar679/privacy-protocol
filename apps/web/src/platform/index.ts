// The page's platform services (V6 Stage 15), started once by main.tsx after the engine is configured: the auto-lock,
// what a lock forgets, and the connectivity state. Tests start the one they exercise.
import { startAutoLock, wipeOnLock } from "./autoLock";
import { startConnectivity } from "./connectivity";
import { stopCryptoWorker } from "./crypto/client";
import { session } from "@privacy-wallet/sdk/wallet/session";

export function startPlatform(): () => void {
  // a lock also ends the crypto worker: the spend plans and the view key it held go with it (spec v2.0 §8)
  const stops = [wipeOnLock(), session.onLock(stopCryptoWorker), startAutoLock(), startConnectivity()];
  return () => {
    for (const s of stops) s();
  };
}
