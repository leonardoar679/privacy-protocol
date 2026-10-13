// The background work of an unlocked wallet (moved from App.tsx unchanged): the scheduler runs a swap's funding at
// its drawn time and one campaign action per tick, maintenance is scheduled once the notes call for it, and the
// experience chosen at first launch is mirrored into the journal's `advanced` flag once per unlock.
import { useCallback, useEffect } from "react";
import { useDeployment } from "./deployment";
import { mirrorExperience } from "./Gate";
import { runScheduledAction } from "../sdk/swapFunding";
import { runCampaignTick } from "../wallet/campaignRunner";
import { scheduleHousekeeping } from "../wallet/housekeeping";
import { session } from "../wallet/session";
import { useNotes, useScheduler, useSession, useSettings } from "../hooks";

export function Background() {
  const deployment = useDeployment();
  const s = useSession();
  const { housekeeping } = useSettings();
  const notes = useNotes();
  useScheduler(useCallback(async (a) => {
    const seed = session.state().seed;
    if (!seed) return;
    if (a.kind === "campaign-tick" || a.kind === "campaign-shape") { await runCampaignTick(a, { masterSeed: seed, deployment }); return; }
    await runScheduledAction(a, { masterSeed: seed, deployment });
  }, [deployment]));
  useEffect(() => { if (s.status === "unlocked" && housekeeping.enabled && notes.length) scheduleHousekeeping(deployment); }, [s.status, housekeeping.enabled, notes, deployment]);
  useEffect(() => { if (s.status === "unlocked" && s.seed) mirrorExperience(); }, [s.status, s.seed]);
  return null;
}
