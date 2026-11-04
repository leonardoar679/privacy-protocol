// The React hooks over the engine's stores (V6 Stage 3; spec v2.0 §4): the engine modules expose subscribe / get and
// stable snapshots and import nothing from React, so they can live in packages/sdk; the screens read them through here.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { verifyStatus, type VerifyStatus } from "@privacy-wallet/sdk/verifiedReads";
import { addressBookOf, type AddressBookEntry } from "@privacy-wallet/sdk/wallet/addressBook";
import { rememberedFingerprint } from "@privacy-wallet/sdk/deploymentGuard";
import { campaignsSnapshot } from "@privacy-wallet/sdk/wallet/campaigns";
import type { Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { completeAction, isDue, onSchedulerKick, pendingActions, schedulerStatus, type SchedulerStatus } from "@privacy-wallet/sdk/wallet/schedule";
import type { ScheduledAction } from "@privacy-wallet/sdk/wallet/journal";
import { session as defaultSession, type WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { useSession } from "./core";

// the light hooks (the first route uses them from ./core directly) and the data hooks that read no chain (Home)
export * from "./core";
export * from "./wallet";

export const useVerifyStatus = (): VerifyStatus =>
  useSyncExternalStore(
    (l) => verifyStatus.subscribe(l),
    () => verifyStatus.get(),
  );
/** V6 Stage 10 (doc §71): the deployment fingerprint this wallet remembered for a chain, or null. */
export const useDeploymentFingerprint = (chainId: number | null): string | null =>
  useSyncExternalStore(
    (l) => defaultSession.subscribe(l),
    () => (chainId === null ? null : rememberedFingerprint(chainId)),
  );
export const useAddressBook = (s: WalletSession = defaultSession): AddressBookEntry[] =>
  useSyncExternalStore(
    (l) => s.subscribe(l),
    () => addressBookOf(s),
  );
export const useCampaigns = (s: WalletSession = defaultSession): Campaign[] =>
  useSyncExternalStore(
    (l) => s.subscribe(l),
    () => campaignsSnapshot(s),
  );
export const useSchedulerStatus = (): SchedulerStatus =>
  useSyncExternalStore(
    (l) => schedulerStatus.subscribe(l),
    () => schedulerStatus.get(),
  );

/**
 * Runs due actions while the wallet is unlocked (checked every `pollMs`), one at a time: a tick that
 * finds the runner busy does nothing. `run` throws to fail an action (recorded with backoff) and may
 * cancel it itself when it no longer applies.
 */
export function useScheduler(run: (a: ScheduledAction) => Promise<void>, pollMs = 10_000, s: WalletSession = defaultSession): void {
  const st = useSession();
  const busy = useRef(false);
  useEffect(() => {
    if (st.status !== "unlocked") return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const a of pendingActions(s)) {
          // V6 Stage 15 (doc §75): nothing runs while offline — the action stays due, and back online each runner
          // reconciles before it sends
          if (!isDue(a) || !s.isUnlocked() || !connectivity.get().online) continue;
          // done unless the run re-scheduled the same action for later (a campaign tick plans its own next tick under its id)
          const epoch = s.epoch();
          try {
            await run(a);
            if (s.epoch() !== epoch) break; // locked or replaced during the run (the sixth review round): the next wallet's schedule is not this run's to mark
            const again = pendingActions(s).find((x) => x.id === a.id);
            if (again && again.dueAt === a.dueAt) completeAction(a.id, undefined, s);
          } catch (e) {
            if (s.epoch() !== epoch) break;
            const message = e instanceof Error ? e.message : String(e);
            completeAction(a.id, message, s, Date.now(), classify(e).code); // the code: the operation's detail names the failure (gap 59)
            schedulerStatus.failed(a.id, message);
          }
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    const unkick = onSchedulerKick(() => void tick()); // V6 Stage 11: an action due now runs at once (a confirmed swap)
    // V7 Stage 16 (spec v3.0 §9): a tab back in view, or back online, catches up at once — a phone throttles or freezes a
    // hidden tab's timers, so the poll may be long overdue
    const onCatchUp = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onCatchUp);
    window.addEventListener("online", onCatchUp);
    return () => {
      clearInterval(t);
      unkick();
      document.removeEventListener("visibilitychange", onCatchUp);
      window.removeEventListener("online", onCatchUp);
    };
  }, [st.status, run, pollMs, s]);
}
