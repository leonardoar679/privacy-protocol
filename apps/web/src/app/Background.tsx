// The background work of an unlocked wallet (moved from App.tsx unchanged): the scheduler runs a swap's funding at
// its drawn time and one campaign action per tick, maintenance is scheduled once the notes call for it, and the
// experience chosen at first launch is mirrored into the journal's `advanced` flag once per unlock. V6 Stage 11: a
// confirmed swap's order ticks (`order-tick`) go to the order runner. A V6 follow-up: every unlock looks for the
// wallet's notes in the pool (`discovery:pool`, which then repeats while unlocked).
import { useCallback, useEffect } from "react";
import { useDeployment } from "./deployment";
import { mirrorExperience } from "./Gate";
import { askPersistentStorage } from "../storage/persist";
import { runScheduledAction } from "@privacy-wallet/sdk/swapFunding";
import { runCampaignTick } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { runOrderTick } from "@privacy-wallet/sdk/wallet/orderRunner";
import { scheduleHousekeeping } from "@privacy-wallet/sdk/wallet/housekeeping";
import { discoveryWanted, runDiscovery, scheduleDiscovery } from "@privacy-wallet/sdk/wallet/discovery";
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
    // a tick writes only into the journal it began with (the sixth review round, 2026-11-03): locked or replaced meanwhile, its
    // late writes are refused instead of landing in the next wallet's journal
    const pinned = session.pinned();
    try {
      if (a.kind === "campaign-tick" || a.kind === "campaign-shape") await runCampaignTick(a, { masterSeed: seed, deployment, session: pinned });
      else if (a.kind === "order-tick") await runOrderTick(a, { masterSeed: seed, deployment, session: pinned });
      else if (a.kind === "discovery") await runDiscovery(a, { masterSeed: seed, deployment, session: pinned });
      else await runScheduledAction(a, { masterSeed: seed, deployment, session: pinned });
    } finally {
      session.safePoint(); // between two runner ticks: a lock past the hold cap happens here (V6 Stage 15)
    }
  }, [deployment]));
  useEffect(() => { if (s.status === "unlocked" && housekeeping.enabled && notes.length) scheduleHousekeeping(deployment); }, [s.status, housekeeping.enabled, notes, deployment]);
  useEffect(() => { if (s.status === "unlocked" && s.seed) mirrorExperience(); }, [s.status, s.seed]);
  // the notes in the pool after every unlock: a phrase restore, a transfer received, a refund (the scan repeats while
  // unlocked); a first launch stays request-free until the wallet holds something (spec v2.0 §10)
  useEffect(() => { if (s.status === "unlocked" && deployment && discoveryWanted()) scheduleDiscovery(); }, [s.status, deployment]);
  // V6 Stage 15 (doc §76): the five operation notifications while unlocked
  useEffect(() => (s.status === "unlocked" ? startOperationNotifications() : undefined), [s.status]);
  // V7 Stage 16 (spec v3.0 §9): the browser is asked once to keep this origin's storage (the journal, the keystore) out of its eviction
  useEffect(() => { if (s.status === "unlocked") void askPersistentStorage(); }, [s.status]);
  return null;
}
