// The wallet's side of the swap provider facade (Privacy Wallet Web spec v3.0 §5; doc §7; V7 Stage 14): one interface over
// what exists. getQuote is the service's competition (POST /v1/quotes); prepare is the two-phase commit — the order
// committed and journaled (swapExecute.commitOrder through the order runner's confirmOrder, which schedules the funding),
// then the provider call read once (POST /v1/operations/:id/prepare), so the prepared swap carries the order, the one-time
// escrow and the call; validate runs IN THE WALLET (swapSign.checkBeforeSigning: the escrow recomputed from the journal and
// this wallet's factory, swapGuard.checkPrepared, providerCall.checkProviderCall, the approved minimum) — the simulation on
// every endpoint happens where the signature is made (swapExecute.prepareAndSign; it needs the signed call); getStatus reads
// the operation by its id (orderTracker.trackOrder, the API's reconcile) and never moves funds; getRecoveryOptions is a pure
// function over the record, the settlement and the pause: the owner's five options, each with the funds class it applies to.
// Authorization is separate from submission: Confirm commits; the runner funds, signs and hands over.
import type { Address } from "viem";
import type { LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { RecoveryOption, SwapProvider } from "@privacy-wallet/protocol/wallet/swapProvider";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { TERMINAL_STATES, type FundsClass, type OperationState, type SettlementState } from "@privacy-wallet/protocol-types";
import type { Asset } from "./assets";
import type { Deployment } from "./chain";
import { getOperation } from "./operations/store";
import { swapRecordId } from "./operations/swapRecords";
import { trackOrder, type Tracked } from "./orderTracker";
import type { CheckedCall } from "./providerCall";
import type { SwapJob } from "./relayer";
import type { Committed } from "./swapExecute";
import { CLOSED_STATES, swapFactoryOf } from "./swapFunding";
import { agreedUsd } from "./prices";
import { swapService, type Policy, type Preference, type Prepared, type QuoteSet, type ServiceOrder, type ServiceQuote, type SwapRequest } from "./swapService";
import { checkBeforeSigning, type JournaledOrder } from "./swapSign";
import type { StoredSwap } from "./wallet/journal";
import type { OperationRecord } from "./wallet/operationRecord";
import { confirmOrder } from "./wallet/orderRunner";
import { session as defaultSession, type WalletSession } from "./wallet/session";

export type { RecoveryOption, RecoveryOptionKind, SwapProvider } from "@privacy-wallet/protocol/wallet/swapProvider";

/** The quote the wallet prepares from: the request as sent, the service's set, the chosen route's quote and the §46 quote. */
export interface SwapQuote {
  request: SwapRequest;
  set: QuoteSet;
  chosen: ServiceQuote | null;
  quote: QuoteSet["quote"] | null;
}
/** What the commit needs beside the quote (the Review's facts). */
export interface PrepareOptions {
  policy: Policy;
  preference: Preference;
  fromAsset: Asset;
  /** this wallet's own tier of the order (null without a price) */
  walletTier: Tier | null;
  /** the route to commit; absent: the set's chosen one */
  provider?: string;
  lint?: LintItem[] | null;
  /** V6 Stage 12: into the protected balance — the shield tip and the fallback address */
  shield?: { shieldTip: bigint; fallbackRecipient: Address };
  /** the relayer's fee the Review showed: the funding never pays more (c46) */
  reviewedFee?: bigint;
  /** each merge the funding needs first pays at most this: the Review's F (the review round of 2026-11-03, E3) */
  reviewedMergeFee?: bigint;
  /** the executor tip the Review showed: the order is built on it, one above it refused (the seventh review round) */
  shownTip?: bigint;
  /** "Delay for more privacy": the funding at a random time, or at once from older notes (maxTiming) */
  delay?: boolean;
  maxTiming?: number;
  now?: number;
  /** read the provider call once with the commit (default); false leaves it to the runner, which reads its own at funding and at signing */
  withCall?: boolean;
}
/** The committed order, its escrow and the provider call as first prepared (null when the provider could not answer yet). */
export interface PreparedSwap {
  operationId: string | null;
  orderId: string;
  order: ServiceOrder;
  escrow: Address;
  stored: StoredSwap;
  call: Prepared | null;
  committed: Committed;
}
const CHECKS = ["order", "escrow", "call", "minimum"] as const;
export type ValidationResult =
  | { ok: true; escrow: Address; call: CheckedCall; checks: typeof CHECKS }
  | { ok: false; code: "minimum_moved" | "no_call"; detail: string; approved?: string; offered?: string };
export interface SwapStatus {
  operationId: string | null;
  orderId: string;
  /** the operation record's state (null when the record is not in the journal) */
  state: OperationState | null;
  settlement: SettlementState | null;
  tracked: Tracked | null;
  job: SwapJob | null;
  paused: StoredSwap["paused"] | null;
}
export type WalletSwapProvider = SwapProvider<SwapRequest, SwapQuote, PreparedSwap, ValidationResult, SwapStatus, PrepareOptions>;
export interface WalletSwapProviderDeps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  session?: WalletSession;
  relayerUrl?: string | null;
  now?: () => number;
}

