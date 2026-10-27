// The unload guard (V7 Stage 16, spec v3.0 §9): while a critical section holds the lock off — a wallet prompt, a proof, a
// submission, a hand-over —, closing or reloading the tab is confirmed by the browser's own dialog first (its words are
// the browser's; a page may not write them, and some mobile browsers show none — the pagehide rule covers those). Nothing
// else is guarded: a reload with nothing in progress is free, and a locked wallet has nothing in progress.
import { session } from "@privacy-wallet/sdk/wallet/session";

/** Whether leaving now would interrupt a critical section (the hold reasons the session keeps). */
export const leavingInterrupts = (): boolean => session.isUnlocked() && session.holds().length > 0;

/** Starts the guard for this page; returns the stop. */
export function startUnloadGuard(): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!leavingInterrupts()) return;
    e.preventDefault();
    e.returnValue = ""; // the legacy signal some browsers still read
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}
