// The wallet's data hooks that read no chain (V6 Stage 16, spec v2.0 §19's budget): the notes, the prices' state, the
// operations, the pool's stats and the privacy posture — what Home renders from. ./index.ts re-exports them with the
// rest; Home imports them from here, so its chunk does not carry the chain client.
import { useSyncExternalStore } from "react";
import { priceState, type PriceState } from "@privacy-wallet/sdk/priceState";
import { noteStore, type OwnedNote } from "@privacy-wallet/sdk/wallet/notes";
import { poolStats, type PoolStats } from "@privacy-wallet/sdk/wallet/poolStats";
import { session as defaultSession, type WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { operationsSnapshot, subscribeOperations } from "@privacy-wallet/sdk/operations/store";
import { failedAttempt } from "@privacy-wallet/sdk/wallet/schedule";
import type { ScheduledAction } from "@privacy-wallet/sdk/wallet/journal";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { postureFacts } from "@privacy-wallet/sdk/wallet/posture";
import { privacyPosture, type Posture } from "@privacy-wallet/protocol/wallet/privacyCenter";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { useSettings } from "./core";

export const usePrices = (): PriceState =>
  useSyncExternalStore(
    (l) => priceState.subscribe(l),
    () => priceState.get(),
  );
/** The notes of the session (re-renders on every change). */
export const useNotes = (): OwnedNote[] =>
  useSyncExternalStore(
    (l) => noteStore.subscribe(l),
    () => noteStore.all(),
  );
export const usePoolStats = (): PoolStats | null =>
  useSyncExternalStore(
    (l) => poolStats.subscribe(l),
    () => poolStats.get(),
  );
export const useOperation = (id: string | null | undefined, s: WalletSession = defaultSession): OperationRecord | null =>
  useSyncExternalStore(
    (l) => subscribeOperations(l, s),
    () => (id ? (operationsSnapshot(s).all.find((r) => r.id === id) ?? null) : null),
  );
/** The scheduler's last failure for an operation (its order or campaign id), or null (a V7 follow-up, audit gap 59). */
export const useFailedAttempt = (orderId: string | null | undefined, s: WalletSession = defaultSession): ScheduledAction | null =>
  useSyncExternalStore(
    (l) => s.subscribe(l),
    () => (orderId ? failedAttempt(orderId, s) : null),
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
/** The privacy posture from the live stores (re-renders when the pool stats or the settings change). */
export function usePosture(deployment: Deployment | null): Posture {
  const pool = usePoolStats();
  const s = useSettings();
  return privacyPosture(postureFacts(deployment, s, pool));
}
