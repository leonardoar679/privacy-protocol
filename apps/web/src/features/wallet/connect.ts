// A connection made from any of the app's entry points — the picker's rows, Welcome's, Protect's and Settings' Connect, the pairing sheet's
// Try again — remembered by the connector it connected (`prefs.lastConnector`), so the next launch reconnects it without a prompt (the
// twelfth review round, B12-6: the picker alone had written it — a first launch's Connect was never remembered, and an older picker choice
// was reconnected after a reload instead of the wallet connected last). WalletConnect not (audit gap 112): its id is written, and the next
// launch, finding no session of its own in localStorage, forgets it (Providers' connectorAnsweredNothing).
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { prefs } from "../../storage/prefs";

/**
 * Connects the chosen connector — none chosen: the first wallet of this browser, WalletConnect when it is the only one —; a connection that holds (connected, or on the wrong
 * network) is remembered by the connector it connected. A cancelled or replaced connection resolves with its own start, never another
 * connection's state (`connection.connect`; the eleventh review round, slice 6c's second and third critiques: the picker had remembered a
 * WalletConnect it cancelled, five minutes later, over the browser wallet it connected, and closed on a retry the first pairing's expiry
 * did not concern): it is never remembered.
 */
export async function connectWith(id?: string): Promise<boolean> {
  const s = await connection.connect(id);
  const held = s.status === "connected" || s.status === "wrong-network";
  if (held && s.connector) prefs().update({ lastConnector: s.connector.id });
  return held;
}

/** The page loaded again — the way out the words name for an earlier WalletConnect end left or still under way (connectWords' reloadOffered). */
export function reloadPage(): void {
  window.location.reload();
}

/** Disconnects and forgets the connector: the next launch asks again. */
export function disconnectWallet(): void {
  connection.disconnect();
  prefs().update({ lastConnector: undefined });
}
