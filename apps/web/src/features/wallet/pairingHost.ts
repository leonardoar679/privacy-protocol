// Where a WalletConnect pairing shows (the eleventh review round, slice 6c): in the connector picker while it is open, else in a sheet of its own
// from the app's root (routes/index.tsx) — one sheet at a time. A picker that goes away with a pairing still on (a lock) hands it to the root
// sheet without going back (useBackClose's handOver; the twelfth review round, B12-1): the closing sheet's back() and the opening one's push
// in one task had the traversal's popstate close the new sheet and cancel the pairing.
import { useSyncExternalStore } from "react";

let hosts = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export const pairingHost = {
  /** the picker is open: a pairing shows in it */
  hosted: (): boolean => hosts > 0,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** the picker takes the pairing while it is open; the function returned lets it go */
  hold(): () => void {
    hosts++;
    notify();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      hosts--;
      notify();
    };
  },
};

export const usePairingHosted = (): boolean => useSyncExternalStore(pairingHost.subscribe, pairingHost.hosted, pairingHost.hosted);
