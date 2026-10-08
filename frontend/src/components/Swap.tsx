import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { formatUsd, higherTier, TIERS, tierLabel, type Tier } from "@ref/wallet/valuation";
import { levelOf } from "@ref/wallet/privacyCenter";
import { parseDestination } from "@ref/wallet/destinations";
import { unacknowledgedBlocks, type LintId } from "@ref/wallet/privacyLint";
import { feeSummary, planLabel, swapService, type AssetRef, type ExecutionPlan, type Policy, type QuoteSet, type RouteScore, type ServiceOrder } from "../sdk/swapService";
import { commitOrder, handOverSigned, prepareAndSign, resumeOrder, returnOrderToBalance, type Signed } from "../sdk/swapExecute";
import { controlsFor, exportOrderReview, IMPACT_CAP_BPS, issuerLine, planWords, REVIEW_HOLD_MINUTES, routeKind } from "../sdk/tiers";
import { downloadText } from "../sdk/download";
import { feedsConfigured } from "../sdk/prices";
import { Review, type ReviewLine } from "./Review";
import { trackOrder, type Tracked } from "../sdk/orderTracker";
import { SettlementLine } from "./SettlementLine";
import { useAiSession } from "../zkapi/aiSession";
import { checkTrade, tradeSummary } from "../zkapi/tradeCheck";
import type { LintItem } from "@ref/wallet/privacyLint";
import { deriveOrderKey } from "../keys/swapKeys";
import type { CheckedCall, MinimumMoved } from "../sdk/providerCall";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { recoverSwapRefunds } from "../sdk/privateTx";
import type { Deployment } from "../sdk/chain";
import { assetByVault, assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "../sdk/assets";
import { relayerInfo, relayerSwapStatus, swapJobStatus, type SwapJob } from "../sdk/relayer";
import { fmtUnits } from "../sdk/format";
import { DELAY_WINDOW, policyFromPreference } from "../sdk/policy";
import { priceStore } from "../sdk/prices";
import { holdersAbove } from "../sdk/poolDeposits";
import { abandonSwap, assetOfStored, fundEscrow, isOpenSwap, patchSwap, swapFactoryOf } from "../sdk/swapFunding";
import { useSettings } from "../wallet/settings";
import { session, useSession } from "../wallet/session";
import type { StoredSwap } from "../wallet/journal";
import { activityId, recordActivity } from "../wallet/activity";
import { topBucket, walletLint } from "../wallet/lintFacts";
import { completeAction } from "../wallet/schedule";
import { AssetSelect } from "./AssetSelect";
import { DestinationCard } from "./DestinationCard";
import { PrivacyLint } from "./PrivacyLint";
import { Scorecard } from "./Scorecard";
import { CampaignProgress } from "./protection/CampaignProgress";
import { maximumLossModel, type DestinationPolicy } from "@ref/wallet/campaign";
import { acceptReroute, activeCampaigns, buildCampaign, campaignById, cancelCampaign, pauseCampaign, progressLine, resumeCampaign, startCampaign } from "../wallet/campaigns";
import { crossRateFromPrices } from "../wallet/campaignRunner";
import type { Protection, ProviderRiskView } from "../sdk/swapService";
import type { MaximumLoss, ProtectionDetails, Verdict } from "./Review";

// Private swap (spec v1.1, plan §22, §26–§31, §36, §47, §79; whale spec §23): quote every provider through
// the local service, show ONE route in plain words — "Best route: Automatic", the privacy, price and time
// levels; providers only behind "Route details" — commit an order whose source is a one-time escrow and
// whose destination is a fresh address of this wallet, FUND the escrow with a private withdrawal (ETH or
// an ERC-20 from its own vault) at a random time inside the policy's delay window (the order and its
// schedule live in the encrypted journal; the App-level scheduler fires it from any tab), then re-quote
// with the escrow as sender, sign the provider call with the one-time key and hand it to a relayer's
// executor, which deploys + executes for its tip and refunds to the pre-committed note after the window.
// If the signed quote expires before execution, sign again. The permanent address never touches a
// provider. The trade preference lives in Settings (never here, never on chain); the service derives the
// policy from it and the value tier. Before the order key signs, the wallet reads the provider call itself
// (sdk/providerCall.ts): pinned contract, your fresh address as receiver, refunds to the escrow, and a
// minimum no lower than the one you approved — a lower one needs your fresh consent.
const TARGETS: Record<string, { ref: AssetRef; network: string }> = {
  BTC: { ref: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, network: "Bitcoin" },
  SOL: { ref: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" }, network: "Solana" },
  "USDC on Base": { ref: { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }, network: "Base" },
  "ETH on Base": { ref: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" }, network: "Base" },
};
const fmt = (units: string, decimals: number) => fmtUnits(units, decimals); // from base units, never through a float
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const OPEN_FOR_RESIGN = ["expired", "execute-failed", "refund-only"];
/** A funded order can still be returned unexecuted while no execution is running or settled. */
const CAN_RETURN = (job: SwapJob | null) => !job || ["waiting-funding", "expired", "execute-failed"].includes(job.state);
const risk = (security: number) => (security >= 85 ? "Low" : security >= 70 ? "Medium" : "High");
const settlement = (p: string) => (p === "thorchain" || p === "chainflip" ? "native deposit address" : p === "near-intents" ? "solver network" : p === "mayan" ? "signed intent (drivers compete)" : "aggregator / bridge");
const providerKind = (p: string): "deposit-address" | "signed-intent" | "aggregator-api" => (p === "thorchain" || p === "chainflip" || p === "near-intents" ? "deposit-address" : p === "mayan" ? "signed-intent" : "aggregator-api");
const refOf = (a: Asset): AssetRef => ({ chain: "ethereum", asset: a.token ?? "native", decimals: a.decimals, symbol: a.symbol });
const asTier = (t: unknown): Tier | null => (TIERS.includes(t as Tier) ? (t as Tier) : null);
/** A provider call this wallet checked, signed and simulated (sdk/swapExecute.ts Signed) — kept here until the user confirms (the Review at the execute moment) or handed over at once. */
type ReviewState = { moment: "commit"; provider?: string } | { moment: "execute"; signed: Signed } | { moment: "campaign"; provider: string } | { moment: "reroute"; campaignId: string };
const CUSTODY_WORDS: Record<string, string> = { "tss-vaults": "threshold-signed vaults", "mpc-vault": "an MPC vault", "relayer-bridge": "a relayer bridge", cctp: "Circle's CCTP attestation", solver: "solver execution", aggregator: "an aggregator over bridges", intent: "an intent network", contract: "an on-chain contract", counterparty: "a counterparty" };
const GATE_WORDS: Record<string, string> = { source: "settled at the source", "destination-submitted": "settled once the destination transaction is sent", "destination-final": "settled once the destination is final" };

export function Swap({ masterSeed, deployment, account = null }: { masterSeed: Uint8Array; deployment: Deployment | null; /** the connected public wallet, if any: a destination equal to it is flagged */ account?: string | null }) {
  const { submission, advanced, preference, verifyReads, secondFactor, protection } = useSettings();
  useSession(); // re-render when the journal-backed session changes
  const assets = assetsOf(deployment);
  const [fromAsset, setFromAsset] = useState(assets[0]);
  const [target, setTarget] = useState("BTC");
  const [amount, setAmount] = useState("0.5");
  const [destination, setDestination] = useState(() => peekFreshAddress(masterSeed, "bitcoin").address);
  const [destinationEdited, setDestinationEdited] = useState(false);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [showRoute, setShowRoute] = useState(false);
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
  const [routeAck, setRouteAck] = useState(false);
  const [destAck, setDestAck] = useState(false);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  // V3 (High-Value Protection spec §15): the wizard before a protected execution, the campaign shown, the relayer's fee for the preparation line
  const [wizard, setWizard] = useState<{ provider: string; step: 0 | 1 | 2 } | null>(null);
  const [campaignView, setCampaignView] = useState<string | null>(null);
  const [relayerFee, setRelayerFee] = useState<bigint | null>(null);

  const to = TARGETS[target];
  const units = parseAmount(fromAsset, amount);
  const bucket = bucketBelowFor(fromAsset, units);
  // a typed destination is parsed for the destination chain (whale spec §21): another chain's address is refused by name
  const parsedDestination = destinationEdited ? parseDestination(chainKindOf(to.ref.chain), destination) : null;
  const destinationError = parsedDestination && !parsedDestination.ok ? parsedDestination.reason : "";
  // a piece above the common sizes: how many holders could pay it, from the pool's public deposits (on this input, never at launch)
  useEffect(() => {
    if (!deployment || units <= topBucket(fromAsset.decimals)) { setHolders(null); return; }
    let live = true;
    holdersAbove(deployment, fromAsset.vault, units).then((h) => { if (live) setHolders(h); }).catch(() => { if (live) setHolders(null); });
    return () => { live = false; };
  }, [deployment, units, fromAsset]);
  // the value tier (whale spec §13): the wallet's own assessment is a hint the service can only raise; the fail-safe is at least high-value
  // (a network without feeds has no USD and no tiers; a missing price on a network with feeds is the fail-safe)
  const priced = feedsConfigured(deployment);
  const assessment = units > 0n && priced ? priceStore.assess(units, fromAsset) : null;
  const usd = assessment && "usd" in assessment.value ? assessment.value.usd : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  useEffect(() => { if (priced) void priceStore.refresh(deployment); }, [deployment, priced]); // a read only with unspent notes (the store checks)
  /** the policy the service scored under (its tier override applied), or the preference's own before a quote */
  const policy: Policy = quotes?.policy ?? policyFromPreference(preference);
  const request = () => ({ from: refOf(fromAsset), to: to.ref, amount: units.toString(), destination, slippageBps: 50, preference, ...(assessment ? { tier: assessment.tier } : {}), destinationKind: (destinationEdited ? "entered" : "fresh") as "entered" | "fresh", preferNative: preference === "native", mode: protection.mode });
  const openSwaps = session.isUnlocked() ? session.journal().swaps.filter((x) => isOpenSwap(x) && !x.campaign) : [];
  const assetOf = (s: StoredSwap): Asset => assetOfStored(deployment, s);

  function chooseTarget(t: string) {
    setTarget(t); setQuotes(null); reset();
    if (!destinationEdited) setDestination(peekFreshAddress(masterSeed, chainKindOf(TARGETS[t].ref.chain)).address);
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setError("");
    try { return await fn(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(""); }
  }

  // settlement tracking (whale spec §19): the journal, the executor's job, the escrow balance and the destination tracker,
  // derived into the spec's state every 15 s while the order is open on this screen; every transition is journaled
  const trackedOrderId = stored?.orderId;
  useEffect(() => {
    if (!trackedOrderId) { setTracked(null); return; }
    let live = true;
    const tick = async () => {
      const current = session.isUnlocked() ? session.journal().swaps.find((x) => x.orderId === trackedOrderId) : undefined;
      if (!current) return;
      try {
        const r = await trackOrder(current, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null });
        if (!live) return;
        setTracked(r.tracked);
        if (r.job) { setJob(r.job); setStored((s) => (s && s.orderId === trackedOrderId ? { ...s, state: r.job!.state, ...(r.job!.executionTx ? { executionTx: r.job!.executionTx } : {}) } : s)); }
      } catch { /* the next tick */ }
    };
    void tick();
    const t = setInterval(() => { if (!tracked || !["COMPLETED", "REFUNDED", "CANCELLED", "EXPIRED"].includes(tracked.state)) void tick(); }, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [trackedOrderId, deployment, submission]);

  // the executor re-shielded the order: its refund note goes into the wallet now, not at the next rescan (PP-S09)
  useEffect(() => {
    if (job?.state !== "refunded" || !deployment || !stored) return;
    let live = true;
    const orderId = stored.orderId.toLowerCase();
    recoverSwapRefunds({ masterSeed, deployment })
      .then((rs) => {
        if (!live) return;
        const mine = rs.filter((r) => r.orderId.toLowerCase() === orderId);
        const amount = (r: (typeof rs)[number]) => { const a = assetByVault(deployment, r.note.vaultId); return a ? `${formatAmount(a, r.note.amount)} ${a.symbol}` : `${r.note.amount} base units`; };
        for (const r of mine) {
          const a = assetByVault(deployment, r.note.vaultId);
          recordActivity({ id: activityId("refund", `${orderId}:${r.leafIndex}`), kind: "refund", asset: a?.symbol ?? "units", decimals: a?.decimals ?? 0, amount: r.note.amount.toString(), status: "completed", ref: stored.orderId, note: "a swap returned to your private balance" });
        }
        setRefundLine(mine.length ? `Refunded: ${mine.map(amount).join(" + ")} back in your private balance.` : "Refunded on chain; the refund is not in the pool view yet. Rescan under Home → Details shortly.");
      })
      .catch((e) => live && setRefundLine(`Refunded on chain; recording the note failed (${e?.message ?? e}). Rescan under Home → Details.`));
    return () => { live = false; };
  }, [job?.state, stored?.orderId, deployment]);

  function reset() { setOrder(null); setStored(null); setOrderKey(null); setRefundNoteData(null); setSigned(null); setChecked(null); setMoved(null); setJob(null); setShowRoute(false); setRefundLine(""); setReview(null); setRouteAck(false); setDestAck(false); }
  function patchStored(orderId: string, patch: Partial<StoredSwap>) {
    patchSwap(orderId, patch);
    setStored((s) => (s && s.orderId.toLowerCase() === orderId.toLowerCase() ? { ...s, ...patch } : s));
  }

  async function getQuotes() {
    reset();
    const set = await run("Finding the best route…", () => swapService.quote(request()));
    if (set) setQuotes(set);
  }

  async function commit(provider?: string) {
    let factory: Address;
    try { factory = swapFactoryOf(deployment); } catch (e: any) { setError(e.message); return; }
    void factory;
    const shown = quotes?.quotes.find((q) => q.provider === (provider ?? quotes.chosen?.provider)); // the minimum the user saw and approved
    const dest = destinationEdited ? destination : consumeFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address; // reserve the fresh address now
    const req = { ...request(), destination: dest };
    const committedLint = lintItems, competition = quotes?.competition;
    // institutional (spec §24): the funding is scheduled no earlier than the review hold, whatever the policy's window drew
    const reviewHoldUntil = controls.reviewHold ? Date.now() + REVIEW_HOLD_MINUTES * 60_000 : undefined;
    const res = await run("Committing the order…", () => commitOrder({ masterSeed, deployment, request: req, policy, provider, fromAsset, shown, competition, lint: committedLint, preference, walletTier: assessment ? tier : null, schedule: { reviewHoldUntil } }));
    if (!res) return;
    reset();
    setOrder(res.order); setStored(res.stored); setOrderKey(res.key); setRefundNoteData(res.refund.noteData);
    if (!destinationEdited) setDestination(dest);
  }

  /** Resume an order from the journal after a reload: the service rebuilds it from the same params (same escrow). */
  async function resume(s: StoredSwap) {
    const order = await run("Resuming the order…", () => resumeOrder(deployment, s));
    if (!order) return;
    reset();
    setOrder(order); setStored(s); setOrderKey(deriveOrderKey(masterSeed, s.attemptId as Hex)); setRefundNoteData((s.refundNoteData as Hex | undefined) ?? null);
    if (s.jobId && submission.kind === "relayer") relayerSwapStatus(submission.url, s.jobId).then(setJob).catch(() => {});
  }

  /** The commit moment: the Review from the enhanced tier (spec §24), one tap below it. */
  function startCommit(provider?: string) {
    if (campaignMode && protectionPlan) { setRouteAck(false); setDestAck(false); setWizard({ provider: provider ?? protectionPlan.provider, step: 0 }); return; }
    if (controls.review) { setRouteAck(false); setDestAck(false); setReview({ moment: "commit", provider }); return; }
    void commit(provider);
  }

  async function fundNow() {
    if (!stored) return;
    const w = await run("Private withdrawal to the one-time escrow…", async () => {
      const r = await fundEscrow({ masterSeed, deployment, stored, onStatus: setBusy });
      setStored((s) => (s ? { ...s, fundedTx: r.txHash, state: "funded" } : s));
      return r;
    });
    if (w) completeAction(`fund-escrow:${stored.orderId}`);
  }

  /**
   * Return a funded order to the private balance without executing it: hand the executor a refund-only
   * job (the journaled params and refund payload, no signature), which re-shields the escrow's balance as
   * the committed note once the window opens. For a call this wallet refused, a minimum the user does not
   * accept, or simply a change of mind; signing a fresh quote later still replaces it.
   */
  async function returnToBalance() {
    if (!order || !stored || !refundNoteData) return;
    const j = await run("Handing the refund to the relayer's executor…", () => returnOrderToBalance({ deployment, stored, submission }));
    if (!j) return;
    setMoved(null); setJob(j);
    setStored((x) => (x && x.orderId.toLowerCase() === order.orderId.toLowerCase() ? { ...x, jobId: j.id, state: j.state } : x));
  }

  /**
   * Re-quote with the escrow as sender, check the provider call, sign it locally and simulate the execution on
   * every RPC endpoint (whale spec §24). The signature stays here until it is handed over. `acceptMin`: the user
   * consented to a lower minimum than approved.
   */
  async function prepareSigned(acceptMin?: bigint): Promise<Signed | { moved: MinimumMoved } | undefined> {
    if (!order || !orderKey || !refundNoteData) return;
    if (!stored) { setError("This order is not in this wallet's journal, so its provider call cannot be checked; it is not signed."); return; }
    const r = await run("Re-quoting with the escrow as sender, then checking the call…", () => prepareAndSign({ masterSeed, deployment, stored, order, submission, acceptMin, onStatus: setBusy }));
    if (!r) return;
    const current = session.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
    if (current) setStored(current);
    if (!("moved" in r)) setChecked(r.call);
    return r;
  }

  /** Hand a checked, signed and simulated execution to the service (finalize) and the relayer's executor. */
  async function handOver(s: Signed) {
    if (!order || !refundNoteData || !stored) return;
    const r = await run("Handing the signed order to the relayer's executor…", () => handOverSigned({ deployment, stored, order, signed: s, submission }));
    if (!r) return;
    const current = session.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
    if (current) setStored(current);
    setReview(null); setMoved(null); setSigned(s.label); if (r.job) setJob(r.job);
  }

  /** The execute moment: prepare, check, sign, simulate; then the Review (from the enhanced tier) or the hand-over at once. */
  async function signAndHand(acceptMin?: bigint) {
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
  /** V3 (High-Value Protection spec §14): a protected execution from high-value, or at enhanced when the service says `staged`; the service's recommendation is advice, the wallet keeps its own bounds */
  const protectionPlan: Protection | null = quotes?.protection ?? null;
  const campaignMode = !!protectionPlan && (controls.campaign || (tier === "enhanced" && protectionPlan.staged));
  const usdPer = usd !== null && units > 0n ? usd / (Number(units) / 10 ** fromAsset.decimals) : null;
  const usdOf = (x: bigint): string | null => (usdPer === null ? null : formatUsd(usdPer * (Number(x) / 10 ** fromAsset.decimals), { compact: true }));
  const amountWords = (x: bigint): string => `${formatAmount(fromAsset, x)} ${fromAsset.symbol}${usdOf(x) ? ` (≈ ${usdOf(x)})` : ""}`;
  const durationWords = (seconds: number): string => (seconds >= 2 * 86400 ? `${Math.round(seconds / 86400)} days` : seconds >= 3600 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 60)} min`);
  useEffect(() => { if (review?.moment === "campaign" && submission.kind === "relayer") relayerInfo(submission.url).then((i) => setRelayerFee(BigInt(i.minFeeWei))).catch(() => setRelayerFee(null)); }, [review?.moment, submission]);
  const funded = !!stored?.fundedTx;
  const dueAt = stored?.dueAt;
  const orderAsset = stored ? assetOf(stored) : fromAsset;
  const window = DELAY_WINDOW[policy];
  /** the order's tier as journaled at commit (the execute moment follows it, not today's price) */
  const storedTier: Tier = asTier(stored?.tier) ?? tier;
  const executeControls = controlsFor(storedTier);
  const holdActive = !!stored?.reviewHoldUntil && stored.reviewHoldUntil > Date.now();
  const quotedOnly = quotes?.competition ? quotes.competition.filter((c) => c.outcome === "quoted").length : undefined;
  const lintInput = { tier: assessment?.tier ?? ("standard" as const), deployment, settings: { submission, verifyReads }, account, amount: units, decimals: fromAsset.decimals, amountIsBucket: isBucketFor(fromAsset, units), holders, acknowledged };
  // the privacy lint (whale spec §18) with the quote, and again with what the wallet read in the provider call
  const lintItems = quotes && chosen ? walletLint({ ...lintInput, action: "swap", destination, destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: chosen.provider, ...(campaignMode && protectionPlan ? { campaign: { sizing: protectionPlan.sizing, consecutiveSameSize: false, destinationPerTranche: !destinationEdited, cadenceFixed: false, destinationCooling: false } } : {}) }) : null;
  const signLint = checked && stored ? walletLint({ ...lintInput, action: "swap", destination: String((stored.request as { destination?: string })?.destination ?? destination), destinationKind: destinationEdited ? "entered" : "fresh", delaySeconds: window[0], quotes, chosenProvider: stored.provider, checked, approvedMin: stored.approvedMin ? BigInt(stored.approvedMin) : null }) : null;
  const blocked = lintItems ? unacknowledgedBlocks(lintItems).length > 0 : false;
  const ack = (id: LintId) => setAcknowledged((x) => [...x, id]);
  // "Check this trade" (whale spec §22): a sanitized summary to the private AI session the user opened; nothing else leaves
  const ai = useAiSession();
  const tradeCheckFor = (chosenProvider: string | undefined, quote: { plan?: ExecutionPlan; etaSeconds: number; impactBps?: number; nativeAssets: boolean; toAmountMin: string } | undefined, score: RouteScore | undefined, linkPublic: boolean | undefined, lintList: LintItem[] | null, amountUnits: bigint, t: AssetRef, plan: Protection | null = null) => ({
    available: !!ai.access,
    reason: ai.access ? undefined : "Start a private chat under Home → Details → Private AI to check this trade there.",
    run: async () => checkTrade(ai.access!, ai.model, tradeSummary({ from: { chain: "ethereum", symbol: fromAsset.symbol, decimals: fromAsset.decimals }, to: { chain: t.chain, symbol: t.symbol, decimals: t.decimals }, amountUnits, usd, tier, preference, chosen: chosenProvider && quote ? { provider: chosenProvider, score, quote, linkPublic } : null, competition: quotes?.competition ?? (stored?.competition as never) ?? null, lint: lintList, protection: plan })),
  });

  // ---- V3: the protected execution (High-Value Protection spec §14–§16) — the wizard, its Review, the start, the reroute Review
  /** The facts of the chosen route for the wizard and the Review (the service's risk view is advice; the wallet's own bounds come from buildCampaign). */
  function campaignFacts(provider: string) {
    const q = quotes!, p = protectionPlan!;
    const quote = q.quotes.find((x) => x.provider === provider)!;
    const score = q.scores.find((x) => x.provider === provider) ?? q.chosen!;
    const risk: ProviderRiskView | undefined = q.risk?.[provider];
    const destinationPolicy: DestinationPolicy = destinationEdited ? { kind: "entered", address: destination } : { kind: "fresh-per-tranche" };
    const draft = buildCampaign({ quotes: q, provider, from: refOf(fromAsset), fromAsset, to: to.ref, amount: units, tier, mode: protection.mode, preference, policy, destination: destinationPolicy, usd, capBps: protection.capBps, now: Date.now(), rng: () => 0.5 });
    const loss = maximumLossModel(draft);
    const steps = draft.tranches.length;
    const incidentDays = risk?.security.incidentList.map((i) => (Date.now() - Date.parse(i.date)) / 86_400_000).filter((d) => d >= 0) ?? [];
    const recent = incidentDays.some((d) => d <= 30), within90 = incidentDays.some((d) => d <= 90);
    const security = risk?.security.total ?? score.components.security;
    const reliability = risk?.reliability ?? score.components.reliability;
    const verdictSecurity: Verdict["security"] = security < 60 || reliability < 40 ? "Do not execute" : security < 70 || recent || reliability < 60 || p.thinMarket ? "Review" : "Safe to execute";
    const why = [`security ${security}/100 (${risk ? `baseline ${risk.security.baseline}, incidents ${risk.security.incidents}` : "from the route score"})`, `reliability ${reliability}/100`, incidentDays.length ? `${incidentDays.length} incident${incidentDays.length === 1 ? "" : "s"} on record, the latest ${Math.round(Math.min(...incidentDays))} days ago` : "no incident on record", p.thinMarket ? "thin market: pieces halved for impact" : `impact per step ${p.trancheImpactBps ?? "n/a"} bps`, within90 && !recent ? "an incident within 90 days narrows the band" : ""].filter(Boolean).join(" · ");
    const verdict: Verdict = { security: verdictSecurity, privacy: levelOf(score.components.privacy), why };
    const cadence = `${durationWords(p.cadenceSeconds[0])}–${durationWords(p.cadenceSeconds[1])} between steps, drawn at random`;
    const details: ProtectionDetails = { riskClass: p.riskClass + (p.flags.length ? ` + ${p.flags.join(", ")}` : ""), custody: CUSTODY_WORDS[p.custody] ?? p.custody, band: `${p.bandBps[0] / 100}–${p.bandBps[1] / 100} %`, cap: `${draft.plan.capBps / 100} %`, gate: GATE_WORDS[p.gate] ?? p.gate, steps: `${steps} (${p.concurrency === "sequential" ? "one at a time" : `up to ${p.maxParallel} at a time`})`, duration: `about ${durationWords(p.estimatedSeconds)}`, cadence, elpf: p.elpf.perCampaignUsd !== null ? `${formatUsd(p.elpf.perTrancheUsd ?? 0)} per step · ${formatUsd(p.elpf.perCampaignUsd)} per operation (prior ${(p.elpf.prior * 100).toFixed(1)} %)` : `prior ${(p.elpf.prior * 100).toFixed(1)} % per step`, concentration: p.concentration.singleVenue ? "single venue: only one provider quotes this size, so nothing is spread for appearance" : `${p.concentration.providers.length} venues; no provider above ${p.concentration.capBps / 100} % of the order`, alternative: (q.competition ?? []).find((c) => c.provider !== provider && c.outcome === "quoted")?.provider };
    const prep = relayerFee !== null ? `${steps} private withdrawals ≈ ${fmt((relayerFee * BigInt(steps)).toString(), 18)} ETH in relayer fees` : `${steps} private withdrawals (one per step) at the relayer's live fee`;
    const maximumLoss: MaximumLoss = { order: amountWords(loss.order), cap: amountWords(loss.cap), maxExposure: amountWords(loss.maxExposure), protected: amountWords(loss.protected), preparation: prep };
    return { quote, score, risk, p, draft, steps, verdict, details, maximumLoss, destinationPolicy };
  }

  /** The wizard (plan V3 §44 screen states): risk analysis → privacy analysis → destination check, then the Review. Nothing is journaled here. */
  function campaignWizard() {
    const w = wizard!;
    const f = campaignFacts(w.provider);
    const next = () => (w.step < 2 ? setWizard({ ...w, step: (w.step + 1) as 0 | 1 | 2 }) : (setWizard(null), setReview({ moment: "campaign", provider: w.provider })));
    const titles = ["Risk analysis", "Privacy analysis", "Destination check"];
    return (
      <div data-testid="campaign-wizard" data-step={w.step}>
        <div className="muted small">Protected execution · {titles.map((t, i) => <span key={t} className={i === w.step ? "level-Good" : i < w.step ? "level-Excellent" : "muted"}>{i < w.step ? "✓ " : ""}{t}{i < 2 ? " → " : ""}</span>)}</div>
        <h3 style={{ marginTop: 6 }}>{titles[w.step]}</h3>
        {w.step === 0 && (
          <div className="small" data-testid="wizard-risk">
            <div className="row"><span className="muted">Route</span><b>{w.provider} · class {f.p.riskClass}{f.p.flags.length ? ` (+ ${f.p.flags.join(", ")})` : ""} · {CUSTODY_WORDS[f.p.custody] ?? f.p.custody}</b></div>
            <div className="row"><span className="muted">Security</span><b>{f.verdict.security === "Safe to execute" ? "✓" : "⚠"} {f.verdict.security}</b></div>
            <div className="muted">{f.verdict.why}</div>
            <div className="row"><span className="muted">Steps</span><b>{f.steps} of {amountWords(BigInt(f.draft.tranches[0]?.amount ?? "0"))}{f.steps > 1 ? " or so" : ""}, {f.p.concurrency === "sequential" ? "one at a time" : `up to ${f.p.maxParallel} at a time`}, {GATE_WORDS[f.p.gate] ?? f.p.gate}</b></div>
            <div className="row"><span className="muted">At most at risk</span><b>{amountWords(maximumLossModel(f.draft).cap)} ({f.draft.plan.capBps / 100} % of the order)</b></div>
            <div className="row"><span className="muted">Expected loss per failure</span><b>{f.details.elpf}</b></div>
            <div className="row"><span className="muted">Concentration</span><b>{f.details.concentration}</b></div>
            {f.p.reasons.length > 0 && <ul className="muted" style={{ paddingLeft: 18, margin: "6px 0 0" }}>{f.p.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </div>
        )}
        {w.step === 1 && (
          <div className="small" data-testid="wizard-privacy">
            <div className="row"><span className="muted">Privacy</span><b className={`level-${f.verdict.privacy}`}>{f.verdict.privacy}</b></div>
            <p className="muted" style={{ margin: "4px 0" }}>What a protected execution reveals: {f.steps} fundings of one-time escrows over about {durationWords(f.p.estimatedSeconds)}, {f.details.cadence}; each step pays {destinationEdited ? "the address you entered" : "its own fresh address of this wallet"}. The pool side sees pieces of common sizes, never the whole.</p>
            {lintItems && <PrivacyLint items={lintItems} onAcknowledge={ack} />}
          </div>
        )}
        {w.step === 2 && (
          <div className="small" data-testid="wizard-destination">
            <DestinationCard network={to.network} asset={to.ref.symbol} address={destination} kind={destinationEdited ? "entered" : "fresh"} title={destinationEdited ? "Every step pays" : "The first step pays"} />
            <p className="muted" style={{ margin: "4px 0" }}>{destinationEdited ? "An entered address: every step pays this one address, which links the steps on the destination side. The format parses; check every group before you continue." : "Each step pays its own fresh address of this wallet, reserved when the step starts and never reused; the destinations do not link the steps."}</p>
            {destinationEdited && !destAck && <button className="tab" onClick={() => setDestAck(true)}>I checked every group</button>}
            {destinationEdited && destAck && <div className="level-Excellent">✓ checked</div>}
          </div>
        )}
        <div className="tabs" style={{ marginTop: 10 }}>
          <button className="primary" onClick={next} disabled={w.step === 2 && destinationEdited && !destAck} data-testid="wizard-next">{w.step < 2 ? "Continue" : "Continue to the review"}</button>
          <button className="tab" onClick={() => setWizard(null)}>Back</button>
        </div>
      </div>
    );
  }

  /** The Review before a protected execution (spec §15): the five lines plus Exposure and Security, the maximum-loss model, the combined verdict. */
  function campaignReview(provider: string) {
    const q = quotes!;
    const f = campaignFacts(provider);
    const dec = to.ref.decimals, sym = to.ref.symbol;
    const liveQuotes = q.competition ? q.competition.filter((c) => c.outcome === "quoted").length : q.quotes.length;
    const lines: ReviewLine[] = [
      { id: "price", label: "Price protected", ok: BigInt(f.quote.toAmountMin) > 0n, meaning: `every step must guarantee at least ${fmt(f.draft.bounds.minimumOutput, 18 + dec - fromAsset.decimals > 0 ? 18 : 18)} ${sym} per ${fromAsset.symbol} of the quote's minimum less ${0.5} %; a step below it pauses the operation` },
      { id: "route", label: "Route checked", ok: !controls.twoQuotes || liveQuotes >= 2 || routeAck, meaning: liveQuotes >= 2 ? `${liveQuotes} providers quoted this size` : "only one provider answered for this size; the route cannot be compared with another live quote", ...(controls.twoQuotes && liveQuotes < 2 ? { ack: { text: "I accept the single quote", done: routeAck, onAck: () => setRouteAck(true) } } : {}) },
      { id: "destination", label: "Destination verified", ok: !destinationEdited || (parsedDestination?.ok === true && destAck), meaning: destinationEdited ? "entered by hand: every step pays it; the format parses and you checked every group" : "a fresh address of this wallet per step, each used once" },
      { id: "slippage", label: "Slippage checked", ok: f.quote.impactBps === undefined || (f.p.trancheImpactBps ?? 0) <= IMPACT_CAP_BPS, meaning: f.p.trancheImpactBps !== null ? `impact per step ${f.p.trancheImpactBps} bps against a cap of ${IMPACT_CAP_BPS}` : "the provider gave no impact figure; the minimum bounds every step" },
      { id: "exposure", label: "Exposure bounded", ok: f.draft.plan.capBps <= 300, meaning: `at most ${amountWords(maximumLossModel(f.draft).cap)} outside your private balance and unsettled at once (${f.draft.plan.capBps / 100} %); ${f.p.concurrency === "sequential" ? "one step at a time" : `up to ${f.p.maxParallel} steps at a time`}; each step ${GATE_WORDS[f.p.gate] ?? f.p.gate}` },
      { id: "security", label: "Security assessed", ok: f.verdict.security !== "Do not execute", meaning: f.verdict.why },
      { id: "privacy", label: "Privacy reviewed", ok: !lintItems || unacknowledgedBlocks(lintItems).length === 0, meaning: "every privacy check is ok, a warning, or acknowledged" },
    ];
    const exportNow = () => downloadText(`privacy-wallet-protected-swap-review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify({ format: "privacy-protocol/protected-swap-review/v1", exportedAt: new Date().toISOString(), request: request(), tier, value: assessment?.value ?? null, plan: f.draft.plan, bounds: f.draft.bounds, pieces: f.draft.tranches.map((t) => t.amount), protection: f.p, risk: f.risk ?? null, quotes: q, lint: lintItems ?? null }, null, 2));
    return (
      <Review moment="campaign" tier={tier} controls={controls} usd={usd !== null ? formatUsd(usd) : null} amount={`${formatAmount(fromAsset, units)} ${fromAsset.symbol}`} from={`Private ${fromAsset.symbol}, in ${f.steps} steps`}
        to={{ network: to.network, asset: sym, address: destination, kind: destinationEdited ? "entered" : "fresh" }} receiveMin={`${fmt(f.quote.toAmountMin, dec)} ${sym} at today's minimum, pro rata per step`}
        execution={{ words: "Protected execution", detail: `${f.steps} steps · ${planWords(f.quote.plan).toLowerCase()} each`, eta: `about ${durationWords(f.p.estimatedSeconds)}` }}
        privacy={{ level: f.verdict.privacy, score: f.score.components.privacy }} lint={lintItems ?? []} onAcknowledgeLint={ack} lines={lines}
        issuer={issuerLine(fromAsset.symbol) ?? issuerLine(sym)} routeKind={routeKind(refOf(fromAsset), to.ref, f.quote.nativeAssets)}
        maximumLoss={f.maximumLoss} verdict={f.verdict} protectionDetails={f.details}
        details={{ provider, mode: f.quote.plan?.mode ?? "single", parts: f.quote.plan?.parts, fees: feeSummary(f.quote), expectedOutput: `${fmt(f.quote.toAmount, dec)} ${sym} for the whole order at today's rate`, settlement: settlement(provider), alternatives: (q.competition ?? []).filter((c) => c.provider !== provider).map((c) => ({ provider: c.provider, outcome: c.outcome, reason: c.reason })), score: advanced ? `${f.score.total} (price ${f.score.components.price}, security ${f.score.components.security}, privacy ${f.score.components.privacy}, latency ${f.score.components.latency}, reliability ${f.score.components.reliability}, liquidity ${f.score.components.liquidity})` : undefined, linkEvidence: q.links?.[provider]?.evidence }}
        advanced={advanced} reviewHold={controls.reviewHold ? { minutes: REVIEW_HOLD_MINUTES } : null} onExport={controls.export ? exportNow : undefined}
        secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null} secondDevice={controls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null}
        tradeCheck={tradeCheckFor(provider, f.quote, f.score, q.links?.[provider]?.public, lintItems, units, to.ref, f.p)}
        busy={busy} error={error} onConfirm={() => startProtected(provider)} onCancel={() => setReview(null)} />
    );
  }

  /** The confirmation (spec §7): the campaign is journaled with its bounds and the first tick; the runner does the rest from any screen. */
  async function startProtected(provider: string) {
    const f = campaignFacts(provider);
    const now = Date.now();
    let gasPriceWei: string | null = null;
    if (submission.kind === "relayer") { try { gasPriceWei = (await relayerInfo(submission.url)).gasPriceWei; } catch { gasPriceWei = null; } }
    const c = await run("Starting the protected execution…", async () => startCampaign({
      quotes: quotes!, provider, from: refOf(fromAsset), fromAsset, to: to.ref, amount: units, tier, mode: protection.mode, preference, policy, destination: f.destinationPolicy, usd, lint: lintItems, capBps: protection.capBps,
      crossRateE18: crossRateFromPrices({ request: { from: refOf(fromAsset), to: to.ref } } as never), gasPriceWei,
      confirmations: { ...(controls.secondFactor ? { secondFactor: now } : {}), ...(controls.secondDevice ? { secondDevice: now } : {}) },
      reviewHoldUntil: controls.reviewHold ? now + REVIEW_HOLD_MINUTES * 60_000 : undefined, now,
    }));
    if (!c) return;
    reset(); setQuotes(null); setCampaignView(c.id);
  }

  /** The reroute Review (spec §8): a route change on a large operation is confirmed, never adopted quietly. */
  function rerouteReview(campaignId: string) {
    const c = campaignById(campaignId);
    if (!c || !c.pendingReroute) { setReview(null); return null; }
    const pr = c.pendingReroute;
    const np = (pr.protection ?? null) as Protection | null;
    const dec = c.request.from.decimals;
    const fmtFrom = (u: string) => `${fmtUnits(u, dec, 4)} ${c.request.from.symbol}`;
    const lines: ReviewLine[] = [
      { id: "route", label: "Route checked", ok: true, meaning: `the fresh competition for the remaining amount chose ${pr.provider} (before: ${c.provider ?? "—"})` },
      { id: "exposure", label: "Exposure bounded", ok: true, meaning: `the same bounds hold: at most ${fmtFrom(c.bounds.maxExternalExposure)} unsettled at once, the same minimum per unit, the same destination policy` },
      { id: "security", label: "Security assessed", ok: !np || np.riskClass !== "R6", meaning: np ? `${pr.provider}: class ${np.riskClass}, ${CUSTODY_WORDS[np.custody] ?? np.custody}, ${GATE_WORDS[np.gate] ?? np.gate}${np.reasons.length ? `; ${np.reasons.join("; ")}` : ""}` : "the new route's recommendation is not available; the bounds still hold" },
      { id: "privacy", label: "Privacy reviewed", ok: true, meaning: "the remaining steps keep their sizes and cadence; the provider changes" },
    ];
    return (
      <Review moment="reroute" tier={c.tier} controls={controlsFor(c.tier)} usd={c.value && typeof c.value === "object" && "usd" in (c.value as object) ? formatUsd((c.value as { usd: number }).usd) : null} amount={`${fmtFrom(c.request.amount)} (the whole order)`} from={`Private ${c.request.from.symbol}, the remaining steps`}
        to={{ network: to.network, asset: c.request.to.symbol, address: c.bounds.destination.kind === "fresh-per-tranche" ? "a fresh address per step" : c.bounds.destination.address, kind: c.bounds.destination.kind === "fresh-per-tranche" ? "fresh" : "entered" }}
        execution={{ words: "Protected execution", detail: `continues with ${pr.provider}`, eta: np ? `about ${durationWords(np.estimatedSeconds)} for the rest` : "as before" }}
        privacy={{ level: levelOf(((c.riskSnapshot ?? {}) as { privacyScore?: number }).privacyScore ?? 0) }} lint={[]} onAcknowledgeLint={() => {}} lines={lines}
        verdict={{ security: !np || np.riskClass !== "R6" ? "Review" : "Do not execute", privacy: levelOf(((c.riskSnapshot ?? {}) as { privacyScore?: number }).privacyScore ?? 0), why: `the route changed to ${pr.provider}; a route change on a large operation is reviewed by you` }}
        advanced={advanced} secondFactor={controlsFor(c.tier).secondFactor ? { credentialId: secondFactor.credentialId } : null} secondDevice={controlsFor(c.tier).secondDevice ? { credentialId: protection.secondDevice.credentialId } : null}
        busy={busy} error={error} onConfirm={() => { acceptReroute(c.id, true); setReview(null); }} onCancel={() => setReview(null)} />
    );
  }

  /** The Review before commit (spec §24): the five lines of plan §4 computed from the quote set and the lint. */
  function commitReview(provider?: string) {
    const q = quotes!;
    const prov = provider ?? q.chosen!.provider;
    const quote = q.quotes.find((x) => x.provider === prov)!;
    const score = q.scores.find((s) => s.provider === prov) ?? q.chosen!;
    const dec = to.ref.decimals, sym = to.ref.symbol;
    const liveQuotes = q.competition ? q.competition.filter((c) => c.outcome === "quoted").length : q.quotes.length;
    const lines: ReviewLine[] = [
      { id: "price", label: "Price protected", ok: BigInt(quote.toAmountMin) > 0n, meaning: `at least ${fmt(quote.toAmountMin, dec)} ${sym} is bound in the order; a lower minimum needs your consent; the price guard runs again at the hard quote` },
      { id: "route", label: "Route checked", ok: !controls.twoQuotes || liveQuotes >= 2 || routeAck, meaning: liveQuotes >= 2 ? `${liveQuotes} providers quoted this size; the best route won on privacy, price, security, reliability, time and liquidity` : "only one provider answered for this size; the route cannot be compared with another live quote", ...(controls.twoQuotes && liveQuotes < 2 ? { ack: { text: "I accept the single quote", done: routeAck, onAck: () => setRouteAck(true) } } : {}) },
      { id: "destination", label: "Destination verified", ok: !destinationEdited || (parsedDestination?.ok === true && destAck), meaning: destinationEdited ? "entered by hand: the format parses; confirm you checked every group of the address" : "a fresh address of this wallet, used once, its format checked", ...(destinationEdited ? { ack: { text: "I checked every group", done: destAck, onAck: () => setDestAck(true) } } : {}) },
      { id: "slippage", label: "Slippage checked", ok: quote.impactBps === undefined || quote.impactBps <= IMPACT_CAP_BPS, meaning: quote.impactBps === undefined ? "the provider gave no impact figure; the minimum bounds the outcome" : `price impact ${quote.impactBps} bps against a cap of ${IMPACT_CAP_BPS}` },
      { id: "privacy", label: "Privacy reviewed", ok: !lintItems || unacknowledgedBlocks(lintItems).length === 0, meaning: "every privacy check is ok, a warning, or acknowledged" },
    ];
    const exportNow = () => downloadText(`privacy-wallet-order-review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify({ format: "privacy-protocol/order-review/v1", exportedAt: new Date().toISOString(), request: request(), tier, value: assessment?.value ?? null, quotes: q, lint: lintItems ?? null }, null, 2));
    return (
      <Review moment="commit" tier={tier} controls={controls} usd={usd !== null ? formatUsd(usd) : null} amount={`${formatAmount(fromAsset, units)} ${fromAsset.symbol}`} from={`Private ${fromAsset.symbol}`}
        to={{ network: to.network, asset: sym, address: destination, kind: destinationEdited ? "entered" : "fresh" }} receiveMin={`${fmt(quote.toAmountMin, dec)} ${sym}`}
        execution={{ words: planWords(quote.plan), detail: quote.plan && quote.plan.mode !== "single" ? planLabel(quote.plan) : undefined, eta: `~${hours(quote.etaSeconds)}${policy !== "fastest" ? " after the scheduled funding" : ""}` }}
        privacy={{ level: levelOf(score.components.privacy), score: score.components.privacy }} lint={lintItems ?? []} onAcknowledgeLint={ack} lines={lines}
        issuer={issuerLine(fromAsset.symbol) ?? issuerLine(sym)} routeKind={routeKind(refOf(fromAsset), to.ref, quote.nativeAssets)}
        details={{ provider: prov, mode: quote.plan?.mode ?? "single", parts: quote.plan?.parts, fees: feeSummary(quote), expectedOutput: `${fmt(quote.toAmount, dec)} ${sym}`, settlement: settlement(prov), alternatives: (q.competition ?? []).filter((c) => c.provider !== prov).map((c) => ({ provider: c.provider, outcome: c.outcome, reason: c.reason })), score: advanced ? `${score.total} (price ${score.components.price}, security ${score.components.security}, privacy ${score.components.privacy}, latency ${score.components.latency}, reliability ${score.components.reliability}, liquidity ${score.components.liquidity})` : undefined, linkEvidence: q.links?.[prov]?.evidence }}
        advanced={advanced} reviewHold={controls.reviewHold ? { minutes: REVIEW_HOLD_MINUTES } : null} onExport={controls.export ? exportNow : undefined} secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null}
        tradeCheck={tradeCheckFor(prov, quote, score, q.links?.[prov]?.public, lintItems, units, to.ref)}
        busy={busy} error={error} onConfirm={() => commit(prov)} onCancel={() => setReview(null)} />
    );
  }

  /** The Review before the hand-over (spec §24): the checked call, the simulation, the lint read against the call. */
  function executeReview(s: Signed) {
    const t = ((stored?.request as { to?: AssetRef })?.to ?? to.ref);
    const dec = t.decimals, sym = t.symbol;
    const dest = String((stored?.request as { destination?: string })?.destination ?? destination);
    const approved = stored?.approvedMin ? BigInt(stored.approvedMin) : 0n;
    const quote = (stored?.quote ?? {}) as { impactBps?: number; nativeAssets?: boolean; toAmount?: string; etaSeconds?: number; fees?: unknown[] };
    const lines: ReviewLine[] = [
      { id: "price", label: "Price protected", ok: s.call.minOut !== null && s.call.minOut >= approved, meaning: s.call.minOut !== null ? `the provider call guarantees at least ${fmt(s.call.minOut.toString(), dec)} ${sym}, read from its calldata; the service's price guard ran at the hard quote` : "this call binds no minimum this wallet can read" },
      { id: "route", label: "Route checked", ok: s.sim.ok, meaning: s.sim.ok ? `simulated on ${s.sim.endpoints} RPC endpoint${s.sim.endpoints === 1 ? "" : "s"}: it executes, about ${Number(s.sim.gas).toLocaleString()} gas` : s.sim.reason },
      { id: "destination", label: "Destination verified", ok: true, meaning: `the call pays ${dest.slice(0, 10)}… — read from its calldata, equal to the destination committed` },
      { id: "slippage", label: "Slippage checked", ok: quote.impactBps === undefined || quote.impactBps <= IMPACT_CAP_BPS, meaning: quote.impactBps === undefined ? "the minimum bounds the outcome" : `price impact ${quote.impactBps} bps against a cap of ${IMPACT_CAP_BPS}` },
      { id: "privacy", label: "Privacy reviewed", ok: !signLint || unacknowledgedBlocks(signLint).length === 0, meaning: "every privacy check is ok, a warning, or acknowledged" },
    ];
    const exportNow = () => stored && downloadText(`privacy-wallet-order-${stored.orderId.slice(2, 10)}.json`, exportOrderReview(stored, { simulation: s.sim, lint: signLint }));
    return (
      <Review moment="execute" tier={storedTier} controls={executeControls} usd={stored?.value && typeof stored.value === "object" && "usd" in (stored.value as object) ? formatUsd((stored.value as { usd: number }).usd) : usd !== null ? formatUsd(usd) : null}
        amount={`${formatAmount(orderAsset, BigInt((stored?.params as { amount?: string })?.amount ?? "0"))} ${orderAsset.symbol}`} from="A one-time escrow funded from your private balance"
        to={{ network: TARGETS[Object.keys(TARGETS).find((k) => TARGETS[k].ref.symbol === sym && TARGETS[k].ref.chain === t.chain) ?? target].network, asset: sym, address: dest, kind: destinationEdited ? "entered" : "fresh" }}
        receiveMin={s.call.minOut !== null ? `${fmt(s.call.minOut.toString(), dec)} ${sym}` : null}
        execution={{ words: planWords(s.prepared.plan ?? (stored?.plan as ExecutionPlan | undefined)), detail: s.prepared.plan && s.prepared.plan.mode !== "single" ? planLabel(s.prepared.plan) : undefined, eta: `~${hours(quote.etaSeconds ?? 0)}` }}
        privacy={{ level: levelOf(order?.privacy.score ?? 0), score: order?.privacy.score }} lint={signLint ?? []} onAcknowledgeLint={ack} lines={lines}
        issuer={issuerLine(orderAsset.symbol) ?? issuerLine(sym)} routeKind={routeKind(refOf(orderAsset), t, quote.nativeAssets)}
        details={{ provider: s.call.provider, mode: s.prepared.plan?.mode ?? "single", parts: s.prepared.plan?.parts, fees: "as quoted at commit", expectedOutput: quote.toAmount ? `${fmt(quote.toAmount, dec)} ${sym}` : "as quoted", settlement: settlement(s.call.provider), alternatives: ((stored?.competition ?? []) as { provider: string; outcome: string; reason?: string }[]).filter((c) => c.provider !== s.call.provider), linkEvidence: undefined, score: advanced ? s.call.facts.join("; ") : undefined }}
        advanced={advanced} onExport={executeControls.export ? exportNow : undefined} secondFactor={executeControls.secondFactor ? { credentialId: secondFactor.credentialId } : null}
        tradeCheck={tradeCheckFor(s.call.provider, quote.toAmount ? { plan: s.prepared.plan, etaSeconds: quote.etaSeconds ?? 0, impactBps: quote.impactBps, nativeAssets: quote.nativeAssets ?? true, toAmountMin: stored?.approvedMin ?? "0" } : undefined, undefined, undefined, signLint, BigInt((stored?.params as { amount?: string })?.amount ?? "0"), t)}
        busy={busy} error={error} onConfirm={() => handOver(s)} onCancel={() => setReview(null)} />
    );
  }

  if (review) {
    return (
      <div className="panel" data-testid="swap">
        <h3>Swap privately</h3>
        {review.moment === "commit" && quotes ? commitReview(review.provider) : review.moment === "execute" ? executeReview(review.signed) : review.moment === "campaign" && quotes && protectionPlan ? campaignReview(review.provider) : review.moment === "reroute" ? rerouteReview(review.campaignId) : null}
      </div>
    );
  }
  if (wizard && quotes && protectionPlan) {
    return (
      <div className="panel" data-testid="swap">
        <h3>Swap privately</h3>
        {campaignWizard()}
      </div>
    );
  }
  const viewed = campaignView ? campaignById(campaignView) : null;
  if (viewed) {
    return (
      <div className="panel" data-testid="swap">
        <h3>Swap privately</h3>
        <CampaignProgress campaign={viewed} advanced={advanced} onPause={() => pauseCampaign(viewed.id)} onResume={() => resumeCampaign(viewed.id)} onCancel={() => cancelCampaign(viewed.id)} onReviewReroute={() => setReview({ moment: "reroute", campaignId: viewed.id })} onBack={() => setCampaignView(null)} />
      </div>
    );
  }

  return (
    <div className="panel" data-testid="swap">
      <h3>Swap privately</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Your private balance pays a one-time address; the best route delivers to a fresh address of this wallet. A failed swap returns to your private balance by itself.
      </p>
      <AssetSelect assets={assets} value={fromAsset} onChange={(a) => { setFromAsset(a); setAmount(a.decimals === 18 ? "0.5" : "100"); setQuotes(null); reset(); }} label="From your private balance" />
      <label>Amount ({fromAsset.symbol}){usd !== null ? ` · ≈ ${formatUsd(usd)}` : ""}</label>
      <input value={amount} onChange={(e: any) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setQuotes(null); reset(); }} inputMode="decimal" />
      {units > 0n && !isBucketFor(fromAsset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => { setAmount(formatAmount(fromAsset, bucket)); setQuotes(null); reset(); }}>Use {formatAmount(fromAsset, bucket)} {fromAsset.symbol} (a public bucket; the rest stays private)</button> : "Choose a larger amount."}
        </p>
      )}
      {assessment && assessment.tier !== "standard" && (
        <p className="notice" style={{ marginTop: -4, marginBottom: 10 }}>
          {assessment.failSafe ? "No price is available, so this swap is treated as a large transfer: " : `${tierLabel[assessment.tier]}: `}
          the route must be confirmed by two live quotes or acknowledged, the price guard tightens, and the review steps of a large transfer apply.
        </p>
      )}
      <label>To</label>
      <select value={target} onChange={(e: any) => chooseTarget(e.target.value)}>
        {Object.keys(TARGETS).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>Receive at {destinationEdited ? "(your own address)" : "(a fresh address of this wallet, reserved when you confirm)"}</label>
      <input value={destination} onChange={(e: any) => { setDestination(e.target.value); setDestinationEdited(e.target.value.trim() !== ""); }} placeholder="fresh address" />
      {destinationEdited && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Never use your public wallet address here. <button className="tab" onClick={() => { setDestinationEdited(false); setDestination(peekFreshAddress(masterSeed, chainKindOf(to.ref.chain)).address); }}>Use a fresh address</button></p>}
      {destinationError && <p className="error" style={{ fontSize: 13, marginTop: -4 }} data-testid="destination-error">Destination: {destinationError}.</p>}
      <p className="muted" style={{ fontSize: 12 }}>Funded at a random time within {window[1] === 0 ? "no delay (your preference is Fastest)" : `${hours(window[0])}–${hours(window[1])}`}; change the trade preference under Settings.</p>
      <button className="primary" onClick={getQuotes} disabled={!!busy || !destination || units <= 0n || !!destinationError}>Get a quote</button>
      {busy && <p className="muted">{busy}</p>}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}

      {quotes && !order && (
        <div style={{ marginTop: 14 }} data-testid="quote">
          {chosen && chosenQuote ? (
            <>
              <div className="row"><span className="muted">Best route</span><b>Automatic</b></div>
              <div className="row"><span className="muted">Receive approximately</span><b>{fmt(chosenQuote.toAmount, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">At least</span><b>{fmt(chosenQuote.toAmountMin, to.ref.decimals)} {to.ref.symbol}</b></div>
              <div className="row"><span className="muted">Network</span><b>{to.network}</b></div>
              <div className="row"><span className="muted">Privacy</span><b className={`level-${levelOf(chosen.components.privacy)}`}>{levelOf(chosen.components.privacy)}</b></div>
              <div className="row"><span className="muted">Price</span><b className={`level-${levelOf(chosen.components.price)}`}>{levelOf(chosen.components.price)}</b></div>
              <div className="row"><span className="muted">Time</span><b>~{hours(chosenQuote.etaSeconds)}{policy !== "fastest" ? " after the scheduled funding" : ""}</b></div>
              <div className="row"><span className="muted">Fee</span><b>{feeSummary(chosenQuote)}</b></div>
              {campaignMode && protectionPlan && (() => { const cap = (units * BigInt(protectionPlan.capBps)) / 10000n; const piece = (units * BigInt(protectionPlan.bandBps[1])) / 10000n; return (
                <p className="notice" data-testid="protection-line">Protected execution: about {protectionPlan.estimatedTranches} steps of ≈ {usdOf(piece) ?? `${formatAmount(fromAsset, piece)} ${fromAsset.symbol}`} · {protectionPlan.concurrency === "sequential" ? "one at a time" : `up to ${protectionPlan.maxParallel} at a time`} · at most {usdOf(cap) ?? `${formatAmount(fromAsset, cap)} ${fromAsset.symbol}`} at risk · about {durationWords(protectionPlan.estimatedSeconds)}.</p>
              ); })()}
              {quotedOnly === 1 && <p className="notice">Only one provider answered for this size; the route cannot be compared with another live quote.</p>}
              <DestinationCard network={to.network} asset={to.ref.symbol} address={destination} amount={fmt(chosenQuote.toAmount, to.ref.decimals)} kind={destinationEdited ? "entered" : "fresh"} />
              {lintItems && <PrivacyLint items={lintItems} onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} />}
              <div className="tabs" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => startCommit(chosen.provider)} disabled={!!busy || blocked} title={blocked ? "Acknowledge the privacy check first" : undefined}>{controls.review ? "Review" : "Swap"}</button>
                <button className="tab" onClick={() => setShowRoute((v) => !v)}>{showRoute ? "Hide route details" : "Route details"}</button>
              </div>
            </>
          ) : (
            <p className="muted">No route available right now{Object.keys(quotes.errors).length ? ` (${Object.values(quotes.errors).join("; ")})` : ""}.</p>
          )}
          {showRoute && quotes.scores.map((s: RouteScore) => {
            const q = quotes.quotes.find((x) => x.provider === s.provider)!;
            return (
              <div key={s.provider} style={{ padding: "8px 0", borderTop: "1px solid var(--border)", opacity: s.filtered ? 0.55 : 1 }}>
                <div className="row"><b>{s.provider}{chosen?.provider === s.provider ? " · best route" : ""}</b><b>{fmt(q.toAmount, to.ref.decimals)} {to.ref.symbol}</b></div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Output at least {fmt(q.toAmountMin, to.ref.decimals)} · ~{hours(q.etaSeconds)} · Provider risk: {risk(s.components.security)} · Bridge: {q.nativeAssets ? "none (native assets)" : "wrapped leg"} · Settlement: {settlement(s.provider)} · Privacy {s.components.privacy}
                  {q.plan && q.plan.mode !== "single" ? ` · ${q.plan.parts} parts over ~${hours(q.plan.expectedSeconds)}` : ""}
                  {q.refundTarget === "destination" ? " · a failure refunds at the destination, not to the pool" : ""}
                  {quotes.links?.[s.provider]?.public ? " · the provider publishes the escrow → destination link (harmless: your escrow was funded privately; this swap is as private as your pool withdrawal)" : ""}
                  {advanced && quotes.links?.[s.provider] ? ` · link: ${quotes.links[s.provider].evidence}` : ""}
                  {s.filtered ? ` · not selectable: ${s.filtered}` : ""}
                  {advanced ? ` · score ${s.total} (price ${s.components.price}, security ${s.components.security}, latency ${s.components.latency}, reliability ${s.components.reliability}, liquidity ${s.components.liquidity})` : ""}
                </div>
                {!s.filtered && chosen?.provider !== s.provider && <button className="tab" style={{ marginTop: 4 }} onClick={() => startCommit(s.provider)} disabled={!!busy || blocked}>Use this route</button>}
              </div>
            );
          })}
          {showRoute && quotes.competition?.filter((c) => c.outcome !== "quoted").map((c) => <div key={c.provider} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{c.provider}: {c.outcome}{c.reason ? ` (${c.reason})` : ""}</div>)}
          {showRoute && !quotes.competition && Object.entries(quotes.errors).map(([p, e]) => <div key={p} className="muted" style={{ fontSize: 12, padding: "4px 0" }}>{p}: {e}</div>)}
          <Scorecard action="swap" facts={{ delaySeconds: window[0], amountIsBucket: isBucketFor(fromAsset, units), privateSubmission: submission.kind === "relayer" && policy !== "fastest", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: !destinationEdited, provider: chosen && chosenQuote ? { crossChainScore: chosen.components.privacy, nativeAssets: chosenQuote.nativeAssets, kind: providerKind(chosen.provider) } : undefined }} />
        </div>
      )}

      {!order && activeCampaigns().length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }} data-testid="protected-swaps">
          <label>Your protected swaps</label>
          {activeCampaigns().map((c) => (
            <div key={c.id} className="row" style={{ fontSize: 13, padding: "4px 0" }}>
              <span>{c.request.from.symbol} → {c.request.to.symbol} · {progressLine(c)} · {c.state}</span>
              <button className="tab" onClick={() => setCampaignView(c.id)}>Open</button>
            </div>
          ))}
        </div>
      )}
      {!order && openSwaps.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <label>Your open swaps</label>
          {openSwaps.map((s) => {
            const a = assetOf(s);
            return (
              <div key={s.orderId} className="row" style={{ fontSize: 13, padding: "4px 0" }}>
                <span>{formatAmount(a, BigInt((s.params as any).amount))} {a.symbol} → {(s.request as any).to.symbol} · {s.state}{s.dueAt && !s.fundedTx ? ` · funding ${new Date(s.dueAt).toLocaleString()}` : ""}</span>
                <span className="tabs" style={{ margin: 0 }}>
                  <button className="tab" onClick={() => resume(s)} disabled={!!busy}>Open</button>
                  {!s.fundedTx && <button className="tab" onClick={() => abandonSwap(s.orderId)}>Abandon</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {order && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <DestinationCard network={TARGETS[Object.keys(TARGETS).find((k) => TARGETS[k].ref.symbol === ((stored?.request as any)?.to?.symbol ?? to.ref.symbol) && TARGETS[k].ref.chain === ((stored?.request as any)?.to?.chain ?? to.ref.chain)) ?? target].network} asset={(stored?.request as any)?.to?.symbol ?? to.ref.symbol} address={(stored?.request as any)?.destination ?? destination} amount={stored?.approvedMin ? `at least ${fmt(stored.approvedMin, (stored.request as any)?.to?.decimals ?? to.ref.decimals)}` : undefined} title="Receive at" />
          <div className="row"><span className="muted">Privacy</span><b className={`level-${levelOf(order.privacy.score)}`}>{levelOf(order.privacy.score)}{advanced ? ` (${order.privacy.score}/100)` : ""}</b></div>
          <div className="row"><span className="muted">{funded ? "Funded" : dueAt ? "Funding scheduled" : "Funding"}</span><b>{funded ? `tx ${stored!.fundedTx!.slice(0, 10)}…` : dueAt ? `${new Date(dueAt).toLocaleString()} (random within ${hours(order.privacy.delaySeconds[0])}–${hours(order.privacy.delaySeconds[1])}${stored?.reviewHoldUntil ? `, no earlier than the review hold ${new Date(stored.reviewHoldUntil).toLocaleTimeString()}` : ""}; keep the wallet unlocked)` : "now"}</b></div>
          {holdActive && <p className="notice" data-testid="review-hold">Review hold until {new Date(stored!.reviewHoldUntil!).toLocaleTimeString()}: the order can still be abandoned under open swaps, and nothing is funded before then.</p>}
          <div className="row"><span className="muted">Returns to your private balance if not executed by</span><b>{new Date(order.params.refundAfter * 1000).toLocaleString()}</b></div>
          {advanced && (
            <>
              <div className="row"><span className="muted">Route</span><b>{order.quote.provider}</b></div>
              <div className="row"><span className="muted">One-time escrow (withdrawal recipient)</span><code>{order.endpoint}</code></div>
              <div className="row"><span className="muted">Executor tip</span><b>{formatAmount(orderAsset, BigInt(order.params.executorTip))} {orderAsset.symbol}</b></div>
              <div className="row"><span className="muted">Order key (one-time)</span><code>{orderKey?.address}</code></div>
            </>
          )}
          <div className="tabs" style={{ marginTop: 10 }}>
            <button className="primary" onClick={fundNow} disabled={!!busy || funded || holdActive} title={holdActive ? "The review hold has not passed" : dueAt ? "Funding now shortens the random delay and weakens timing privacy" : undefined}>{dueAt && !funded ? "1 · Fund now (less timing privacy)" : "1 · Fund the swap from your private balance"}</button>
            <button className="primary" onClick={() => signAndHand()} disabled={!!busy || !funded || (!!job && !OPEN_FOR_RESIGN.includes(job.state))}>
              {job && OPEN_FOR_RESIGN.includes(job.state) ? "2 · Confirm again with a fresh quote" : "2 · Confirm the swap"}
            </button>
            {funded && CAN_RETURN(job) && <button className="tab" onClick={returnToBalance} disabled={!!busy} title="The order is not executed; its escrow re-shields into your private balance once the window opens">Return to my private balance</button>}
            {executeControls.export && stored && <button className="tab" onClick={() => downloadText(`privacy-wallet-order-${stored.orderId.slice(2, 10)}.json`, exportOrderReview(stored, { lint: signLint }))}>Export for review (JSON)</button>}
          </div>
          {moved && (() => {
            const t = (stored?.request as any)?.to as AssetRef | undefined;
            const dec = t?.decimals ?? to.ref.decimals, sym = t?.symbol ?? to.ref.symbol;
            const drop = moved.approved > 0n ? Number(((moved.approved - moved.minOut) * 10000n) / moved.approved) / 100 : 0;
            return (
              <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--warn)", borderRadius: 6 }}>
                <p style={{ fontSize: 13, margin: 0 }}>The price moved. This route now guarantees at least <b>{fmt(moved.minOut.toString(), dec)} {sym}</b>; you approved {fmt(moved.approved.toString(), dec)} {sym} (−{drop} %). Nothing has been signed.</p>
                <p className="muted" style={{ fontSize: 12 }}>Confirm at the new minimum, or wait and confirm later against a fresh quote. An order that is never confirmed returns to your private balance after {new Date(order.params.refundAfter * 1000).toLocaleString()}.</p>
                <button className="tab" onClick={() => signAndHand(moved.minOut)} disabled={!!busy}>Confirm at the new minimum</button>
                <button className="tab" onClick={returnToBalance} disabled={!!busy}>Return it to my private balance instead</button>
              </div>
            );
          })()}
          {checked && (
            <p className="muted" style={{ fontSize: 12 }}>
              Checked by this wallet before signing: pays your fresh address{checked.minOut !== null ? `, at least ${fmt(checked.minOut.toString(), ((stored?.request as any)?.to as AssetRef | undefined)?.decimals ?? to.ref.decimals)} ${((stored?.request as any)?.to as AssetRef | undefined)?.symbol ?? to.ref.symbol}` : ", minimum not readable (Fastest)"}; {checked.refundTo === "escrow" ? "a provider refund returns to your private balance" : checked.refundTo === "destination" ? "a failed order refunds at your fresh address, not to your private balance" : "a failed order refunds by the provider's rules"}.
              {advanced ? ` (${checked.provider}: ${checked.facts.join("; ")})` : ""}
            </p>
          )}
          {signLint && <PrivacyLint items={signLint} compact />}
          {stored?.simulation && <p className="muted" style={{ fontSize: 12 }}>{stored.simulation.ok ? `Simulated on your RPC endpoints before hand-over${stored.simulation.gas ? ` (about ${Number(stored.simulation.gas).toLocaleString()} gas)` : ""}.` : `The last simulation failed: ${stored.simulation.reason ?? stored.simulation.error}.`}</p>}
          {signed && <p className="muted" style={{ fontSize: 12 }}>Confirmed: {signed}{submission.kind !== "relayer" ? " — submit deployAndExecute yourself or switch to relayer submission (Settings)." : ""}</p>}
          {tracked
            ? <SettlementLine tracked={tracked} />
            : job
              ? <p className="muted" style={{ fontSize: 12 }}>Status: <b>{swapJobStatus(job.state)}</b></p>
              : <p className="muted" style={{ fontSize: 12 }}>Status: Pending — {funded ? "confirm the swap against a fresh quote, or return it to your private balance." : dueAt ? "the funding fires at the scheduled time while the wallet is unlocked, on any screen." : "fund the swap, then confirm it."}</p>}
          {job && <p className="muted" style={{ fontSize: 12 }}>{advanced ? `Executor: ${job.state}${job.executionTx ? `, execution ${job.executionTx.slice(0, 10)}…` : job.txHash ? `, tx ${job.txHash.slice(0, 10)}…` : ""}${job.error ? `, ${job.error}` : ""} — ` : ""}refreshed every 15 s{OPEN_FOR_RESIGN.includes(job.state) ? "; the quote expired: confirm again with a fresh one" : ""}.</p>}
          {job?.state === "executed" && <p className="muted" style={{ fontSize: 12 }}>{(checked?.refundTo ?? (stored?.quote as { refundTarget?: string } | undefined)?.refundTarget) === "destination"
            ? "Handed to the provider. If it cannot deliver, it refunds at your fresh address on the destination chain, not to the pool."
            : `Handed to the provider. If it cannot deliver, it refunds the escrow, and the executor re-shields that into your private balance when it arrives within its watch (by default a day after ${new Date(order.params.refundAfter * 1000).toLocaleString()}). An amount too small to be worth a re-shield is left in the escrow, where anyone can re-shield it.`}</p>}
          {job?.state === "refund-only" && <p className="muted" style={{ fontSize: 12 }}>Returning to your private balance: the escrow re-shields as your pre-committed note after {new Date(order.params.refundAfter * 1000).toLocaleString()}; it is added to your private balance when the executor reports it (a rescan finds it too).</p>}
          {refundLine && <p className="muted" style={{ fontSize: 12 }}>{refundLine}</p>}
        </div>
      )}
    </div>
  );
}
