// The page's side of connectivity (spec v2.0 §7.11, §12.5; doc §75; V6 Stage 15): the browser's online and offline
// events feed the transport's connectivity state (packages/privacy-engine/src/transport/connectivity.ts), which the
// requests themselves also feed. Offline because requests stopped arriving (not the browser's own event), the services the
// wallet uses are asked every 10 s — the relayer it submits through, the swap service while a swap is under way, the
// deployment's RPC — so a paused
// spend learns the network is back. Back online, the scheduler is kicked at once: each runner reconciles before it sends.
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import { config } from "@privacy-wallet/sdk/config";
import { kickScheduler } from "@privacy-wallet/sdk/wallet/schedule";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

export const PROBE_MS = 10_000;

/** A swap's closed states (packages/sdk/src/swapFunding.ts CLOSED_STATES, kept out of this first-route module; a test holds them equal). */
export const SWAP_CLOSED_STATES = ["completed", "refunded", "abandoned", "lapsed"];

/**
 * A swap or a protected execution under way: the swap service is then a service this wallet uses (audit round 2, n21). A
 * wallet that never swapped had told the build's swap service, every 10 s while offline, that it was open and from where.
 */
function swapsUnderWay(): boolean {
  if (!session.isUnlocked()) return false;
  const j = session.journal();
  return j.swaps.some((s) => !SWAP_CLOSED_STATES.includes(s.state)) || (j.campaigns ?? []).some((c) => c.state !== "completed" && c.state !== "cancelled");
}

/**
 * One round of requests while offline for want of answers: any answer is the network back (the audit round of 2026-10-16,
 * c60). The build's default relayer alone was asked: while it was down and the user's own relayer, the swap service or the
 * connected wallet's submission was in use, a silent blip kept the wallet "offline" and its scheduler held — and a user
 * who chose another relayer still told the default one every 10 s that the wallet was open, and from where. Now the
 * relayer the user submits through (none when the connected wallet submits), the swap service and the deployment's RPC
 * are asked at once. The round ends when the next one starts, so a service that keeps the connection open without
 * answering never piles probes up; once one answers, the others are let go.
 */
export async function probe(): Promise<void> {
  const s = connectivity.get();
  if (s.online || s.cause !== "unreachable") return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("no answer before the next probe", "TimeoutError")), PROBE_MS);
  const c = config();
  const sub = settings.get().submission;
  const asks: Promise<unknown>[] = [];
  if (sub.kind === "relayer") asks.push(secureFetch(`${sub.url.replace(/\/$/, "")}/info`, { signal: ctl.signal }, "relayer"));
  if (c.swapService && swapsUnderWay()) asks.push(secureFetch(`${c.swapService.replace(/\/$/, "")}/v1/status`, { signal: ctl.signal }, "swap-service"));
  const rpc = c.deployment?.rpcUrls?.[0] ?? c.deployment?.rpcUrl;
  if (rpc) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    asks.push(secureFetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctl.signal }, "rpc"));
  }
  await Promise.any(asks).catch(() => {});
  clearTimeout(timer);
  ctl.abort(new DOMException("another service answered", "AbortError")); // a cancel, never counted toward offline
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
