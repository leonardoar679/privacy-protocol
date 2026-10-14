// The background work of an unlocked wallet (moved from App.tsx unchanged): the scheduler runs a swap's funding at
// its drawn time and one campaign action per tick, maintenance is scheduled once the notes call for it, and the
// experience chosen at first launch is mirrored into the journal's `advanced` flag once per unlock. V6 Stage 11: a
// confirmed swap's order ticks (`order-tick`) go to the order runner.
import { useCallback, useEffect } from "react";
import { useDeployment } from "./deployment";
import { mirrorExperience } from "./Gate";
import { runScheduledAction } from "@privacy-wallet/sdk/swapFunding";
import { runCampaignTick } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { runOrderTick } from "@privacy-wallet/sdk/wallet/orderRunner";
import { scheduleHousekeeping } from "@privacy-wallet/sdk/wallet/housekeeping";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useNotes, useScheduler, useSession, useSettings } from "../hooks";
import { startOperationNotifications } from "./notifications";

export function Background() {
  const deployment = useDeployment();
  const s = useSession();
  const { housekeeping } = useSettings();
  const notes = useNotes();
  useScheduler(useCallback(async (a) => {
    const seed = session.state().seed;
    if (!seed) return;
    try {
      if (a.kind === "campaign-tick" || a.kind === "campaign-shape") await runCampaignTick(a, { masterSeed: seed, deployment });
      else if (a.kind === "order-tick") await runOrderTick(a, { masterSeed: seed, deployment });
      else await runScheduledAction(a, { masterSeed: seed, deployment });
    } finally {
      session.safePoint(); // between two runner ticks: a lock past the hold cap happens here (V6 Stage 15)
    }
  }, [deployment]));
  useEffect(() => { if (s.status === "unlocked" && housekeeping.enabled && notes.length) scheduleHousekeeping(deployment); }, [s.status, housekeeping.enabled, notes, deployment]);
  useEffect(() => { if (s.status === "unlocked" && s.seed) mirrorExperience(); }, [s.status, s.seed]);
  // V6 Stage 15 (doc §76): the five operation notifications while unlocked
  useEffect(() => (s.status === "unlocked" ? startOperationNotifications() : undefined), [s.status]);
  return null;
}
