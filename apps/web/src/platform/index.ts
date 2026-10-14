// The page's platform services (V6 Stage 15), started once by main.tsx after the engine is configured: the auto-lock
// and the connectivity state (what a lock forgets is registered by the modules that hold it). Tests start the one they
// exercise.
import { startAutoLock } from "./autoLock";
import { startConnectivity } from "./connectivity";

export function startPlatform(): () => void {
  const stops = [startAutoLock(), startConnectivity()];
  return () => {
    for (const s of stops) s();
  };
}
