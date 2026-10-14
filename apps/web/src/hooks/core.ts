// The light hooks (V6 Stage 16, spec v2.0 §19's budget): what the first route needs — the session, the settings, the
// device's preferences, the wallet connection and the connectivity state — and nothing that reads the chain. The gate,
// the onboarding screens and the providers import these from here, so the first route does not carry the engine;
// ./index.ts re-exports them with the rest.
import { useSyncExternalStore } from "react";
import { session as defaultSession, type SessionState } from "@privacy-wallet/sdk/wallet/session";
import { settings, type Settings } from "@privacy-wallet/sdk/wallet/settings";
import { connection, type ConnectionState } from "@privacy-wallet/wallet-engine/connection";
import { connectivity, type ConnectivityState } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { notifications, type WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import { prefs, type Prefs } from "../storage/prefs";

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
export const useConnection = (): ConnectionState => useSyncExternalStore(connection.subscribe, connection.get, connection.get);
export const useAccount = (): string | null => useConnection().account;
/** V6 Stage 15 (doc §75): online, or offline and why. */
export const useConnectivity = (): ConnectivityState =>
  useSyncExternalStore(
    (l) => connectivity.subscribe(l),
    () => connectivity.get(),
  );
export const useNotifications = (): WalletNotification[] =>
  useSyncExternalStore(
    (l) => notifications.subscribe(l),
    () => notifications.all(),
  );