/** The chosen route's quote of a set, or null. */
const chosenOf = (set: QuoteSet): ServiceQuote | null => (set.chosen ? (set.quotes.find((q) => q.provider === set.chosen!.provider) ?? null) : null);
/** The journaled order of an execution id: the order id or the API's operation id, either case. */
function journaled(s: WalletSession, executionId: string): StoredSwap | null {
  const k = executionId.toLowerCase();
  return s.journal().swaps.find((x) => x.orderId.toLowerCase() === k || x.operationId?.toLowerCase() === k) ?? null;
}

/**
 * The recovery options of an order as it stands (spec v3.0 §5; pure): a moved minimum offers to accept it or return the
 * funds; an unexecutable call to try the hand-over again or return the funds; a closed window the return alone; a reconcile
 * monitoring with the funds unknown; a refundable escrow the return beside monitoring; an open order monitoring; a finished
 * one its progress. The funds class: not moved before the funding, still protected while the escrow holds them, unknown with
 * the provider; none once delivered.
 */
export function recoveryOptionsOf(
  stored: Pick<StoredSwap, "state" | "paused" | "fundedTx">,
  record: Pick<OperationRecord, "state" | "settlement"> | null,
): RecoveryOption[] {
  const settlement = record?.settlement ?? null;
  const funded = !!stored.fundedTx || stored.state === "funded" || settlement !== null;
  const held: FundsClass = !funded ? "not-moved" : settlement === "PROVIDER_PENDING" || settlement === "DESTINATION_PENDING" ? "unknown" : "still-protected";
  const terminal = record ? TERMINAL_STATES.includes(record.state) : CLOSED_STATES.includes(stored.state);
  if (terminal)
    return [{ action: "view-progress", fundsClass: record?.state === "COMPLETED" ? null : record?.state === "REFUNDED" ? "still-protected" : held }];
  const code = stored.paused?.code;
  if (code === "minimum_moved")
    return [
      { action: "accept-new-minimum", fundsClass: held },
      { action: "return-funds", fundsClass: held },
    ];
  if (code === "execution_unavailable")
    return [
      { action: "retry-hand-over", fundsClass: held },
      { action: "return-funds", fundsClass: held },
    ];
  if (code === "execution_window_closed") return [{ action: "return-funds", fundsClass: held }];
  if (code === "reconcile") return [{ action: "continue-monitoring", fundsClass: "unknown" }];
  if (settlement === "REFUND_AVAILABLE")
    return [
      { action: "return-funds", fundsClass: "still-protected" },
      { action: "continue-monitoring", fundsClass: "still-protected" },
    ];
  return [{ action: "continue-monitoring", fundsClass: held }];
}

