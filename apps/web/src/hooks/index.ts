// The React hooks over the engine's stores (V6 Stage 3; spec v2.0 §4): the engine modules expose subscribe / get and
// stable snapshots and import nothing from React, so they can live in packages/sdk; the screens read them through here.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { priceStore, type PriceState } from "@privacy-wallet/sdk/prices";
import { verifyStatus, type VerifyStatus } from "@privacy-wallet/sdk/verifiedReads";
import { addressBookOf, type AddressBookEntry } from "@privacy-wallet/sdk/wallet/addressBook";
import { campaignsSnapshot } from "@privacy-wallet/sdk/wallet/campaigns";
import type { Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { noteStore, type OwnedNote } from "@privacy-wallet/sdk/wallet/notes";
import { notifications, type WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import { poolStats, type PoolStats } from "@privacy-wallet/sdk/wallet/poolStats";
import { completeAction, isDue, pendingActions, schedulerStatus, type SchedulerStatus } from "@privacy-wallet/sdk/wallet/schedule";
import type { ScheduledAction } from "@privacy-wallet/sdk/wallet/journal";
import { session as defaultSession, type SessionState, type WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { settings, type Settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs, type Prefs } from "../storage/prefs";
import { operationsSnapshot, subscribeOperations } from "@privacy-wallet/sdk/operations/store";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { connection, type ConnectionState } from "@privacy-wallet/wallet-engine/connection";
import { postureFacts } from "@privacy-wallet/sdk/wallet/posture";
import { privacyPosture, type Posture } from "@privacy-wallet/protocol/wallet/privacyCenter";
import type { Deployment } from "@privacy-wallet/sdk/chain";

export const usePrices = (): PriceState =>
  useSyncExternalStore(
    (l) => priceStore.subscribe(l),
    () => priceStore.state(),
  );
export const useVerifyStatus = (): VerifyStatus =>
  useSyncExternalStore(
    (l) => verifyStatus.subscribe(l),
    () => verifyStatus.get(),
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
/** The notes of the session (re-renders on every change). */
export const useNotes = (): OwnedNote[] =>
  useSyncExternalStore(
    (l) => noteStore.subscribe(l),
    () => noteStore.all(),
  );
export const useNotifications = (): WalletNotification[] =>
  useSyncExternalStore(
    (l) => notifications.subscribe(l),
    () => notifications.all(),
  );
export const usePoolStats = (): PoolStats | null =>
  useSyncExternalStore(
    (l) => poolStats.subscribe(l),
    () => poolStats.get(),
  );
export const useSchedulerStatus = (): SchedulerStatus =>
  useSyncExternalStore(
    (l) => schedulerStatus.subscribe(l),
    () => schedulerStatus.get(),
  );
export const useSession = (): SessionState =>
  useSyncExternalStore(
    (l) => defaultSession.subscribe(l),
    () => defaultSession.state(),
  );
export const useSettings = (): Settings =>
  useSyncExternalStore(
    (l) => settings.subscribe(l),
    () => settings.get(),
  );
export const usePrefs = (): Prefs =>
  useSyncExternalStore(
    (l) => prefs().subscribe(l),
    () => prefs().get(),
    () => prefs().get(),
  );
export const useOperation = (id: string | null | undefined, s: WalletSession = defaultSession): OperationRecord | null =>
  useSyncExternalStore(
    (l) => subscribeOperations(l, s),
    () => (id ? (operationsSnapshot(s).all.find((r) => r.id === id) ?? null) : null),
  );
export const useOpenOperations = (s: WalletSession = defaultSession): OperationRecord[] =>
  useSyncExternalStore(
    (l) => subscribeOperations(l, s),
    () => operationsSnapshot(s).open,
  );
export const useAllOperations = (s: WalletSession = defaultSession): OperationRecord[] =>
  useSyncExternalStore(
    (l) => subscribeOperations(l, s),
    () => operationsSnapshot(s).all,
  );
export const useConnection = (): ConnectionState => useSyncExternalStore(connection.subscribe, connection.get, connection.get);
export const useAccount = (): string | null => useConnection().account;
/** The privacy posture from the live stores (re-renders when the pool stats or the settings change). */
export function usePosture(deployment: Deployment | null): Posture {
  const pool = usePoolStats();
  const s = useSettings();
  return privacyPosture(postureFacts(deployment, s, pool));
}

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
          if (!isDue(a) || !s.isUnlocked()) continue;
          // done unless the run re-scheduled the same action for later (a campaign tick plans its own next tick under its id)
          try {
            await run(a);
            const again = pendingActions(s).find((x) => x.id === a.id);
            if (again && again.dueAt === a.dueAt) completeAction(a.id, undefined, s);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            completeAction(a.id, message, s);
            schedulerStatus.failed(a.id, message);
          }
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [st.status, run, pollMs, s]);
}
