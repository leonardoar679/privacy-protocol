// Funding a committed swap order (spec v1.1 §5, §8; V2 Stage 4): the private withdrawal that pays the
// one-time escrow, run either by the user ("Fund now") or by the scheduler at the drawn time — from any
// tab, since the runner lives at the App level. Every check the Swap screen made stays here: the escrow
// is recomputed from the wallet's own factory and the journaled params before a single note is spent,
// and an order that is no longer open (abandoned, already funded) is never funded.
import type { Address } from "viem";
import type { Deployment } from "./chain";
import { privateWithdrawal, type Submitted } from "./privateTx";
import { assetsOf, type Asset } from "./assets";
import { OrderMismatch, predictEscrow } from "./swapGuard";
import { noteStore } from "../wallet/notes";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import type { ScheduledAction, StoredSwap } from "../wallet/journal";
import { activityId, updateActivity } from "../wallet/activity";
import { cancelAction, schedulerStatus } from "../wallet/schedule";
import { runHousekeepingStep } from "../wallet/housekeeping";

export const CLOSED_STATES = ["completed", "refunded", "abandoned"];
export const isOpenSwap = (s: Pick<StoredSwap, "state">): boolean => !CLOSED_STATES.includes(s.state);

/** The private asset a stored order was funded from (by the request's source asset). */
export function assetOfStored(deployment: Deployment | null, s: StoredSwap): Asset {
  const assets = assetsOf(deployment);
  const src = String((s.request as { from?: { asset?: string } } | undefined)?.from?.asset ?? "native");
  return assets.find((a) => (a.token ?? "native").toLowerCase() === src.toLowerCase()) ?? assets[0];
}

/** The factory every escrow is recomputed from: the wallet's own configuration, never the service's word. */
export function swapFactoryOf(deployment: Deployment | null): Address {
  if (!deployment?.swapFactory) throw new Error("No escrow factory configured (VITE_SWAP_FACTORY): this wallet cannot check the escrow address a swap service returns, so it does not commit or fund swap orders.");
  return deployment.swapFactory;
}

/** Patch a journaled order and mirror its state onto its Activity line. */
export function patchSwap(orderId: string, patch: Partial<StoredSwap>, s: WalletSession = defaultSession): void {
  s.update((j) => { const x = j.swaps.find((y) => y.orderId.toLowerCase() === orderId.toLowerCase()); if (x) Object.assign(x, patch); });
  if (patch.state) updateActivity(activityId("swap", orderId), { status: patch.state }, s);
}

/** Give up an order that was never funded: its scheduled funding is removed (never retried) and its line says so. */
export function abandonSwap(orderId: string, s: WalletSession = defaultSession): void {
  cancelAction(`fund-escrow:${orderId}`, s);
  patchSwap(orderId, { state: "abandoned" }, s);
}

export async function fundEscrow(o: { masterSeed: Uint8Array; deployment: Deployment | null; stored: StoredSwap; onStatus?: (line: string) => void; session?: WalletSession }): Promise<Submitted> {
  const s = o.session ?? defaultSession;
  const { stored } = o;
  if (!o.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  if (!isOpenSwap(stored)) throw new Error(`order ${stored.orderId.slice(0, 10)}… is ${stored.state}; it is not funded`);
  if (stored.fundedTx) throw new Error(`order ${stored.orderId.slice(0, 10)}… is already funded`);
  const a = assetOfStored(o.deployment, stored);
  const params = stored.params as { amount: string };
  const gross = BigInt(params.amount); // the withdrawal funds the whole order; the escrow pays the executor tip
  if (noteStore.balance(BigInt(a.vault)) < gross) throw new Error(`Not enough ${a.symbol} in your private balance for this order.`);
  // the money goes only to the escrow these params create under our factory (recomputed again here)
  const predicted = predictEscrow(swapFactoryOf(o.deployment), stored.params as Parameters<typeof predictEscrow>[1]);
  if (predicted.toLowerCase() !== String(stored.endpoint).toLowerCase()) throw new OrderMismatch("endpoint", `${stored.endpoint} is not the escrow these params create (${predicted})`);
  const w = await privateWithdrawal({ masterSeed: o.masterSeed, deployment: o.deployment, amount: gross, recipient: predicted, vault: a.vault, onStatus: o.onStatus, record: false, swap: { factory: swapFactoryOf(o.deployment), params: stored.params } }); // V5: the relayer sees the escrow and takes its minimum only
  patchSwap(stored.orderId, { fundedTx: w.txHash, state: "funded" }, s);
  return w;
}

/**
 * The scheduler's runner for a `fund-escrow` action: funds the order if it is still open and unfunded;
 * an order that was abandoned or funded by hand has its action cancelled instead of failing forever.
 */
export async function runScheduledAction(a: ScheduledAction, o: { masterSeed: Uint8Array; deployment: Deployment | null; session?: WalletSession }): Promise<void> {
  const s = o.session ?? defaultSession;
  if (a.kind === "housekeeping") {
    // private balance maintenance (plan V2 §73): one step per scheduled action; the step schedules the next under a new id
    if (!o.deployment) { cancelAction(a.id, s); return; }
    schedulerStatus.start(a.id, "Private balance maintenance: planning a step…");
    try { await runHousekeepingStep({ masterSeed: o.masterSeed, deployment: o.deployment, session: s, onStatus: (line) => schedulerStatus.progress(line) }); }
    finally { schedulerStatus.finish(); }
    return;
  }
  if (a.kind !== "fund-escrow") return; // a campaign tick is dispatched by the App to wallet/campaignRunner.ts
  const stored = s.journal().swaps.find((x) => x.orderId === a.orderId);
  if (!stored || stored.fundedTx || !isOpenSwap(stored) || stored.campaign) { cancelAction(a.id, s); return; } // a tranche is funded by its campaign, never here
  const asset = assetOfStored(o.deployment, stored);
  schedulerStatus.start(a.id, `Funding the scheduled swap (${asset.symbol}) from your private balance…`);
  try {
    await fundEscrow({ masterSeed: o.masterSeed, deployment: o.deployment, stored, session: s, onStatus: (line) => schedulerStatus.progress(line) });
  } finally {
    schedulerStatus.finish();
  }
}