/** The wallet's swap provider: the service's competition, the wallet's commit, checks, reads and options. */
export function walletSwapProvider(d: WalletSwapProviderDeps): WalletSwapProvider {
  const s = d.session ?? defaultSession;
  const now = () => d.now?.() ?? Date.now();
  return {
    // the service's competition over every adapter (spec v3.0 §5): the id names the service, not one provider
    id: "privacy-wallet",
    async getQuote(request) {
      const set = await swapService.quote(request);
      return { request, set, chosen: chosenOf(set), quote: set.quote ?? null };
    },
    async prepare(q, o) {
      if (!o) throw new Error("prepare needs the commit's facts: the policy, the preference, the source asset and the wallet's tier");
      const provider = o.provider ?? q.chosen?.provider;
      const committed = await confirmOrder({
        masterSeed: d.masterSeed,
        deployment: d.deployment,
        session: s,
        request: q.request,
        policy: o.policy,
        ...(provider ? { provider } : {}),
        fromAsset: o.fromAsset,
        ...(q.chosen ? { shown: q.chosen } : {}),
        competition: q.set.competition ?? null,
        lint: o.lint ?? null,
        preference: o.preference,
        walletTier: o.walletTier,
        ...(o.shield ? { shield: o.shield } : {}),
        ...(o.reviewedFee !== undefined ? { reviewedFee: o.reviewedFee } : {}),
        ...(o.reviewedMergeFee !== undefined ? { reviewedMergeFee: o.reviewedMergeFee } : {}),
        ...(o.shownTip !== undefined ? { shownTip: o.shownTip } : {}),
        ...(o.delay !== undefined ? { delay: o.delay } : {}),
        ...(o.maxTiming !== undefined ? { maxTiming: o.maxTiming } : {}),
        now: o.now ?? now(),
      });
      const operationId = committed.stored.operationId ?? null;
      // the provider call read once with the commit (the runner reads its own at funding and at signing): an answer the
      // provider cannot give now is no failure of the commit — the order stands and the call is read again later
      const call = o.withCall !== false && operationId ? await swapService.prepare(operationId, undefined).catch(() => null) : null;
      return {
        operationId,
        orderId: committed.stored.orderId,
        order: committed.order,
        escrow: committed.order.endpoint as Address,
        stored: committed.stored,
        call,
        committed,
      };
    },
    async validate(p) {
      if (!d.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
      const deployment = d.deployment;
      const prepared = p.call ?? (p.operationId ? await swapService.prepare(p.operationId, undefined).catch(() => null) : null);
      if (!prepared) return { ok: false, code: "no_call", detail: "the provider gave no call to check yet; the runner reads one at funding and at signing" };
      const stored = journaled(s, p.orderId) ?? p.stored;
      const gate = await checkBeforeSigning({
        prepared,
        order: p.order,
        journaled: stored as unknown as JournaledOrder,
        factory: swapFactoryOf(deployment),
        chainId: BigInt(deployment.chainId),
        pooled: (deployment.erc20Vaults ?? []).map((v) => ({ token: v.token, symbol: v.symbol, decimals: v.decimals })),
        deployment,
        masterSeed: d.masterSeed,
        usd: await agreedUsd(deployment), // this wallet's own prices bound a swap-first Mayan leg (the third review round, 2026-11-03)
      });
      if (!gate.ok)
        return {
          ok: false,
          code: "minimum_moved",
          detail: gate.moved.message,
          approved: gate.moved.approved.toString(),
          offered: gate.moved.minOut.toString(),
        };
      return { ok: true, escrow: gate.escrow, call: gate.call, checks: CHECKS };
    },
    async getStatus(executionId) {
      const stored = journaled(s, executionId);
      if (!stored) throw new Error("this order is not in the journal");
      const { tracked, job } = await trackOrder(stored, { deployment: d.deployment, relayerUrl: d.relayerUrl ?? null, session: s, now: now() });
      const record = getOperation(swapRecordId(stored.orderId), s);
      const latest = journaled(s, stored.orderId) ?? stored;
      return {
        operationId: latest.operationId ?? null,
        orderId: latest.orderId,
        state: record?.state ?? null,
        settlement: tracked.settlement ?? record?.settlement ?? null,
        tracked,
        job,
        paused: latest.paused ?? null,
      };
    },
    async getRecoveryOptions(executionId) {
      const stored = journaled(s, executionId);
      if (!stored) throw new Error("this order is not in the journal");
      return recoveryOptionsOf(stored, getOperation(swapRecordId(stored.orderId), s));
    },
  };
}
