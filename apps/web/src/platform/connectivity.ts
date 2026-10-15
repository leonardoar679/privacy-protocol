// The page's side of connectivity (spec v2.0 §7.11, §12.5; doc §75; V6 Stage 15): the browser's online and offline
// events feed the transport's connectivity state (packages/privacy-engine/src/transport/connectivity.ts), which the
// requests themselves also feed. Offline because requests stopped arriving (not the browser's own event), the relayer's
// /info is asked every 10 s, so a paused spend learns the network is back. Back online, the scheduler is kicked at once:
// each runner reconciles before it sends.
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import { config } from "@privacy-wallet/sdk/config";
import { kickScheduler } from "@privacy-wallet/sdk/wallet/schedule";

export const PROBE_MS = 10_000;

/**
 * One request to the relayer while offline for want of answers: any answer is the network back. It ends when the next one
 * starts, so a relayer that keeps the connection open without answering never piles probes up.
 */
export async function probe(): Promise<void> {
  const s = connectivity.get();
  if (s.online || s.cause !== "unreachable") return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("no answer before the next probe", "TimeoutError")), PROBE_MS);
  await secureFetch(`${config().relayer.url.replace(/\/$/, "")}/info`, { signal: ctl.signal }, "relayer")
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

export function startConnectivity(): () => void {
  const onOnline = () => connectivity.browser(true);
  const onOffline = () => connectivity.browser(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  if (typeof navigator !== "undefined" && navigator.onLine === false) connectivity.browser(false);
  let wasOnline = connectivity.get().online;
  const off = connectivity.subscribe(() => {
    const online = connectivity.get().online;
    if (online && !wasOnline) kickScheduler();
    wasOnline = online;
  });
  const timer = setInterval(() => void probe(), PROBE_MS);
  return () => {
    clearInterval(timer);
    off();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
