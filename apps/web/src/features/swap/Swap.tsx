// V6 Stage 11: this V5 screen serves /swap/protected only — the protected execution (a campaign at its band, the
// wizard, the campaign Review, its progress) — until Stage 13 rebuilds large trades on the V6 screens; every other swap
// runs on ./SwapScreen.tsx with one confirmation.
// Swap (spec §3.6–§3.9, §3.12, §11–§13; private-swap spec; whale spec §23–§24; High-Value Protection spec §14–§16;
// plan §17–§18, §22–§26, §37, §61): one card — From (the protected balance), To (the destination asset, a fresh address
// of this wallet by default), the best protected route as a quote card, the fee summary, the estimated time, the
// privacy line, the §3.7 checklist on a cross-chain route — then the Review (every size), the §3.8 interstitial at the
// `large-protected` band and above with the strict quote and the provider's health, the wizard and the Review before
// a protected execution from the enhanced tier, the order after commit (funding, the signed hand-over, the tracking,
// the recovery), the open orders and the protected swaps. The engines are untouched: sdk/swapService (the quotes),
// sdk/swapExecute (commit, prepare and sign, hand over, return), sdk/swapFunding, sdk/orderTracker, wallet/campaigns
// and the runner. The user never selects a provider, a relayer, a route, an RPC or a gas strategy; Compare routes is
// under Advanced only, and the provider's name appears only there — the default word is "Best route".
import { useEffect, useMemo, useState } from "react";
import { stepsAmountAtFixedPoint } from "./model";
import { destinationStatusWords, destinationWords } from "../destinationWords";
import { knownRecipients } from "../recipients";
import type { Address, Hex } from "viem";
import { availablePrice, formatUsd, higherTier, TIERS, tierLabel, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { parseDestination, looksLikeChain } from "@privacy-wallet/protocol/wallet/destinations";
import { unacknowledgedBlocks, type LintId, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import { maximumLossModel } from "@privacy-wallet/protocol/wallet/campaign";
import { AddressInput, AmountInput, AssetSelector, Button, Card, FeeSummary, ListRow, Page, QuoteCard, TextButton, type AddressCheck, type AssetOption, type QuoteView } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { formatDateTime } from "../../app/i18n/intl";
import { feeSummary, planLabel, swapService, type AssetRef, type ExecutionPlan, type Policy, type QuoteSet, type RouteScore, type ServiceOrder, type Protection } from "@privacy-wallet/sdk/swapService";
import { commitOrder, handOverSigned, prepareAndSign, resumeOrder, returnOrderToBalance, type Signed } from "@privacy-wallet/sdk/swapExecute";
import { controlsFor, exportOrderReview, issuerLine, planWords, reviewHoldMinutes, routeKind, PROTECTED_EXECUTION } from "@privacy-wallet/sdk/tiers";
import { downloadText } from "@privacy-wallet/sdk/download";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { swapFunding, type FeeSplit, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import { feeTerms } from "@privacy-wallet/sdk/privateTx";
import { trackOrder, type Tracked } from "@privacy-wallet/sdk/orderTracker";
import { useAiSession } from "../../zkapi/aiSession";
import { checkTrade, tradeSummary } from "../../zkapi/tradeCheck";
import { deriveOrderKey } from "@privacy-wallet/sdk/keys/swapKeys";
import type { CheckedCall, MinimumMoved } from "@privacy-wallet/sdk/providerCall";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { recoverSwapRefunds } from "@privacy-wallet/sdk/privateTx";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { assetByVault, assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import { relayerInfo, relayerSwapStatus, type SwapJob } from "@privacy-wallet/sdk/relayer";
import { fmtUnits } from "@privacy-wallet/sdk/format";
import { DELAY_WINDOW, policyFromPreference } from "@privacy-wallet/sdk/policy";
import { holdersAbove } from "@privacy-wallet/sdk/poolDeposits";
import { abandonSwap, assetOfStored, fundEscrow, isOpenSwap, patchSwap, swapFactoryOf } from "@privacy-wallet/sdk/swapFunding";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { session } from "@privacy-wallet/sdk/wallet/session";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { topBucket, walletLint } from "@privacy-wallet/sdk/wallet/lintFacts";
import { completeAction } from "@privacy-wallet/sdk/wallet/schedule";
import { destinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import { acceptReroute, activeCampaigns, buildCampaign, campaignById, cancelCampaign, pauseCampaign, progressLine, resumeCampaign, startCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { crossRateFromPrices } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { DestinationCard } from "../../components/DestinationCard";
import { PrivacyLint } from "../../components/PrivacyLint";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { Review, type ReviewProps } from "../review/ReviewScreen";
import { swapFees } from "../fees/feeEngine";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { CampaignProgress } from "./protected/CampaignProgress";
import { CompareRoutes } from "./CompareRoutes";
import { OrderPanel } from "./OrderPanel";
import { ProtectedExecutionNotice } from "./ProtectedExecutionNotice";
import { Wizard } from "./Wizard";
import { alternativesOf, campaignFacts, campaignLines, commitDetails, commitExecution, commitLines, executeLines, liveQuotesOf, orderTarget, rerouteLines, usdOfUnits, type SwapContext } from "./facts";
import { cappedSlippageBps, providerHealthy, strictQuote } from "./protectedChecks";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { TARGETS, durationWords, hours, refOf, settlementWords, type Target } from "./targets";
import { useOperation, useSession, useSettings } from "../../hooks";

const asTier = (x: unknown): Tier | null => (TIERS.includes(x as Tier) ? (x as Tier) : null);
type ReviewState = { moment: "commit"; provider?: string } | { moment: "execute"; signed: Signed } | { moment: "campaign"; provider: string } | { moment: "reroute"; campaignId: string };

/** V6 Stage 10: what Send hands over when a Bitcoin or another chain's destination continues as a cross-chain send (spec v2.0 §7.4). */
export interface SwapPrefill { fromVault?: string; amount?: string; target?: string; destination?: string }
export interface SwapProps { masterSeed: Uint8Array; deployment: Deployment | null; /** the connected public wallet, if any: a destination equal to it is flagged */ account?: string | null; onBack?: () => void; prefill?: SwapPrefill | null; /** V6 Stage 11: open this protected swap's view at once */ campaignId?: string | null }

export function Swap({ masterSeed, deployment, account = null, onBack, prefill = null, campaignId = null }: SwapProps) {
  const t = useT();
  const { submission, advanced, preference, verifyReads, secondFactor, protection } = useSettings();
  useSession(); // re-render when the journal-backed session changes
  const assets = useMemo(() => assetsOf(deployment), [deployment]);
  const [fromAsset, setFromAsset] = useState<Asset>(() => assets.find((a) => a.vault === prefill?.fromVault) ?? assets[0]);
  const [target, setTarget] = useState(() => (prefill?.target && TARGETS[prefill.target] ? prefill.target : "BTC"));
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [destination, setDestination] = useState(() => prefill?.destination || peekFreshAddress(masterSeed, chainKindOf(TARGETS[prefill?.target && TARGETS[prefill.target] ? prefill.target : "BTC"].ref.chain)).address);
  const [destinationEdited, setDestinationEdited] = useState(!!prefill?.destination);
  const [pickingFrom, setPickingFrom] = useState(false);
  const [pickingTo, setPickingTo] = useState(false);
  const [compare, setCompare] = useState(false);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [funding, setFunding] = useState<{ amount: bigint; terms: FeeTerms; split: FeeSplit } | null>(null);
  const [order, setOrder] = useState<ServiceOrder | null>(null);
  const [stored, setStored] = useState<StoredSwap | null>(null);
  const [orderKey, setOrderKey] = useState<{ privateKey: Hex; address: Hex } | null>(null);
  const [refundNoteData, setRefundNoteData] = useState<Hex | null>(null);
  const [signed, setSigned] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedCall | null>(null);
  const [moved, setMoved] = useState<MinimumMoved | null>(null);
  const [job, setJob] = useState<SwapJob | null>(null);
  const [refundLine, setRefundLine] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [holders, setHolders] = useState<number | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [interstitial, setInterstitial] = useState<string | null>(null); // the provider the §3.8 notice precedes
  const [routeAck, setRouteAck] = useState(false);
  const [destAck, setDestAck] = useState(false);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [wizard, setWizard] = useState<{ provider: string; step: 0 | 1 | 2 } | null>(null);
  const [campaignView, setCampaignView] = useState<string | null>(campaignId);
  const [relayerFee, setRelayerFee] = useState<bigint | null>(null);
  const [tick, setTick] = useState(0);

  const to: Target = TARGETS[target];
  const units = parseAmount(fromAsset, amount);
  const bucket = bucketBelowFor(fromAsset, units);
  const chain = chainKindOf(to.ref.chain);
  // a V6 follow-up of 2026-10-16: an address that would lose what it receives is refused, and a refusal is said in the user's language
  const known = useMemo(() => knownRecipients(deployment), [deployment]);
  const parsedDestination = destinationEdited ? parseDestination(chain, destination, known) : null;
  const destinationError = parsedDestination && !parsedDestination.ok ? destinationWords(t, parsedDestination) : "";
  const otherChain = destinationEdited && destination.trim() ? looksLikeChain(destination.trim()) : null;
  useEffect(() => {
    if (!deployment || units <= topBucket(fromAsset.decimals)) { setHolders(null); return; }
    let live = true;
    holdersAbove(deployment, fromAsset.vault, units).then((h) => { if (live) setHolders(h); }).catch(() => { if (live) setHolders(null); });
    return () => { live = false; };
  }, [deployment, units, fromAsset]);
  const priced = feedsConfigured(deployment);
  const assessment = units > 0n && priced ? priceStore.assess(units, fromAsset) : null;
  const usd = assessment && "usd" in assessment.value ? assessment.value.usd : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  const destCheck = destinationEdited && parsedDestination?.ok ? destinationCheck(chain, destination, { tier }) : null;
  const destinationLocked = controls.destinationLock && !!destCheck && !destCheck.ok;
  useEffect(() => { if (priced) void priceStore.refresh(deployment); }, [deployment, priced]);
  const policy: Policy = quotes?.policy ?? policyFromPreference(preference);
  // V6 (spec v2.0 §3): the escrow is funded with W = A − p(A) − F, one fee note p(A) + F; the relayer's terms are read when
  // the user asks for a quote (nothing is fetched before) and the providers quote what W can buy. A swap funded by the
  // connected wallet pays no relayer and no fee note: W = A.
  const escrowAmount = funding && funding.amount === units ? funding.split.delivered : units;
  const request = () => ({ from: refOf(fromAsset), to: to.ref, amount: escrowAmount.toString(), destination, slippageBps: controls.strictQuote ? cappedSlippageBps(50) : 50, preference, ...(assessment ? { tier: assessment.tier } : {}), destinationKind: (destinationEdited ? "entered" : "fresh") as "entered" | "fresh", preferNative: preference === "native", mode: protection.mode });
  const openSwaps = session.isUnlocked() ? session.journal().swaps.filter((x) => isOpenSwap(x) && !x.campaign) : [];
  const assetOf = (s: StoredSwap): Asset => assetOfStored(deployment, s);
  const record = useOperation(stored ? swapRecordId(stored.orderId) : null);

  function chooseTarget(id: string) {
    setTarget(id); setQuotes(null); reset();
    if (!destinationEdited) setDestination(peekFreshAddress(masterSeed, chainKindOf(TARGETS[id].ref.chain)).address);
  }
  function takeFresh() { setDestinationEdited(false); setDestination(peekFreshAddress(masterSeed, chain).address); setDestAck(false); }
  function changeDestination(v: string) { setDestination(v); setDestinationEdited(v.trim() !== ""); setDestAck(false); if (v.trim() === "") takeFresh(); }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e) { setError(classify(e).detail || String(e)); } finally { setBusy(""); }
  }

  // settlement tracking (whale spec §19): every 15 s while the order is open on this screen; every transition is journaled and the operation record follows
  const trackedOrderId = stored?.orderId;
  useEffect(() => {
    if (!trackedOrderId) { setTracked(null); return; }
    let live = true;
    const run = async () => {
      const current = session.isUnlocked() ? session.journal().swaps.find((x) => x.orderId === trackedOrderId) : undefined;
      if (!current) return;
      try {
        const r = await trackOrder(current, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null });
        if (!live) return;
        setTracked(r.tracked);
        if (r.job) { setJob(r.job); setStored((s) => (s && s.orderId === trackedOrderId ? { ...s, state: r.job!.state, ...(r.job!.executionTx ? { executionTx: r.job!.executionTx } : {}) } : s)); }
        syncSwapRecord(current, r.tracked, r.job);
      } catch { /* the next tick */ }
    };
    void run();
    const timer = setInterval(() => { if (!tracked || !["COMPLETED", "REFUNDED", "CANCELLED", "EXPIRED"].includes(tracked.state)) void run(); }, PROTECTED_EXECUTION.POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [trackedOrderId, deployment, submission, tick]);

  // the executor re-shielded the order: its refund note goes into the wallet now, not at the next rescan (PP-S09)
  useEffect(() => {
    if (job?.state !== "refunded" || !deployment || !stored) return;
    let live = true;
    const orderId = stored.orderId.toLowerCase();
    recoverSwapRefunds({ masterSeed, deployment })
      .then((rs) => {
        if (!live) return;
        const mine = rs.filter((r) => r.orderId.toLowerCase() === orderId);
        const amountOf = (r: (typeof rs)[number]) => { const a = assetByVault(deployment, r.note.vaultId); return a ? `${formatAmount(a, r.note.amount)} ${a.symbol}` : `${r.note.amount} base units`; };
        for (const r of mine) {
          const a = assetByVault(deployment, r.note.vaultId);
          recordActivity({ id: activityId("refund", `${orderId}:${r.leafIndex}`), kind: "refund", asset: a?.symbol ?? "units", decimals: a?.decimals ?? 0, amount: r.note.amount.toString(), status: "completed", ref: stored.orderId, note: t("swap.refundNote") });
        }
        setRefundLine(mine.length ? t("swap.refunded", { amounts: mine.map(amountOf).join(" + ") }) : t("swap.refundedNotSeen"));
      })
      .catch((e) => live && setRefundLine(t("swap.refundedRecordFailed", { reason: e instanceof Error ? e.message : String(e) })));
    return () => { live = false; };
  }, [job?.state, stored?.orderId, deployment]);

  function reset() { setOrder(null); setStored(null); setOrderKey(null); setRefundNoteData(null); setSigned(null); setChecked(null); setMoved(null); setJob(null); setCompare(false); setRefundLine(""); setReview(null); setInterstitial(null); setRouteAck(false); setDestAck(false); setError(""); }
  function patchStored(orderId: string, patch: Partial<StoredSwap>) {
    patchSwap(orderId, patch);
    setStored((s) => (s && s.orderId.toLowerCase() === orderId.toLowerCase() ? { ...s, ...patch } : s));
  }

  async function getQuotes() {
    reset();
    const set = await run(t("swap.finding"), async () => {
      const read = submission.kind === "relayer" && deployment ? await feeTerms(deployment, submission, fromAsset.vault) : null;
      const terms: FeeTerms | null = read ? { minimum: read.fee.amount, feePercentBps: read.info.feePercentBps ?? 0 } : null;
      const split = terms ? swapFunding(units, terms) : null;
      if (split?.tooSmall) throw new Error(t("swap.tooSmallForFees"));
      setFunding(terms && split ? { amount: units, terms, split } : null);
      return swapService.quote({ ...request(), amount: (split ? split.delivered : units).toString() });
    });
    if (set) setQuotes(set);
  }

  async function commit(provider?: string) {
    try { swapFactoryOf(deployment); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    const shown = quotes?.quotes.find((q) => q.provider === (provider ?? quotes.chosen?.provider)); // the minimum the user saw and approved
    const dest = destinationEdited ? destination : consumeFreshAddress(masterSeed, chain).address; // reserve the fresh address now
    const req = { ...request(), destination: dest };
    const committedLint = lintItems, competition = quotes?.competition;
    const reviewHoldUntil = controls.reviewHold ? Date.now() + reviewHoldMinutes() * 60_000 : undefined; // institutional (spec §24)
    // the relayer's fee the Review showed bounds the funding, scheduled or "Fund now" (c46; audit round 2, r12: this page journaled none)
    const reviewedFee = funding && funding.amount === units ? funding.amount - funding.split.delivered : undefined;
    const res = await run(t("swap.committing"), () => commitOrder({ masterSeed, deployment, request: req, policy, provider, fromAsset, shown, competition, lint: committedLint, preference, walletTier: assessment ? tier : null, schedule: { reviewHoldUntil }, ...(reviewedFee !== undefined ? { reviewedFee } : {}) }));
    if (!res) return;
    reset();
    setOrder(res.order); setStored(res.stored); setOrderKey(res.key); setRefundNoteData(res.refund.noteData);
    syncSwapRecord(res.stored, null, null);
    if (!destinationEdited) setDestination(dest);
  }

  /** Resume an order from the journal after a reload: the service rebuilds it from the same params (same escrow). */
  async function resume(s: StoredSwap) {
    const o = await run(t("swap.resuming"), () => resumeOrder(deployment, s));
    if (!o) return;
    reset();
    setOrder(o); setStored(s); setOrderKey(deriveOrderKey(masterSeed, s.attemptId as Hex)); setRefundNoteData((s.refundNoteData as Hex | undefined) ?? null);
    if (s.jobId && submission.kind === "relayer") relayerSwapStatus(submission.url, s.jobId).then(setJob).catch(() => {});
  }

  /** The commit moment: the §3.8 notice at the band and above, the wizard for a protected execution, else the Review (every size). */
  function startCommit(provider?: string) {
    const prov = provider ?? quotes?.chosen?.provider;
    setRouteAck(false); setDestAck(false); setError("");
    if (tier === "large-protected" && !interstitial && prov && !campaignMode) { setInterstitial(prov); return; } // spec §3.8 at the band; from enhanced the V3 wizard and Review carry the safeguards (the V4 tiers unchanged)
    if (campaignMode && protectionPlan) { setInterstitial(null); setWizard({ provider: prov ?? protectionPlan.provider, step: 0 }); return; }
    setInterstitial(null);
    setReview({ moment: "commit", provider });
  }
  async function fundNow() {
    if (!stored) return;
    const w = await run(t("swap.fundingNow"), async () => {
      const r = await fundEscrow({ masterSeed, deployment, stored, onStatus: setBusy, relayerUrl: submission.kind === "relayer" ? submission.url : null, replaceDead: true });
      setStored((s) => (s ? { ...s, fundedTx: r.txHash, state: "funded" } : s));
      return r;
    });
    if (w) { completeAction(`fund-escrow:${stored.orderId}`); setTick((n) => n + 1); }
  }
  async function returnToBalance() {
    if (!order || !stored || !refundNoteData) return;
    const j = await run(t("swap.handingRefund"), () => returnOrderToBalance({ deployment, stored, submission }));
    if (!j) return;
    setMoved(null); setJob(j);
    setStored((x) => (x && x.orderId.toLowerCase() === order.orderId.toLowerCase() ? { ...x, jobId: j.id, state: j.state } : x));
  }
  async function prepareSigned(acceptMin?: bigint): Promise<Signed | { moved: MinimumMoved } | undefined> {
    if (!order || !orderKey || !refundNoteData) return;
    if (!stored) { setError(t("swap.notInJournal")); return; }
    const r = await run(t("swap.requoting"), () => prepareAndSign({ masterSeed, deployment, stored, order, submission, acceptMin, onStatus: setBusy }));
    if (!r) return;
    const current = session.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
    if (current) setStored(current);
    if (!("moved" in r)) setChecked(r.call);
    return r;
  }
  async function handOver(s: Signed) {
    if (!order || !refundNoteData || !stored) return;
    const r = await run(t("swap.handingOver"), () => handOverSigned({ deployment, stored, order, signed: s, submission }));
    if (!r) return;
    const current = session.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
    if (current) setStored(current);
    setReview(null); setMoved(null); setSigned(s.label); if (r.job) setJob(r.job);
    setTick((n) => n + 1);
  }
  /** The execute moment: at the band the strict quote and the provider's health first; prepare, check, sign, simulate; then the Review or the hand-over at once. */
  async function signAndHand(acceptMin?: bigint) {
    if (executeControls.strictQuote && stored) {
      const q = stored.quote as { expiresAt?: number; toAmount?: string; toAmountMin?: string } | undefined;
      if (q?.expiresAt !== undefined && q.toAmount && q.toAmountMin) {
        const v = strictQuote({ expiresAt: q.expiresAt, toAmount: q.toAmount, toAmountMin: q.toAmountMin });
        if (!v.ok && v.code === "quote_ttl_short") { setError(t(`op.error.${v.code}.reason`)); setJob((j) => j); return; }
      }
    }
    const s = await prepareSigned(acceptMin);
    if (!s) return;
    if ("moved" in s) { setMoved(s.moved ?? null); return; }
    setMoved(null);
    if (acceptMin !== undefined) patchStored(order!.orderId, { approvedMin: acceptMin.toString() });
    if (executeControls.review) { setReview({ moment: "execute", signed: s }); return; }
    await handOver(s);
  }

  const chosen = quotes?.chosen;
  const chosenQuote = chosen ? quotes!.quotes.find((q) => q.provider === chosen.provider) : undefined;
  const protectionPlan: Protection | null = quotes?.protection ?? null;
  const campaignMode = !!protectionPlan && protection.enabled && (controls.campaign || (tier === "enhanced" && (protectionPlan.staged || protection.protectFromEnhanced)) || tier === "large-protected"); // V6 Stage 13: automatic from $50K, no opt-in
  const ctx: SwapContext = { t, quotes: quotes!, fromAsset, to, units, usd, tier, controls, policy, preference, destination, destinationEdited, parsedOk: parsedDestination?.ok === true, destAck, routeAck, destCheck, destinationLocked, lintItems: null, protection: { mode: protection.mode, capBps: protection.capBps }, relayerFee };
  const lineDraft = (() => {
    if (!campaignMode || !protectionPlan || !quotes?.chosen) return null;
    try { return buildCampaign({ quotes, provider: protectionPlan.provider, from: refOf(fromAsset), fromAsset, to: to.ref, amount: units, tier, mode: protection.mode, preference, policy, destination: destinationEdited ? { kind: "entered", address: destination } : { kind: "fresh-per-tranche" }, usd, capBps: protection.capBps, now: Date.now(), rng: () => 0.5 }); } catch { return null; }
  })();
  useEffect(() => { if (review?.moment === "campaign" && submission.kind === "relayer") relayerInfo(submission.url).then((i) => setRelayerFee(BigInt(i.minFeeWei))).catch(() => setRelayerFee(null)); }, [review?.moment, submission]);
  const orderAsset = stored ? assetOf(stored) : fromAsset;
  const window = DELAY_WINDOW[policy];
  const storedTier: Tier = asTier(stored?.tier) ?? tier;
  const executeControls = controlsFor(storedTier);
  const holdActive = !!stored?.reviewHoldUntil && stored.reviewHoldUntil > Date.now();
  const quotedOnly = quotes?.competition ? quotes.competition.filter((c) => c.outcome === "quoted").length : undefined;
  const lintInput = { tier: assessment?.tier ?? ("standard" as const), deployment, settings: { submission, verifyReads }, account, amount: units, decimals: fromAsset.decimals, amountIsBucket: isBucketFor(fromAsset, units), holders, acknowledged };
  const lintItems: LintItem[] | null = quotes && chosen ? walletLint({ ...lintInput, action: "swap", destination, destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: chosen.provider, ...(campaignMode && protectionPlan ? { campaign: { sizing: protectionPlan.sizing, consecutiveSameSize: false, destinationPerTranche: !destinationEdited, cadenceFixed: false, destinationCooling: !!destCheck && !destCheck.ok } } : {}) }) : null;
  ctx.lintItems = lintItems;
  const signLint = checked && stored ? walletLint({ ...lintInput, action: "swap", destination: String((stored.request as { destination?: string })?.destination ?? destination), destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: checked.provider, checked, approvedMin: stored.approvedMin ? BigInt(stored.approvedMin) : null }) : null;
  const blocked = lintItems ? unacknowledgedBlocks(lintItems).length > 0 : false;
  const ack = (id: LintId) => setAcknowledged((x) => [...x, id]);
  const ai = useAiSession();
  const tradeCheckFor = (chosenProvider: string | undefined, quote: { plan?: ExecutionPlan; etaSeconds: number; impactBps?: number; nativeAssets: boolean; toAmountMin: string } | undefined, score: RouteScore | undefined, linkPublic: boolean | undefined, lintList: LintItem[] | null, amountUnits: bigint, target_: AssetRef, prot?: Protection): ReviewProps["tradeCheck"] => ({
    available: !!ai.access,
    reason: ai.access ? undefined : t("swap.tradeCheckUnavailable"),
    run: async () => checkTrade(ai.access!, ai.model, tradeSummary({ from: { chain: "ethereum", symbol: fromAsset.symbol, decimals: fromAsset.decimals }, to: { chain: target_.chain, symbol: target_.symbol, decimals: target_.decimals }, amountUnits, usd, tier, preference, chosen: chosenProvider && quote ? { provider: chosenProvider, score, quote, linkPublic } : null, competition: quotes?.competition ?? (stored?.competition as never) ?? null, lint: lintList, protection: prot })),
  });

  // ---- the protected execution (High-Value Protection spec §14–§16)
  async function startProtected(provider: string) {
    const f = campaignFacts(ctx, provider);
    const now = Date.now();
    let gasPriceWei: string | null = null;
    if (submission.kind === "relayer") { try { gasPriceWei = (await relayerInfo(submission.url)).gasPriceWei; } catch { gasPriceWei = null; } }
    // the steps and each step's fee note spend at most what was typed (the audit round of 2026-10-16, c50): every step's funding
    // pays its own p + F, so the steps run what as many fundings as the plan can have deliver — as on the band's Swap screen —
    // and the price bound is per unit of the funding the set was quoted for
    const base = { quotes: quotes!, provider, from: refOf(fromAsset), fromAsset, to: to.ref, tier, mode: protection.mode, preference, policy, destination: f.destinationPolicy, usd, lint: lintItems, capBps: protection.capBps, providerShareCapBps: protection.providerShareCapBps };
    // the smallest pieces: the most steps an amount can make, read again for the steps' own amount (a lower one can make more)
    const countFor = (amount: bigint) => { try { return buildCampaign({ ...base, amount, now, rng: () => 0 }).tranches.length; } catch { return 1; } };
    const amount = funding ? stepsAmountAtFixedPoint(units, funding.terms, countFor).amount : units;
    if (amount <= 0n) { setError(t("swap.tooSmallForFees")); return; }
    const c = await run(t("swap.startingProtected"), async () => startCampaign({
      ...base, amount, quotedAmount: escrowAmount, leaves: units, // what may leave, the steps' fee notes included (audit round 2, r18)
      crossRateE18: crossRateFromPrices({ request: { from: refOf(fromAsset), to: to.ref } } as never), gasPriceWei,
      confirmations: { ...(controls.secondFactor ? { secondFactor: now } : {}), ...(controls.secondDevice ? { secondDevice: now } : {}) },
      reviewHoldUntil: [controls.reviewHold ? now + reviewHoldMinutes() * 60_000 : 0, destCheck?.reason === "cooling-off" && destCheck.until ? destCheck.until : 0].reduce((m, x) => Math.max(m, x), 0) || undefined, now,
    }));
    if (!c) return;
    reset(); setQuotes(null); setCampaignView(c.id);
  }

  const pageTitle = t("route.swap");

  // ---- the Reviews
  if (review) {
    const q = quotes;
    let props: Omit<ReviewProps, "onConfirm" | "onCancel"> | null = null;
    let onConfirm: () => void | Promise<void> = () => {};
    if (review.moment === "commit" && q) {
      const prov = review.provider ?? q.chosen!.provider;
      const quote = q.quotes.find((x) => x.provider === prov)!;
      const score = q.scores.find((s) => s.provider === prov) ?? q.chosen!;
      const dec = to.ref.decimals, sym = to.ref.symbol;
      const exportNow = () => downloadText(`privacy-wallet-order-review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify({ format: "privacy-protocol/order-review/v1", exportedAt: new Date().toISOString(), request: request(), tier, value: assessment?.value ?? null, provider: prov, quote, score, competition: q.competition ?? null, lint: lintItems ?? [] }, null, 2));
      props = {
        moment: "commit", tier, controls, usd: usd !== null ? formatUsd(usd) : null, amount: `${formatAmount(fromAsset, units)} ${fromAsset.symbol}`, from: t("swap.fromProtected", { symbol: fromAsset.symbol }),
        to: { network: to.network, asset: sym, address: destination, kind: destinationEdited ? "entered" : "fresh" }, receiveMin: `${fmtUnits(quote.toAmountMin, dec)} ${sym}`, execution: commitExecution(ctx, quote),
        privacy: { level: levelOf(score.components.privacy), score: score.components.privacy }, lint: lintItems ?? [], onAcknowledgeLint: ack, lines: commitLines(ctx, prov, quote, () => setRouteAck(true), () => setDestAck(true)),
        issuer: issuerLine(fromAsset.symbol) ?? issuerLine(sym), routeKind: routeKind(refOf(fromAsset), to.ref, quote.nativeAssets), crossChain: to.ref.chain !== refOf(fromAsset).chain, details: commitDetails(ctx, prov, quote, score),
        advanced, reviewHold: controls.reviewHold ? { minutes: reviewHoldMinutes() } : null, onExport: controls.export ? exportNow : undefined, secondFactor: controls.secondFactor ? { credentialId: secondFactor.credentialId } : null,
        secondDevice: controls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null,
        tradeCheck: tradeCheckFor(prov, quote, score, q.links?.[prov]?.public, lintItems, units, to.ref), busy, error, protectedExecution: controls.protectedExecution,
      };
      onConfirm = () => commit(prov);
    } else if (review.moment === "execute") {
      const s = review.signed;
      const tgt = ((stored?.request as { to?: AssetRef })?.to ?? to.ref);
      const dec = tgt.decimals, sym = tgt.symbol;
      const dest = String((stored?.request as { destination?: string })?.destination ?? destination);
      const quote = (stored?.quote ?? {}) as { impactBps?: number; nativeAssets?: boolean; toAmount?: string; etaSeconds?: number };
      props = {
        moment: "execute", tier: storedTier, controls: executeControls, usd: stored?.value && typeof stored.value === "object" && "usd" in (stored.value as object) ? formatUsd((stored.value as { usd: number }).usd) : usd !== null ? formatUsd(usd) : null,
        amount: `${formatAmount(orderAsset, BigInt((stored?.params as { amount?: string })?.amount ?? "0"))} ${orderAsset.symbol}`, from: t("swap.fromEscrow"),
        to: { network: orderTarget(stored, to, TARGETS).network, asset: sym, address: dest, kind: destinationEdited ? "entered" : "fresh" }, receiveMin: s.call.minOut !== null ? `${fmtUnits(s.call.minOut.toString(), dec)} ${sym}` : null,
        execution: { words: planWords(s.prepared.plan ?? (stored?.plan as ExecutionPlan | undefined)), detail: s.prepared.plan && s.prepared.plan.mode !== "single" ? planLabel(s.prepared.plan) : undefined, eta: `~${hours(quote.etaSeconds ?? 0)}` },
        privacy: { level: levelOf(order?.privacy.score ?? 0), score: order?.privacy.score }, lint: signLint ?? [], onAcknowledgeLint: ack, lines: executeLines(t, s, stored, tgt, dest, signLint),
        issuer: issuerLine(orderAsset.symbol) ?? issuerLine(sym), routeKind: routeKind(refOf(orderAsset), tgt, quote.nativeAssets), crossChain: tgt.chain !== refOf(orderAsset).chain,
        details: { provider: s.call.provider, mode: s.prepared.plan?.mode ?? "single", parts: s.prepared.plan?.parts, fees: t("swap.feesAsQuoted"), expectedOutput: quote.toAmount ? `${fmtUnits(quote.toAmount, dec)} ${sym}` : t("swap.asQuoted"), settlement: settlementWords(s.call.provider), alternatives: quotes ? alternativesOf(quotes, s.call.provider) : [] },
        advanced, onExport: executeControls.export && stored ? () => downloadText(`privacy-wallet-order-${stored.orderId.slice(2, 10)}.json`, exportOrderReview(stored, { simulation: s.sim, lint: signLint })) : undefined, secondFactor: executeControls.secondFactor ? { credentialId: secondFactor.credentialId } : null,
        secondDevice: executeControls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null,
        tradeCheck: tradeCheckFor(s.call.provider, quote.toAmount ? { plan: s.prepared.plan, etaSeconds: quote.etaSeconds ?? 0, impactBps: quote.impactBps, nativeAssets: quote.nativeAssets ?? true, toAmountMin: stored?.approvedMin ?? "0" } : undefined, undefined, undefined, signLint, BigInt((stored?.params as { amount?: string })?.amount ?? "0"), tgt),
        busy, error, protectedExecution: executeControls.protectedExecution,
      };
      onConfirm = () => handOver(s);
    } else if (review.moment === "campaign" && q && protectionPlan) {
      const f = campaignFacts(ctx, review.provider);
      const dec = to.ref.decimals, sym = to.ref.symbol;
      const exportNow = () => downloadText(`privacy-wallet-protected-swap-review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify({ format: "privacy-protocol/protected-swap-review/v1", exportedAt: new Date().toISOString(), request: request(), tier, value: assessment?.value ?? null, provider: review.provider, protection: f.p, plan: f.draft.plan, bounds: f.draft.bounds, verdict: f.verdict, lint: lintItems ?? [] }, null, 2));
      props = {
        moment: "campaign", tier, controls, usd: usd !== null ? formatUsd(usd) : null, amount: `${formatAmount(fromAsset, units)} ${fromAsset.symbol}`, from: t("swap.fromProtectedSteps", { symbol: fromAsset.symbol, n: f.steps }),
        to: { network: to.network, asset: sym, address: destination, kind: destinationEdited ? "entered" : "fresh" }, receiveMin: t("swap.receiveMinProRata", { amount: `${fmtUnits(f.quote.toAmountMin, dec)} ${sym}` }),
        execution: { words: t("swap.protectedExecution"), detail: t("swap.stepsEach", { n: f.steps, words: planWords(f.quote.plan).toLowerCase() }), eta: t("swap.facts.about", { duration: t("swap.durationOf", { duration: f.details.duration }) }).replace(/^about about /, "about ") },
        privacy: { level: f.verdict.privacy, score: f.score.components.privacy }, lint: lintItems ?? [], onAcknowledgeLint: ack, lines: campaignLines(ctx, f, () => setRouteAck(true), () => setDestAck(true)),
        issuer: issuerLine(fromAsset.symbol) ?? issuerLine(sym), routeKind: routeKind(refOf(fromAsset), to.ref, f.quote.nativeAssets), maximumLoss: f.maximumLoss, verdict: f.verdict, protectionDetails: f.details, crossChain: to.ref.chain !== refOf(fromAsset).chain,
        details: { provider: review.provider, mode: f.quote.plan?.mode ?? "single", parts: f.quote.plan?.parts, fees: feeSummary(f.quote), expectedOutput: t("swap.expectedWhole", { amount: `${fmtUnits(f.quote.toAmount, dec)} ${sym}` }), settlement: settlementWords(review.provider), alternatives: alternativesOf(q, review.provider), score: `${f.score.total}` },
        advanced, reviewHold: controls.reviewHold ? { minutes: reviewHoldMinutes() } : null, onExport: controls.export ? exportNow : undefined,
        secondFactor: controls.secondFactor ? { credentialId: secondFactor.credentialId } : null, secondDevice: controls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null,
        tradeCheck: tradeCheckFor(review.provider, f.quote, f.score, q.links?.[review.provider]?.public, lintItems, units, to.ref, f.p), busy, error, protectedExecution: true,
      };
      onConfirm = () => startProtected(review.provider);
    } else if (review.moment === "reroute") {
      const c = campaignById(review.campaignId);
      if (!c || !c.pendingReroute) { setReview(null); return null; }
      const pr = c.pendingReroute;
      const np = (pr.protection ?? null) as Protection | null;
      const dec = c.request.from.decimals;
      const fmtFrom = (u: string) => `${fmtUnits(u, dec, 4)} ${c.request.from.symbol}`;
      const level = levelOf(((c.riskSnapshot ?? {}) as { privacyScore?: number }).privacyScore ?? 0);
      props = {
        moment: "reroute", tier: c.tier, controls: controlsFor(c.tier), usd: c.value && typeof c.value === "object" && "usd" in (c.value as object) ? formatUsd((c.value as { usd: number }).usd) : null, amount: t("swap.wholeOrder", { amount: fmtFrom(c.request.amount) }), from: t("swap.fromProtectedSteps", { symbol: c.request.from.symbol, n: c.tranches.length }),
        to: { network: to.network, asset: c.request.to.symbol, address: c.bounds.destination.kind === "fresh-per-tranche" ? t("swap.freshPerStep") : c.bounds.destination.address, kind: c.bounds.destination.kind === "fresh-per-tranche" ? "fresh" : "entered" },
        execution: { words: t("swap.protectedExecution"), detail: t("swap.continuesWith", { provider: pr.provider }), eta: np ? t("swap.aboutForRest", { duration: t("swap.durationOf", { duration: `${Math.round(np.estimatedSeconds / 60)} min` }) }) : t("swap.asBefore") },
        privacy: { level }, lint: [], onAcknowledgeLint: () => {}, lines: rerouteLines(t, c, np, pr.provider, fmtFrom),
        verdict: { security: !np || np.riskClass !== "R6" ? "Review" : "Do not execute", privacy: level, why: t("swap.rerouteWhy", { provider: pr.provider }) },
        advanced, crossChain: c.request.to.chain !== c.request.from.chain, secondFactor: controlsFor(c.tier).secondFactor ? { credentialId: secondFactor.credentialId } : null, secondDevice: controlsFor(c.tier).secondDevice ? { credentialId: protection.secondDevice.credentialId } : null, busy, error, protectedExecution: true,
      };
      onConfirm = () => { acceptReroute(c.id, true); setReview(null); };
    }
    if (!props) { setReview(null); return null; }
    return (
      <Page title={pageTitle} back={() => setReview(null)} testId="swap">
        <Review {...props} onConfirm={onConfirm} onCancel={() => setReview(null)} />
      </Page>
    );
  }

  if (interstitial && quotes) {
    const prov = interstitial;
    const q = quotes.quotes.find((x) => x.provider === prov);
    const health = providerHealthy(quotes.risk?.[prov]);
    const strict = q ? strictQuote(q) : { ok: true as const };
    return (
      <Page title={pageTitle} back={() => setInterstitial(null)} testId="swap">
        <ProtectedExecutionNotice checks={{ destination: !destinationEdited || (destCheck?.verified ?? false), route: health.ok, execution: strict.ok, limits: true }} onContinue={() => { setReview({ moment: "commit", provider: prov }); setInterstitial(null); }} onBack={() => setInterstitial(null)} />
        {!health.ok || !strict.ok ? <p className="ds-note-warn" data-testid="protected-execution-reason">{!health.ok ? t(`op.error.${health.code}.reason`) : t(`op.error.${(strict as { code: "quote_ttl_short" | "slippage_too_wide" }).code}.reason`)}</p> : null}
      </Page>
    );
  }

  if (wizard && quotes && protectionPlan) {
    const f = campaignFacts(ctx, wizard.provider);
    const next = () => {
      if (wizard.step === 0 && !protection.introSeenAt) settings.set({ protection: { ...protection, introSeenAt: Date.now() } }); // the first-time explanation was read (plan §127)
      if (wizard.step < 2) setWizard({ ...wizard, step: (wizard.step + 1) as 0 | 1 | 2 }); else { setWizard(null); setReview({ moment: "campaign", provider: wizard.provider }); }
    };
    return (
      <Page title={pageTitle} back={() => setWizard(null)} testId="swap">
        <Wizard step={wizard.step} provider={wizard.provider} facts={f} ctx={ctx} introSeen={!!protection.introSeenAt} lintItems={lintItems} onAck={ack} destAck={destAck} onDestAck={() => setDestAck(true)} destCheck={destCheck} chain={chain} tier={tier} masterSeed={masterSeed} deployment={deployment} onNext={next} onBack={() => setWizard(null)} />
      </Page>
    );
  }

  const viewed = campaignView ? campaignById(campaignView) : null;
  if (viewed) {
    return (
      <Page title={pageTitle} back={() => setCampaignView(null)} testId="swap">
        <Card>
          <CampaignProgress campaign={viewed} advanced={advanced} onPause={() => pauseCampaign(viewed.id)} onResume={() => resumeCampaign(viewed.id)} onCancel={() => cancelCampaign(viewed.id)} onReviewReroute={() => setReview({ moment: "reroute", campaignId: viewed.id })} onBack={() => setCampaignView(null)} />
        </Card>
      </Page>
    );
  }

  // ---- the form, the quote, the order
  const fromOptions: AssetOption[] = assets.map((a) => ({ id: a.vault, symbol: a.symbol, name: a.symbol, decimals: a.decimals, ...(a.token ? { address: a.token } : {}) }));
  const toOptions: AssetOption[] = Object.values(TARGETS).map((x) => ({ id: x.id, symbol: x.ref.symbol, name: x.network, decimals: x.ref.decimals, chain: x.network }));
  const checks: AddressCheck[] = [
    { label: t("checks.validAddress"), state: !destination.trim() ? "idle" : destinationError ? "fail" : "ok" },
    { label: t("checks.correctNetwork"), state: !destination.trim() ? "idle" : otherChain && otherChain !== chain ? "fail" : "ok", ...(otherChain && otherChain !== chain ? { detail: t("checks.chainDetected", { chain: otherChain }) } : {}) },
    { label: t("checks.tokenSupported"), state: "ok" },
    { label: t("checks.formatValid"), state: !destination.trim() ? "idle" : destinationError ? "fail" : "ok" },
  ];
  const usdPerUnitOf = (): { from: number; to: number } | null => {
    const from = availablePrice(priceStore.state().prices, fromAsset.symbol);
    const toPrice = availablePrice(priceStore.state().prices, to.ref.symbol);
    return from && toPrice ? { from: Number(from.usd1e8) / 1e8 / 10 ** fromAsset.decimals, to: Number(toPrice.usd1e8) / 1e8 / 10 ** to.ref.decimals } : null;
  };
  const quoteView: QuoteView | null = chosen && chosenQuote ? {
    pay: `${formatAmount(fromAsset, units)} ${fromAsset.symbol}${usd !== null ? ` · ≈ ${formatUsd(usd)}` : ""}`, receive: `≈ ${fmtUnits(chosenQuote.toAmount, to.ref.decimals)} ${to.ref.symbol}`, minimum: `≈ ${fmtUnits(chosenQuote.toAmountMin, to.ref.decimals)} ${to.ref.symbol}`,
    fees: feeSummary(chosenQuote), time: `~${hours(chosenQuote.etaSeconds)}${policy !== "fastest" ? t("swap.afterFunding") : ""}`, protection: levelOf(chosen.components.privacy) === "Reduced" ? "Reduced" : "High", route: advanced ? `${t("swap.bestRoute")} · ${chosen.provider}` : t("swap.bestProtectedRoute"),
  } : null;
  const swapFeeView = chosenQuote && order === null ? swapFees({ amount: units, terms: funding && funding.amount === units ? funding.terms : { minimum: 0n, feePercentBps: 0 }, executorTip: BigInt(quotes?.executorTip ?? "0"), toAmount: BigInt(chosenQuote.toAmount), toAmountMin: BigInt(chosenQuote.toAmountMin), providerUsd: chosenQuote.fees?.reduce((s, f) => s + (f.usd ?? 0), 0) || null, networkUsd: null, unvalued: feeSummary(chosenQuote), usdPerUnit: usdPerUnitOf(), formatFrom: (u) => `${formatAmount(fromAsset, u)} ${fromAsset.symbol}`, formatTo: (u) => `${fmtUnits(u, to.ref.decimals)} ${to.ref.symbol}`, formatUsd: (x) => formatUsd(x), t }) : null;
  const crossChain = to.ref.chain !== refOf(fromAsset).chain;
  const routeHealthy = chosen ? providerHealthy(quotes?.risk?.[chosen.provider]).ok : false;

  return (
    <Page title={pageTitle} back={onBack} testId="swap" primaryAction={quotes && chosen && !order ? <Button size="lg" full onClick={() => startCommit(chosen.provider)} disabled={!!busy || blocked || (destinationLocked && !campaignMode)} title={blocked ? t("send.acknowledgeFirst") : destinationLocked && !campaignMode && destCheck ? destinationStatusWords(t, destCheck) : undefined} data-testid="swap-review">{t("swap.reviewSwap")}</Button> : !order ? <Button size="lg" full onClick={() => void getQuotes()} disabled={!!busy || !destination || units <= 0n || !!destinationError} data-testid="swap-quote">{t("swap.getQuote")}</Button> : undefined}>
      <div className="ds-stack">
        {!order ? (
          <>
            <Card padding="none">
              <ListRow title={t("swap.from")} subtitle={`${fromAsset.symbol} · ${t("swap.fromProtected", { symbol: fromAsset.symbol })}`} onPress={assets.length > 1 ? () => setPickingFrom(true) : undefined} trailing={assets.length > 1 ? <span className="ds-kv-label">{t("protect.change")}</span> : null} testId="swap-from" />
              <div className="ds-swap-arrow" aria-hidden>↓</div>
              <ListRow title={t("swap.to")} subtitle={`${to.ref.symbol} · ${to.network}`} onPress={() => setPickingTo(true)} trailing={<span className="ds-kv-label">{t("protect.change")}</span>} testId="swap-to" />
            </Card>
            <AmountInput id="swap-amount" label={t("swap.amount")} asset={fromAsset} value={amount} onChange={(v) => { setAmount(v); setQuotes(null); reset(); }} usd={usd !== null ? `≈ ${formatUsd(usd)}` : null} testId="swap-amount"
              hint={units > 0n && !isBucketFor(fromAsset, units) ? <>{t("send.exactFingerprint")} {bucket ? <button type="button" className="ds-chip" onClick={() => { setAmount(formatAmount(fromAsset, bucket)); setQuotes(null); reset(); }} data-testid="swap-use-bucket">{t("swap.useBucket", { amount: formatAmount(fromAsset, bucket), symbol: fromAsset.symbol })}</button> : t("swap.chooseLarger")}</> : undefined} />
            {assessment && assessment.tier !== "standard" ? <p className="ds-note-warn" data-testid="swap-large">{assessment.failSafe ? t("swap.largeFailSafe") : `${tierLabel[assessment.tier]}: `}{t("swap.largeNotice")}</p> : null}
            <AddressInput id="swap-destination" label={destinationEdited ? t("swap.receiveAtOwn") : t("swap.receiveAtFresh")} value={destination} onChange={changeDestination} checks={checks} error={destinationError || undefined} placeholder={t("swap.destinationPlaceholder")} pasteLabel={t("send.paste")} testId="swap-destination"
              status={destinationEdited ? (
                <>
                  <p className="ds-note">{t("send.neverPublicWallet")} <button type="button" className="ds-chip" onClick={takeFresh} data-testid="swap-use-fresh">{t("send.useFresh")}</button></p>
                  {parsedDestination?.ok ? <DestinationStatus chain={chain} address={destination} tier={tier} masterSeed={masterSeed} deployment={deployment} asset={to.ref.symbol} /> : null}
                </>
              ) : null} />
            {destinationError ? <p className="ds-field-error" data-testid="destination-error">{destinationError}</p> : null}
            <p className="ds-note">{window[1] === 0 ? t("swap.fundedNoDelay") : t("swap.fundedWithin", { lo: hours(window[0]), hi: hours(window[1]) })}</p>
            {busy ? <p className="ds-note" data-testid="swap-busy">{busy}</p> : null}
            {error ? <p className="ds-note-warn" data-testid="swap-error">{error}</p> : null}
          </>
        ) : null}

        {quotes && !order ? (
          <div className="ds-stack" data-testid="quote-section">
            {chosen && chosenQuote && quoteView ? (
              <>
                <QuoteCard quote={quoteView} labels={{ pay: t("swap.youPay"), receive: t("swap.youReceive"), minimum: t("swap.minimum"), fees: t("swap.fees"), time: t("swap.time"), protection: t("swap.protection") }} onCompare={advanced ? () => setCompare(true) : undefined} compareLabel={t("swap.compareRoutes")} />
                {swapFeeView ? <FeeSummary receive={swapFeeView.receive} pay={swapFeeView.pay} total={swapFeeView.total} lines={swapFeeView.lines} totalLabel={t("fees.total")} detailsLabel={t("fees.viewDetails")} testId="swap-fees" /> : null}
                <div className="ds-kv"><span className="ds-kv-label">{t("swap.privacy")}</span><span className={`ds-level ds-level-${levelOf(chosen.components.privacy)}`} data-testid="swap-privacy">{levelOf(chosen.components.privacy)}</span></div>
                {crossChain ? <div className="ds-checks-line" data-testid="cross-chain-checklist"><span data-check="source" data-ok="1">✓ {t("swap.sourceIsolated")}</span><span data-check="destination" data-ok={!destinationEdited || (destCheck?.verified ?? false) ? "1" : "0"}>{!destinationEdited || (destCheck?.verified ?? false) ? "✓" : "⚠"} {t("swap.destinationVerified")}</span><span data-check="route" data-ok={routeHealthy ? "1" : "0"}>{routeHealthy ? "✓" : "⚠"} {t("swap.routeHealthy")}</span></div> : null}
                {campaignMode && protectionPlan ? (() => { const cap = lineDraft ? BigInt(lineDraft.bounds.maxExternalExposure) : (units * BigInt(protectionPlan.capBps)) / 10000n; const piece = lineDraft ? lineDraft.tranches.reduce((m, x) => (BigInt(x.amount) > m ? BigInt(x.amount) : m), 0n) : (units * BigInt(protectionPlan.bandBps[1])) / 10000n; const steps = lineDraft ? lineDraft.tranches.length : protectionPlan.estimatedTranches; return (
                  <p className="ds-note-warn" data-testid="protection-line">{t("swap.protectionLine", { steps, piece: usdOfUnits(ctx, piece) ?? `${formatAmount(fromAsset, piece)} ${fromAsset.symbol}`, concurrency: protectionPlan.concurrency === "sequential" ? t("swap.oneAtATime") : t("swap.upToAtATime", { n: protectionPlan.maxParallel }), cap: usdOfUnits(ctx, cap) ?? `${formatAmount(fromAsset, cap)} ${fromAsset.symbol}`, duration: durationWords(protectionPlan.estimatedSeconds) })}</p>
                ); })() : null}
                {protectionPlan && !protection.enabled && controls.campaign ? <p className="ds-note-warn" data-testid="protection-off">{t("swap.protectionOff")}</p> : null}
                {quotedOnly === 1 ? <p className="ds-note-warn">{t("swap.onlyOneQuoted")}</p> : null}
                <DestinationCard network={to.network} asset={to.ref.symbol} address={destination} amount={fmtUnits(chosenQuote.toAmount, to.ref.decimals)} kind={destinationEdited ? "entered" : "fresh"} />
                {lintItems ? <PrivacyLint items={lintItems} onAcknowledge={ack} /> : null}
                {advanced ? <CompareRoutes open={compare} onClose={() => setCompare(false)} quotes={quotes} to={to.ref} advanced={advanced} onUse={(p) => startCommit(p)} busy={!!busy} /> : null}
              </>
            ) : (
              <p className="ds-note" data-testid="no-route">{t("swap.noRoute")}{Object.keys(quotes.errors).length ? ` (${Object.values(quotes.errors).join("; ")})` : "."}</p>
            )}
          </div>
        ) : null}

        {!order && activeCampaigns().length > 0 ? (
          <Card testId="protected-swaps">
            <p className="ds-kv-label">{t("swap.yourProtectedSwaps")}</p>
            {activeCampaigns().map((c) => (
              <ListRow key={c.id} title={`${c.request.from.symbol} → ${c.request.to.symbol}`} subtitle={`${progressLine(c, advanced)} · ${c.state}`} trailing={<Button variant="secondary" onClick={() => setCampaignView(c.id)}>{t("swap.open")}</Button>} />
            ))}
          </Card>
        ) : null}
        {!order && openSwaps.length > 0 ? (
          <Card testId="open-swaps">
            <p className="ds-kv-label">{t("swap.yourOpenSwaps")}</p>
            {openSwaps.map((s) => {
              const a = assetOf(s);
              return (
                <ListRow key={s.orderId} title={`${formatAmount(a, BigInt((s.params as { amount: string }).amount))} ${a.symbol} → ${(s.request as { to: { symbol: string } }).to.symbol}`} subtitle={`${s.state}${s.dueAt && !s.fundedTx ? ` · ${t("swap.fundingAt", { time: formatDateTime(s.dueAt) })}` : ""}`}
                  trailing={<span className="ds-actions"><Button variant="secondary" onClick={() => void resume(s)} disabled={!!busy}>{t("swap.open")}</Button>{!s.fundedTx ? <TextButton onClick={() => abandonSwap(s.orderId)}>{t("swap.abandon")}</TextButton> : null}</span>} />
              );
            })}
          </Card>
        ) : null}

        {order ? (
          <>
            {busy ? <p className="ds-note" data-testid="swap-busy">{busy}</p> : null}
            {error ? <p className="ds-note-warn" data-testid="swap-error">{error}</p> : null}
            <OrderPanel order={order} stored={stored} orderAsset={orderAsset} target={orderTarget(stored, to, TARGETS)} destination={String((stored?.request as { destination?: string } | undefined)?.destination ?? destination)} destinationEdited={destinationEdited} orderKeyAddress={orderKey?.address} job={job} tracked={tracked} record={record} signed={signed} checked={checked} moved={moved} refundLine={refundLine} signLint={signLint} advanced={advanced} busy={busy} submission={submission} holdActive={holdActive} canExport={executeControls.export}
              onFundNow={() => void fundNow()} onSign={(acceptMin) => void signAndHand(acceptMin)} onReturn={() => void returnToBalance()} onExport={() => stored && downloadText(`privacy-wallet-order-${stored.orderId.slice(2, 10)}.json`, exportOrderReview(stored, { lint: signLint }))} onMonitor={() => setTick((n) => n + 1)} />
            <TextButton onClick={() => { reset(); setQuotes(null); }} data-testid="swap-new">{t("swap.newSwap")}</TextButton>
          </>
        ) : null}
      </div>
      <AssetSelector open={pickingFrom} onClose={() => setPickingFrom(false)} assets={fromOptions} value={fromAsset.vault} onChange={(id) => { const a = assets.find((x) => x.vault === id); if (a) { setFromAsset(a); setAmount(""); setQuotes(null); reset(); } setPickingFrom(false); }} title={t("swap.from")} searchLabel={t("protect.search")} testId="swap-from-selector" />
      <AssetSelector open={pickingTo} onClose={() => setPickingTo(false)} assets={toOptions} value={target} onChange={(id) => { if (TARGETS[id]) chooseTarget(id); setPickingTo(false); }} title={t("swap.to")} searchLabel={t("protect.search")} testId="swap-to-selector" />
    </Page>
  );
}

export const swapTierOf = (a: Tier, b: Tier): Tier => higherTier(a, b);
export { maximumLossModel, liveQuotesOf };
export type { ServiceOrder as SwapOrder, Address as EvmAddress };
