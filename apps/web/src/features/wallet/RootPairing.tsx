// A WalletConnect connection the connector picker does not show (the eleventh review round, slice 6c): one that Welcome's or Protect's
// Connect started, WalletConnect the browser's only connector — in a sheet of its own from the app's root, whatever the route, never while
// the picker is open (pairingHost; the picker closed while WalletConnect loads cancels it). From its start — the library's wait (the third
// critique: a failure before any link had shown nothing) — through the pairing and what follows — a failure in the wallet's words with Try
// again (Reload beside it, or in its place, where the words name a reload: PairingSheet), the retry's wait — until it connects or is closed
// (the second critique: Welcome and Protect show no connection failure, and the
// sheet had simply gone; one sheet mounted throughout, since a sheet closing while another opens would fight over the back button's history
// entry).
import { lazy, Suspense, useState } from "react";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { useConnection } from "../../hooks/core";
import { usePairingHosted } from "./pairingHost";

const PairingSheet = lazy(() => import("./PairingSheet"));

export function RootPairing() {
  const conn = useConnection();
  const hosted = usePairingHosted();
  const [showed, setShowed] = useState(false);
  const failure = conn.pairing === null && conn.status === "disconnected" ? conn.error : null;
  const starting = conn.status === "connecting" && conn.pending?.kind === "walletconnect";
  const after = showed && failure !== null; // a retry's wait is a WalletConnect connection's start again (`starting`)
  const showing = !hosted && (conn.pairing !== null || starting || after);
  // what the sheet showed, kept as it renders (React's state from the previous render): an effect could run after a failure that came
  // right after the start, which then showed nothing
  if (showing !== showed) setShowed(showing);
  if (!showing) return null;
  const close = () => {
    // closed over a wait (a start's or a retry's) or a pairing: the connection is cancelled; over a failure: the failure dismissed
    if (conn.pairing !== null || conn.status === "connecting") connection.cancel();
    else connection.dismissError();
    setShowed(false);
  };
  return (
    <Suspense fallback={null}>
      <PairingSheet uri={conn.pairing} failure={failure} onClose={close} />
    </Suspense>
  );
}
