// Swap and cross-chain (spec v2.0 §7.5–§7.7, §13.4, §14.1; doc §26–§33, §48, §58): one container for the flow —
// /swap the page (SwapView: the quote fetched as the user types and its countdown, the cross-chain destination with its
// checks, the protection from the privacy assessment, "Delay for more privacy" right after a protect, the route under
// Advanced), /swap/review the Review (the V6 Review below $100K — a hold from $50K —, the V2–V4 one from it), then ONE
// confirmation: the blockers are re-checked, the order is committed with the minimum the user approved and handed to
// the order runner (sdk/wallet/orderRunner.ts), which funds it, signs while that minimum holds and hands it over;
// /swap/progress/:opId the operation's lines, the paused order's choice (accept the new minimum or return the funds),
// the result. A protected execution (the service's plan at its band) continues on /swap/protected — V5's screen until
// Stage 13 rebuilds large trades. The quote carries no destination (the engine quotes a placeholder); the destination
// — a fresh address of this wallet unless one is typed — is reserved and sent at the confirmation. V6 Stage 12 (spec v2.0
// §11.2): a same-chain target lands in the protected balance — the quote asks for a protected destination (its shield tip
// is in the lines), the confirmation builds the one-time shield receiver the order pays, and the result says what arrived.
// V7 Stage 13 (spec v3.0 §4; the owner's decisions 3 and 4): from $50K to $100K the swap is a Protected Large Swap — ONE order
// by default behind the Review's Protected execution checks and the hold, under the band's exposure limit (one in flight per
// wallet) and the route's liquidity qualification; it runs as protected steps (the planner's varied pieces, one at a time,
// wallet/campaigns.ts; /swap/steps/:campaignId shows amounts only) only when the service stages it or the user asked under
// Advanced. Above $100K the high-value layer is the Advanced experience's (Simple gets the card with the switch); the V3/V4
// screens stay (/swap/protected) when the service stages the order.
// V7 Stage 14 (spec v3.0 §5): the commit goes through the swap provider facade (sdk/swapProvider.ts), the one interface over
// the service's competition, the two-phase commit, the wallet's checks, the status reads and the recovery options.
import { destinationWords } from "../destinationWords";
import { idOfRoute, routeHandle } from "@privacy-wallet/sdk/wallet/routeHandles";
import { knownRecipients } from "../recipients";
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { availablePrice, atLeast, formatUsd, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { parseDestination, looksLikeChain } from "@privacy-wallet/protocol/wallet/destinations";
import { assessSwapPrivacy, timingOfFunding } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { unacknowledgedBlocks, type LintId } from "@privacy-wallet/protocol/wallet/privacyLint";
import { swapFunding, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import { exposure } from "@privacy-wallet/protocol/wallet/campaign";
import type { BlockerCode } from "@privacy-wallet/protocol-types";
import { AssetSelector, Button, Card, ListRow, Page, SuccessCard, TextButton, WarningCard, formatUsdCents, type AssetOption } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import type { SettlementLabel } from "@privacy-wallet/sdk/orderTracker";
import { formatDateTime } from "../../app/i18n/intl";
import { assetsOf, formatAmount, isBucketFor, parseAmount, type Asset, isWholeNote } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { swapService, type QuoteSet } from "@privacy-wallet/sdk/swapService";
import { feeTerms, maxSpendable } from "@privacy-wallet/sdk/privateTx";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { controlsFor, holdMs, issuerControlled, PROTECTED_EXECUTION, routeKind } from "@privacy-wallet/sdk/tiers";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { destinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import { walletLint, topBucket } from "@privacy-wallet/sdk/wallet/lintFacts";
import { holdersAbove } from "@privacy-wallet/sdk/poolDeposits";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { mergeSchedule } from "@privacy-wallet/sdk/wallet/mergeSchedule";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { proofEstimateMs } from "@privacy-wallet/sdk/wallet/proofStats";
import { fundingTiming, olderFunding } from "@privacy-wallet/sdk/wallet/privacyTiming";
import { acceptNewMinimum, retryOrder, returnFunds } from "@privacy-wallet/sdk/wallet/orderRunner";
import { fundedOf } from "@privacy-wallet/sdk/wallet/journal";
import { actionsFor } from "../operations/recovery";
import {
  buildCampaign,
  cancelCampaign,
  cryptoSeed,
  resumeCampaign,
  seededUniform,
  startCampaign,
  TERMINAL_STATES,
  campaignMinimumOutput,
} from "@privacy-wallet/sdk/wallet/campaigns";
import { inFlightLimitReached, protectedInFlight } from "@privacy-wallet/sdk/wallet/inFlight";
import { campaignLineText } from "./protected/words";
import { crossRateFromPrices } from "@privacy-wallet/sdk/wallet/campaignRunner";
import { relayerInfo } from "@privacy-wallet/sdk/relayer";
import { walletSwapProvider } from "@privacy-wallet/sdk/swapProvider";
import { swapRecordId } from "@privacy-wallet/sdk/operations/swapRecords";
import { CATALOG, classify, reasonKey, titleKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { DELAY_WINDOW, policyFromPreference } from "@privacy-wallet/sdk/policy";
import { PrivacyLint } from "../../components/PrivacyLint";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { Review } from "../review/ReviewScreen";
import { BLOCKER_WORDS, ReviewView, feeRowsText, type ReviewModel } from "../review/View";
import { OperationProgress } from "../operations/OperationProgress";
import { AttemptLine, attemptIdOf } from "../operations/AttemptLine";
import { ProgressView } from "../progress/View";
import { campaignProgressModel, furthestLine, progressModelOf } from "../progress/model";
import { amountFrom, amountOf, centsOf, displayAmount } from "../amounts";
import { CompareRoutes } from "./CompareRoutes";
import { Swap, type SwapPrefill } from "./Swap";
import { SwapView } from "./View";
import {
  chosenQuoteOf,
  confirmBlockers,
  destinationChecks,
  expiresInOf,
  netOfShield,
  quoteLines,
  routeDetails,
  shieldTipOf,
  providerFeeCents,
  stepsAmountAtFixedPoint,
} from "./model";
import { commitDetails, commitExecution, commitLines, type SwapContext } from "./facts";
import { cappedSlippageBps, providerHealthy } from "./protectedChecks";
import { TARGETS, refOf, riskWord, sameChainTargets } from "./targets";
import { useCampaigns, useConnectivity, useOperation, usePoolStats, usePrefs, usePrices, useSession, useSettings, useNotes } from "../../hooks";
import { prefs } from "../../storage/prefs";

export interface SwapScreenProps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  /** the connected public wallet, if any: a destination equal to it is flagged */
  account?: string | null;
  onBack?: () => void;
  prefill?: SwapPrefill | null;
}

/** How long the user may pause between keystrokes before the quote is fetched. */
const QUOTE_DEBOUNCE_MS = 700;

export function SwapScreen(p: SwapScreenProps) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { submission, advanced, preference, verifyReads, secondFactor, protection } = useSettings();
  const net = useConnectivity(); // V6 Stage 15 (doc §75): no Confirm while offline
  useSession();
  useNotes();
  usePoolStats();
  const prices = usePrices();
  const running = useCampaigns().filter((c) => !TERMINAL_STATES.includes(c.state));
  const prefsNow = usePrefs();
  const assets = useMemo(() => assetsOf(p.deployment), [p.deployment]);
  const [fromAsset, setFromAsset] = useState<Asset | undefined>(() => assets.find((a) => a.vault === p.prefill?.fromVault) ?? assets[0]);
  // the cross-chain targets, and (V6 Stage 12) the pool's assets this deployment receives into the protected balance
  const targets = useMemo(() => ({ ...sameChainTargets(assets, p.deployment), ...TARGETS }), [assets, p.deployment]);
  const [target, setTarget] = useState(() => (p.prefill?.target && targets[p.prefill.target] ? p.prefill.target : "BTC"));
  const [amount, setAmount] = useState(p.prefill?.amount ?? "");
  const [typed, setTyped] = useState(p.prefill?.destination ?? ""); // empty: the fresh address of this wallet
  const [delay, setDelay] = useState(false);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  const [terms, setTerms] = useState<FeeTerms | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [compare, setCompare] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [destAck, setDestAck] = useState(false);
  const [routeAck, setRouteAck] = useState(false);
  const [blocked, setBlocked] = useState<BlockerCode | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [holders, setHolders] = useState<number | null>(null);
  const [stepsSeed, setStepsSeed] = useState(() => cryptoSeed()); // V7 Stage 13: the pieces of this quote's steps (the dry run and the plan alike)

  const to = targets[target] ?? TARGETS.BTC;
  const intoProtected = !!to.protected; // a same-chain swap: the destination is the protected balance (spec v2.0 §11.2)
  const chain = chainKindOf(to.ref.chain);
  const units = fromAsset ? parseAmount(fromAsset, amount) : 0n;
  const fresh = peekFreshAddress(p.masterSeed, chain).address;
  const edited = typed.trim() !== "";
  const destination = edited ? typed.trim() : fresh;
  const known = useMemo(() => knownRecipients(p.deployment), [p.deployment]);
  const parsed = edited ? parseDestination(chain, typed, known) : null;
  const destinationOk = !edited || parsed?.ok === true;
  const otherChain = edited ? looksLikeChain(typed.trim()) : null;
  const priced = feedsConfigured(p.deployment);
  const assessment = fromAsset && units > 0n && priced ? priceStore.assess(units, fromAsset) : null;
  const usd = assessment && "usd" in assessment.value ? assessment.value.usd : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  // V7 Stage 13 (spec v3.0 §4; the owner's decision 4): over $100,000 the high-value layer is the Advanced experience's — Simple
  // gets the card with the switch; the band below stays open to everyone
  const advancedGate = atLeast(tier, "enhanced") && prefsNow.experience !== "advanced";
  // the band's exposure limit (the owner's decision 3; sdk/tiers MAX_IN_FLIGHT): one protected operation of the $50K–$100K
  // band in flight per wallet — the wallet's own count of its open orders and running campaigns of the band
  const limitReached = tier === "large-protected" && inFlightLimitReached();
  const destCheck = edited && parsed?.ok ? destinationCheck(chain, destination, { tier }) : null;
  const destinationLocked = controls.destinationLock && !!destCheck && !destCheck.ok;
  const balance = fromAsset ? noteStore.balance(BigInt(fromAsset.vault)) : 0n;
  // the merges the funding needs first, each paying the relayer's minimum (the review round of 2026-11-03, E3; the Send Review has
  // had them since r43): named on the Review, bounded at the funding — they had been paid at the live fee, unshown and unbounded
  const mergeEach = terms?.minimum ?? 0n;
  const mergePlan =
    fromAsset && units > 0n && mergeEach > 0n
      ? mergeSchedule(
          noteStore.unspent(BigInt(fromAsset.vault)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })),
          units,
          mergeEach,
        )
      : null;
  const mergeCount = mergePlan?.pairs.length ?? 0;
  // what leaves with the merges the funding needs first, and whether the notes can pay it at all (the seventh review round, 2026-11-03): a
  // swap the balance could not cover with its merges had been quoted and confirmed on its amount alone, as Send never was
  const mergesShort: "balance" | "too-many-merges" | null =
    mergePlan && !mergePlan.ok
      ? mergePlan.reason === "too-many-merges"
        ? "too-many-merges"
        : "balance"
      : units + mergeEach * BigInt(mergeCount) > balance
        ? "balance"
        : null;
  const policy = quotes?.policy ?? policyFromPreference(preference);
  useEffect(() => {
    if (priced) void priceStore.refresh(p.deployment);
  }, [p.deployment, priced]);
  useEffect(() => {
    if (!p.deployment || !fromAsset || units <= topBucket(fromAsset.decimals)) {
      setHolders(null);
      return;
    }
    let live = true;
    holdersAbove(p.deployment, fromAsset.vault, units)
      .then((h) => {
        if (live) setHolders(h);
      })
      .catch(() => {
        if (live) setHolders(null);
      });
    return () => {
      live = false;
    };
  }, [p.deployment, units, fromAsset]);

  // the quote, fetched as the user types (debounced); a newer request makes an older answer stale and cancels its request
  // (V6 Stage 16: nothing waits on an answer nobody reads; an aborted request never counts toward offline)
  const seq = useRef(0);
  const quotable = !!p.deployment && !!fromAsset && units > 0n && units <= balance && mergesShort === null && destinationOk;
  useEffect(() => {
    setQuotes(null);
    setQuoteError(null);
    setBlocked(null);
    setProvider(null);
    const mine = ++seq.current;
    if (!quotable || !fromAsset || !p.deployment) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    const deployment = p.deployment;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const read = submission.kind === "relayer" ? await feeTerms(deployment, submission, fromAsset.vault) : null;
          const tm: FeeTerms | null = read ? { minimum: read.fee.amount, feePercentBps: read.info.feePercentBps ?? 0 } : null;
          const split = tm ? swapFunding(units, tm) : null;
          if (split?.tooSmall) throw new Error(t("swap.tooSmallForFees"));
          const set = await swapService.quote(
            {
              from: refOf(fromAsset),
              to: to.ref,
              amount: (split ? split.delivered : units).toString(),
              grossAmount: units.toString(), // what the user pays: the §46 quote states p of this, not of the escrow's funding (spec v3.0 §3)
              destination: "", // the engine quotes a placeholder: the destination is sent at the confirmation (spec v2.0 §13.2)
              slippageBps: controls.strictQuote ? cappedSlippageBps(50) : 50,
              preference,
              ...(assessment ? { tier: assessment.tier } : {}),
              destinationKind: edited ? "entered" : "fresh",
              preferNative: preference === "native",
              mode: protection.mode,
              ...(intoProtected ? { destinationType: "protected" as const } : {}),
            },
            abort.signal,
          );
          if (seq.current !== mine) return;
          setTerms(tm);
          setQuotes(set);
          setStepsSeed(cryptoSeed()); // a new quote set: a new draw of the steps' pieces
          setQuotedAt(Date.now());
          setNow(Date.now());
          setQuoteError(set.chosen ? null : t("swap.noRoute"));
        } catch (e) {
          if (seq.current === mine && !abort.signal.aborted) setQuoteError(classify(e).detail || String(e));
        } finally {
          if (seq.current === mine) setQuoting(false);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // the band too (2026-10-17, the audit's unverified m57): a quote fetched at the fail-safe band before the prices loaded,
    // or just across the $50K line, carried another band's protection plan into the Review and the steps
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the quote follows what the user chose and its band, not the price store's ticks
  }, [quotable, units, fromAsset, target, edited, preference, protection.mode, submission, p.deployment, refresh, tier]);
  // the countdown while a quote is shown
  useEffect(() => {
    if (!quotes) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quotes]);

  const chosen = provider && quotes ? (quotes.scores.find((s) => s.provider === provider) ?? quotes.chosen) : quotes?.chosen;
  const routeQuotes = quotes && chosen ? { ...quotes, chosen } : quotes;
  const quote = chosenQuoteOf(routeQuotes);
  const expiresIn = expiresInOf(routeQuotes, now);
  const expired = !!quote && expiresIn !== null && expiresIn <= 0;
  const timing = fromAsset ? fundingTiming(BigInt(fromAsset.vault), units, now) : { ageSeconds: null, depositsSince: null };
  // the USD lines' prices at the time of use (audit round 2, n18): one kept after failed refreshes is stale by then
  const priceFrom = fromAsset ? availablePrice(prices.prices, fromAsset.symbol, Math.floor(now / 1000)) : null;
  const priceTo = availablePrice(prices.prices, to.ref.symbol, Math.floor(now / 1000));
  const protectionPlan = quotes?.protection ?? null;
  // V7 Stage 13 (spec v3.0 §4; the owner's decision 3): the $50K band is a Protected Large Swap — ONE order by default (Hold to
  // Confirm, the exposure limit, the verified destination, the route's measured liquidity, recovery monitoring). It runs as
  // protected steps — the V3 planner's varied pieces under the quarter cap, one at a time — only when the service's plan says
  // `staged` (a thin route) or the user asked under Advanced ("Protected steps"); above $100K the V3/V4 screens take a staged
  // order. A swap into the protected balance stays one order (the steps' receivers are a follow-up), with the hold from $50K.
  const protectedSteps =
    !intoProtected && !!protectionPlan && protection.enabled && tier === "large-protected" && (protectionPlan.staged || protection.stepsAtBand === true);
  // the service's liquidity qualification rides on its §46 quote (spec v3.0 §4): a route whose measured limit is below the order
  const serviceBlockers = quotes?.quote?.risk.blockers ?? [];
  const routeUnqualified = serviceBlockers.includes("route_not_qualified");
  const campaignMode =
    !intoProtected &&
    !protectedSteps &&
    !!protectionPlan &&
    protection.enabled &&
    (controls.campaign || (tier === "enhanced" && (protectionPlan.staged || protection.protectFromEnhanced)));
  // "Delay for more privacy" (spec v2.0 §14.1): offered while the funds the swap would spend were protected recently, on
  // a one-order swap (the steps of a protected execution have their own timing); it spends older notes first — funded at
  // once from them — else the funding waits a random 1–24 h. The card stays while the choice is on.
  const recentFunds = !!fromAsset && units > 0n && timingOfFunding(timing) >= 1;
  // never under "Fastest" (c39): it has no delay budget, so a delayed funding could only miss the order's window
  const delayOffered = recentFunds && !protectedSteps && !campaignMode && policy !== "fastest";
  const delayOn = delay && delayOffered;
  const older = delayOn && fromAsset ? olderFunding(BigInt(fromAsset.vault), units, now) : null;
  // the amount an observer sees is what leaves the pool for the escrow — the typed amount less the fee note (the sixth review
  // round, 2026-11-03): the fact was judged on the typed amount before, and a bucket typed never reached the chain as one
  const leaving = terms ? swapFunding(units, terms).delivered : units;
  const wholeNote = fromAsset && units > 0n ? isWholeNote(noteStore.unspent(BigInt(fromAsset.vault)), units) : false;
  const privacy =
    fromAsset && units > 0n
      ? assessSwapPrivacy({
          sourceIsPool: true,
          amount: { kind: isBucketFor(fromAsset, leaving) && !wholeNote ? "bucket" : "exact" },
          timing: older ? older.timing : timing,
          ...(delayOn && !older ? { delaySeconds: DELAY_WINDOW.balanced[0] } : {}),
          destination: edited ? "entered" : "fresh",
          provider: { linkPublic: quotes && chosen ? (quotes.links?.[chosen.provider]?.public ?? true) : null },
          crossChain: to.ref.chain !== "ethereum",
        })
      : null;
  // the steps the planner makes of this amount (a dry run), and the amount they fund so that their fees stay inside it; the
  // dry run and the confirmed plan draw the same pieces from one seed per quote (varied sizes, never a recognisable pattern)
  const stepsPlan = (() => {
    if (!protectedSteps || !quotes || !chosen || !fromAsset || units <= 0n) return null;
    const destinationPolicy = edited ? { kind: "entered" as const, address: destination } : { kind: "fresh-per-tranche" as const };
    const draft = (amount: bigint) =>
      buildCampaign({
        quotes,
        provider: chosen.provider,
        from: refOf(fromAsset),
        fromAsset,
        to: to.ref,
        amount,
        tier,
        mode: protection.mode,
        preference,
        policy,
        destination: destinationPolicy,
        usd,
        capBps: protection.capBps,
        terms, // the relayer's F at the Review bounds every piece's funding (spec v3.0 §3; V7 Stage 12)
        now,
        rng: seededUniform(stepsSeed),
      });
    try {
      // the count at its own amount (c50): varied pieces may be one more or less of a smaller amount
      const { n, amount } = stepsAmountAtFixedPoint(units, terms, (a) => draft(a).tranches.length);
      return amount > 0n ? { n, amount, destinationPolicy } : null;
    } catch {
      return null;
    }
  })();
  const lintItems =
    quotes && chosen && fromAsset
      ? walletLint({
          action: "swap",
          tier,
          deployment: p.deployment,
          settings: { submission, verifyReads },
          account: p.account ?? null,
          amount: units,
          decimals: fromAsset.decimals,
          amountIsBucket: isBucketFor(fromAsset, leaving),
          amountIsWholeNote: wholeNote,
          holders,
          acknowledged,
          destination,
          destinationKind: edited ? "entered" : "fresh",
          delaySeconds: delayOn && !older ? DELAY_WINDOW.balanced[0] : 0,
          quotes,
          chosenProvider: chosen.provider,
        })
      : null;
  const lintBlocked = lintItems ? unacknowledgedBlocks(lintItems).length > 0 : false;
  const needsDestAck = edited && atLeast(tier, "large");
  const health = chosen ? providerHealthy(quotes?.risk?.[chosen.provider]) : { ok: true as const };
  const model = fromAsset
    ? {
        pay: {
          symbol: fromAsset.symbol,
          decimals: fromAsset.decimals,
          amount,
          balance: amountOf(balance, fromAsset.symbol, fromAsset.decimals),
          usd: usd !== null ? `≈ ${formatUsd(usd)}` : null,
        },
        receive: { symbol: to.ref.symbol, chain: to.network },
        destination:
          to.ref.chain !== "ethereum"
            ? {
                value: edited ? typed : fresh,
                fresh: !edited,
                checks: destinationChecks(
                  { value: destination, fresh: !edited, ok: destinationOk, reason: parsed && !parsed.ok ? parsed.reason : undefined, otherChain },
                  chain,
                ),
                error: parsed && !parsed.ok ? destinationWords(t, parsed) : null,
              }
            : null,
        quote:
          routeQuotes && fromAsset
            ? quoteLines({
                quotes: routeQuotes,
                terms,
                units,
                from: { symbol: fromAsset.symbol, decimals: fromAsset.decimals, usd1e8: priceFrom?.usd1e8 ?? null },
                to,
                toUsd1e8: priceTo?.usd1e8 ?? null,
                privacy,
                proofMs: session.isUnlocked() && session.journal().proofStats ? proofEstimateMs() : null,
              })
            : null,
        expiresIn,
        expired,
        quoting,
        noRoute: !quoting
          ? units > balance && units > 0n
            ? t("send.notEnough", { symbol: fromAsset.symbol })
            : units > 0n && mergesShort === "too-many-merges"
              ? t("op.error.housekeeping_needed.reason")
              : units > 0n && mergesShort === "balance"
                ? t("op.error.insufficient_balance.reason")
                : quoteError
          : null,
        privacy: recentFunds ? { recent: true, delay: delayOn, older: !!older } : null,
        notice: assessment && tier !== "standard" ? (assessment.failSafe ? t("swap.largeFailSafe") + t("swap.largeNotice") : t("swap.largeNotice")) : null,
        details: advanced && routeQuotes ? routeDetails(routeQuotes, to, privacy, chosen ? riskWord(chosen.components.security) : "—") : null,
        // V7 Stage 13: the Advanced gate over $100K, the band's exposure limit and the route's qualification close Review Swap
        gate: advancedGate ? { title: t("swap.advancedGate.title"), body: t("swap.advancedGate.body"), switchLabel: t("swap.advancedGate.switch") } : null,
        limit: limitReached ? t("swap.inFlight") : null,
        routeLimit: routeUnqualified ? t("swap.routeLimit") : null,
        canReview: !!quote && !expired && destinationOk && !destinationLocked && !busy && !advancedGate && !limitReached && !routeUnqualified,
      }
    : null;

  const addressStatus =
    controls.destinationLock && edited && parsed?.ok ? (
      <DestinationStatus chain={chain} address={destination} tier={tier} masterSeed={p.masterSeed} deployment={p.deployment} asset={to.ref.symbol} />
    ) : null;

  /** V6 Stage 13: the one confirmation of a protected execution — the blockers again, then the steps journaled and released by the runner. */
  async function confirmProtected() {
    if (!fromAsset || !quote || !quotes || !chosen || !p.deployment || !stepsPlan) return;
    const blockers = confirmBlockers({
      now: Date.now(),
      quotedAt,
      quote,
      approvedMin: BigInt(quote.toAmountMin),
      destinationValid: destinationOk,
      providerHealthy: health.ok,
      chainId: p.deployment.chainId,
      crossChain: to.ref.chain !== "ethereum",
      ...(usd !== null ? { usd } : {}),
      largeTrade: true,
      strictQuote: true,
      inFlight: { count: protectedInFlight(), limit: PROTECTED_EXECUTION.MAX_IN_FLIGHT },
      serviceBlockers,
    });
    if (blockers.length) {
      setBlocked(blockers[0]);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const at = Date.now();
      const gasPriceWei =
        submission.kind === "relayer"
          ? await relayerInfo(submission.url).then(
              (i) => i.gasPriceWei,
              () => null,
            )
          : null;
      const c = startCampaign({
        quotes,
        provider: chosen.provider,
        from: refOf(fromAsset),
        fromAsset,
        to: to.ref,
        amount: stepsPlan.amount,
        leaves: units, // what may leave the protected balance, the steps' fee notes included (audit round 2, r18)
        // the set was quoted for the whole funding (one fee note), the steps run a smaller amount (audit c49)
        quotedAmount: terms ? swapFunding(units, terms).delivered : units,
        tier,
        mode: protection.mode,
        preference,
        policy,
        destination: stepsPlan.destinationPolicy,
        usd,
        lint: lintItems,
        capBps: protection.capBps,
        providerShareCapBps: protection.providerShareCapBps,
        terms, // the Review's terms bound every step's funding — F × n (spec v3.0 §3; the review round of 2026-11-02: the band's steps had run without them)
        crossRateE18: crossRateFromPrices({ request: { from: refOf(fromAsset), to: to.ref } } as never),
        gasPriceWei,
        confirmations: edited && destAck ? { destinationVerified: at } : {},
        rng: seededUniform(stepsSeed), // the Review's pieces (the dry run's seed)
        now: at,
      });
      // the confirmed Review is not shown again (c48, audit round 2 r15): Back had re-shown it, one hold from a second campaign
      navigate(`/swap/steps/${c.id}`, { replace: true });
    } catch (e) {
      setStatus(classify(e).detail || String(e));
    } finally {
      setBusy(false);
    }
  }

  /** The one confirmation: the blockers again, then the order committed and handed to the runner. */
  async function confirm() {
    if (!fromAsset || !quote || !quotes || !chosen || !p.deployment) return;
    const blockers = confirmBlockers({
      now: Date.now(),
      quotedAt,
      quote,
      approvedMin: BigInt(quote.toAmountMin),
      destinationValid: destinationOk,
      providerHealthy: health.ok,
      chainId: p.deployment.chainId,
      crossChain: to.ref.chain !== "ethereum",
      ...(usd !== null ? { usd } : {}),
      largeTrade: atLeast(tier, "large-protected"),
      strictQuote: controls.strictQuote,
      ...(tier === "large-protected" ? { inFlight: { count: protectedInFlight(), limit: PROTECTED_EXECUTION.MAX_IN_FLIGHT } } : {}),
      serviceBlockers,
    });
    if (blockers.length) {
      setBlocked(blockers[0]);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      // the fresh address is reserved now; into the protected balance the order pays a shield receiver built at the commit,
      // and a fresh address of this wallet is its fallback for a token the pool cannot hold
      const dest = intoProtected ? "" : edited ? destination : consumeFreshAddress(p.masterSeed, chain).address;
      const shield = intoProtected
        ? { shieldTip: shieldTipOf(quotes), fallbackRecipient: consumeFreshAddress(p.masterSeed, "evm").address as `0x${string}` }
        : undefined;
      // V7 Stage 14 (spec v3.0 §5): the commit goes through the swap provider facade — the same confirmOrder underneath (the
      // order journaled, the runner's tick planned); the runner reads the provider call at funding and at signing (withCall: false)
      const facade = walletSwapProvider({ masterSeed: p.masterSeed, deployment: p.deployment });
      const r = await facade.prepare(
        {
          request: {
            from: refOf(fromAsset),
            to: to.ref,
            amount: (terms ? swapFunding(units, terms).delivered : units).toString(),
            destination: dest,
            slippageBps: controls.strictQuote ? cappedSlippageBps(50) : 50,
            preference,
            ...(assessment ? { tier: assessment.tier } : {}),
            destinationKind: edited ? "entered" : "fresh",
            preferNative: preference === "native",
            mode: protection.mode,
          },
          set: quotes,
          chosen: quote,
          quote: quotes.quote ?? null,
        },
        {
          policy,
          provider: chosen.provider,
          fromAsset,
          lint: lintItems,
          preference,
          walletTier: assessment ? tier : null,
          ...(shield ? { shield } : {}),
          // the relayer's fee the Review showed bounds the funding's (the audit round of 2026-10-16, c46)
          ...(terms ? { reviewedFee: units - swapFunding(units, terms).delivered } : {}),
          // each merge at most the Review's F (E3), and no more merges than it named (the eighth review round, B-2): none named is none run
          ...(terms ? { reviewedMergeFee: terms.minimum, reviewedMerges: mergeCount } : {}),
          ...(quotes.executorTip !== undefined ? { shownTip: BigInt(quotes.executorTip) } : {}), // the order built on the tip the Review showed (B5)
          delay: delayOn,
          ...(older ? { maxTiming: older.maxTiming } : {}),
          withCall: false,
        },
      );
      // the confirmed Review is not shown again (c48); the URL names the record by its handle, never the order id (c41)
      navigate(`/swap/progress/${routeHandle(swapRecordId(r.stored.orderId))}`, { replace: true });
    } catch (e) {
      const c = classify(e);
      // the tip the Review showed and today's parted (the eighth review round, H1): the wallet's words, not the service's figures
      setStatus(c.code === "tip_moved" ? t("op.error.tip_moved.reason") : c.detail || String(e));
    } finally {
      setBusy(false);
    }
  }

  const fromOptions: AssetOption[] = assets.map((a) => ({
    id: a.vault,
    symbol: a.symbol,
    name: a.symbol,
    decimals: a.decimals,
    ...(a.token ? { address: a.token } : {}),
  }));
  const toOptions: AssetOption[] = Object.values(targets)
    .filter((x) => !(x.protected && x.ref.asset === (fromAsset?.token ?? "native"))) // never the asset paid with
    .map((x) => ({
      id: x.id,
      symbol: x.ref.symbol,
      name: x.network,
      decimals: x.ref.decimals,
      chain: x.network,
    }));
  const reset = () => {
    setAcknowledged([]);
    setDestAck(false);
    setRouteAck(false);
    setBlocked(null);
    setStatus("");
  };

  const form =
    model && fromAsset ? (
      <>
        <SwapView
          model={model}
          addressStatus={addressStatus}
          footer={
            running.length ? (
              // the protected swaps still running: their view is the protected screen's until Stage 13
              <Card testId="protected-swaps">
                <p className="ds-kv-label">{t("swap.yourProtectedSwaps")}</p>
                {running.map((c) => (
                  <ListRow
                    key={c.id}
                    title={`${c.request.from.symbol} → ${c.request.to.symbol}`}
                    subtitle={campaignLineText(t, c, advanced)}
                    trailing={
                      <Button
                        variant="secondary"
                        // the band's steps on the V6 page; above $100K the V3/V4 view stays (spec v2.0 §2)
                        onClick={() =>
                          c.tier === "large-protected" ? navigate(`/swap/steps/${c.id}`) : navigate("/swap/protected", { state: { campaignId: c.id } })
                        }
                      >
                        {t("swap.open")}
                      </Button>
                    }
                  />
                ))}
              </Card>
            ) : null
          }
          actions={{
            onAmount: (v) => {
              setAmount(v);
              reset();
            },
            onPayAsset: () => setPicking("from"),
            onReceiveAsset: () => setPicking("to"),
            onReview: () =>
              campaignMode
                ? navigate("/swap/protected", { state: { prefill: { fromVault: fromAsset.vault, amount, target, ...(edited ? { destination } : {}) } } })
                : navigate("/swap/review"),
            onNewQuote: () => setRefresh((n) => n + 1),
            ...(advanced && quotes ? { onCompare: () => setCompare(true) } : {}),
            onDestination: (v) => {
              setTyped(v);
              reset();
            },
            onFreshDestination: () => {
              setTyped("");
              reset();
            },
            ...(delayOffered ? { onDelay: setDelay } : {}),
            onAdvanced: (on) => prefs().update({ experience: on ? "advanced" : "simple" }),
            ...(balance > 0n
              ? {
                  // the merges a spend of every note needs are paid out of it (the audit's unverified m55)
                  onMax: () => {
                    if (noteStore.unspent(BigInt(fromAsset.vault)).length <= 2 || !p.deployment) return setAmount(formatAmount(fromAsset, balance));
                    void maxSpendable(p.deployment, fromAsset.vault).then(
                      (m) => setAmount(formatAmount(fromAsset, m)),
                      () => setAmount(formatAmount(fromAsset, balance)),
                    );
                  },
                }
              : {}),
            onBack: p.onBack,
          }}
        />
        <AssetSelector
          open={picking === "from"}
          onClose={() => setPicking(null)}
          assets={fromOptions}
          value={fromAsset.vault}
          onChange={(id) => {
            const a = assets.find((x) => x.vault === id);
            if (a) {
              setFromAsset(a);
              setAmount("");
              if (to.protected && to.ref.asset === (a.token ?? "native")) setTarget("BTC"); // the asset paid with is no destination
              reset();
            }
            setPicking(null);
          }}
          title={t("swap.from")}
          searchLabel={t("protect.search")}
          testId="swap-from-selector"
        />
        <AssetSelector
          open={picking === "to"}
          onClose={() => setPicking(null)}
          assets={toOptions}
          value={target}
          onChange={(id) => {
            if (targets[id]) {
              setTarget(id);
              if (targets[id].ref.chain !== to.ref.chain || targets[id].protected) setTyped(""); // another chain, or the protected balance: no typed address
              reset();
            }
            setPicking(null);
          }}
          title={t("swap.to")}
          searchLabel={t("protect.search")}
          testId="swap-to-selector"
        />
        {advanced && quotes ? (
          <CompareRoutes
            open={compare}
            onClose={() => setCompare(false)}
            quotes={quotes}
            to={to.ref}
            advanced={advanced}
            onUse={(prov) => {
              setProvider(prov);
              setCompare(false);
              navigate("/swap/review");
            }}
            busy={busy}
          />
        ) : null}
      </>
    ) : (
      <Page title={t("screen.swap.title")} back={p.onBack} testId="swap-view">
        <p className="ds-note-warn">{t("protect.noDeployment")}</p>
      </Page>
    );

  const reviewPage = (() => {
    if (!fromAsset || !quote || !quotes || !chosen || expired) return <Navigate to="/swap" replace />;
    const crossChain = to.ref.chain !== "ethereum";
    const price = priceFrom;
    const cents = (u: bigint) => (price ? centsOf(u, fromAsset.decimals, price.usd1e8) : null);
    const split = terms ? swapFunding(units, terms) : { privacy: 0n, network: 0n, delivered: units };
    const tip = BigInt(quotes.executorTip ?? "0");
    const stepsN = BigInt(stepsPlan?.n ?? 1); // a protected execution's steps each pay the relayer's F and their tip
    const providerCents = providerFeeCents(quote.fees, fromAsset.symbol, fromAsset.decimals, price?.usd1e8 ?? null); // integer cents (the policy's rule 1)
    const privacyCents = cents(split.privacy);
    // into the protected balance the relayer also gets the shield tip, in the output asset: what arrives is the delivery less it
    const shieldTip = intoProtected ? shieldTipOf(quotes) : 0n;
    const shieldCents = shieldTip > 0n ? (priceTo ? centsOf(shieldTip, to.ref.decimals, priceTo.usd1e8) : null) : 0n;
    const sourceRelayerCents = cents((split.network + tip) * stepsN);
    const relayerCents = sourceRelayerCents !== null && shieldCents !== null ? sourceRelayerCents + shieldCents : null;
    const mergeTotal = mergeEach * BigInt(mergeCount);
    const mergeCents = mergeCount ? cents(mergeTotal) : 0n;
    const fees: ReviewModel["fees"] = [
      ...(split.privacy > 0n
        ? [{ kind: "privacy" as const, usdCents: privacyCents, amount: amountOf(split.privacy, fromAsset.symbol, fromAsset.decimals) }]
        : []),
      {
        kind: "relayer" as const,
        ...(stepsN > 1n ? { count: Number(stepsN) } : {}), // F × n: the Review names the steps (spec v3.0 §3)
        ...(stepsN > 1n && tip > 0n ? { approx: true } : {}), // the tips are today's estimate: each step pays its own at its time, within the bounds (the third review round)
        usdCents: relayerCents,
        amount: amountOf((split.network + tip) * stepsN, fromAsset.symbol, fromAsset.decimals),
        ...(shieldTip > 0n ? { also: amountOf(shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain) } : {}),
      },
      ...(mergeCount
        ? [{ kind: "merges" as const, count: mergeCount, usdCents: mergeCents, amount: amountOf(mergeTotal, fromAsset.symbol, fromAsset.decimals) }]
        : []),
      { kind: "provider" as const, usdCents: providerCents },
    ];
    const totalFeesUsdCents =
      privacyCents !== null && relayerCents !== null && mergeCents !== null ? privacyCents + relayerCents + mergeCents + providerCents : null;
    // what leaves: the amount and the merges the funding needs first (the seventh review round)
    const leaves = units + mergeTotal;
    if (atLeast(tier, "enhanced")) {
      // from $100K the V2–V4 Review stays as it was (spec v2.0 §2), with one confirmation after it — and states every fee (the seventh
      // review round: it had stated none)
      const ctx: SwapContext = {
        t,
        quotes,
        fromAsset,
        to,
        units,
        usd,
        tier,
        controls,
        policy,
        preference,
        destination,
        destinationEdited: edited,
        parsedOk: destinationOk,
        destAck,
        routeAck,
        destCheck,
        destinationLocked,
        lintItems,
        protection: { mode: protection.mode, capBps: protection.capBps },
        relayerFee: null,
      };
      const score = quotes.scores.find((s) => s.provider === chosen.provider) ?? chosen;
      return (
        <Page title={t("route.swap")} back={() => navigate("/swap")} testId="swap">
          <Review
            moment="commit"
            tier={tier}
            controls={controls}
            usd={cents(leaves) !== null ? formatUsdCents(cents(leaves)!) : usd !== null ? formatUsd(usd) : null}
            amount={`${formatAmount(fromAsset, leaves)} ${fromAsset.symbol}`}
            fees={feeRowsText(t, { kind: crossChain ? "cross-chain" : "swap", fees, totalFeesUsdCents })}
            from={t("swap.fromProtected", { symbol: fromAsset.symbol })}
            to={{
              network: to.network,
              asset: to.ref.symbol,
              address: intoProtected ? "" : destination,
              kind: intoProtected ? "privacy-address" : edited ? "entered" : "fresh",
              ...(intoProtected ? { label: t("screen.swap.protectedBalance") } : {}),
            }}
            receiveMin={`${displayAmount(amountOf(BigInt(quote.toAmountMin) - (intoProtected ? shieldTipOf(quotes) : 0n), to.ref.symbol, to.ref.decimals, to.ref.chain), "down")} ${to.ref.symbol}`}
            execution={commitExecution(ctx, quote)}
            privacy={{ level: levelOf(privacy?.score ?? score.components.privacy), score: privacy?.score ?? score.components.privacy }}
            lint={lintItems ?? []}
            onAcknowledgeLint={(id) => setAcknowledged((a) => [...a, id])}
            lines={commitLines(
              ctx,
              chosen.provider,
              quote,
              () => setRouteAck(true),
              () => setDestAck(true),
            )}
            issuer={issuerControlled(fromAsset.symbol) || issuerControlled(to.ref.symbol)}
            routeKind={routeKind(refOf(fromAsset), to.ref, quote.nativeAssets)}
            crossChain={crossChain}
            details={commitDetails(ctx, chosen.provider, quote, score)}
            advanced={advanced}
            secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null}
            secondDevice={controls.secondDevice ? { credentialId: protection.secondDevice.credentialId } : null}
            busy={busy ? t("swap.committing") : undefined}
            error={
              !busy
                ? status || (blocked ? `${t("screen.review.blocked.title")}. ${t(BLOCKER_WORDS[blocked])} ${t("screen.review.blocked.notMoved")}` : undefined)
                : undefined
            }
            protectedExecution={controls.protectedExecution}
            onConfirm={() => confirm()}
            onCancel={() => navigate("/swap")}
          />
        </Page>
      );
    }
    const large = atLeast(tier, "large-protected");
    // the steps' price bound (V3 §3; the third review round, 2026-11-03): the band's Review had stated the one order's minimum and "Quote
    // locked" while the steps were held to the quote's minimum per unit less 0.5 % over their smaller amount — it states that bound now
    const stepsMinimum =
      stepsPlan && stepsPlan.n > 1
        ? campaignMinimumOutput({
            toAmountMin: BigInt(quote.toAmountMin),
            quoted: split.delivered,
            amount: stepsPlan.amount,
            executorTip: quotes.executorTip !== undefined ? tip : null,
            steps: stepsPlan.n,
          })
        : null;
    const review: ReviewModel = {
      kind: crossChain ? "cross-chain" : "swap",
      pay: { usdCents: cents(leaves), amount: amountOf(leaves, fromAsset.symbol, fromAsset.decimals) }, // the merges included, as Send (B4)
      receive: { amount: amountOf(BigInt(quote.toAmount) - shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain), approx: true },
      minimum: amountOf((stepsMinimum ?? BigInt(quote.toAmountMin)) - shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain),
      fees,
      totalFeesUsdCents,
      destination: {
        label: crossChain ? (edited ? `${destination.slice(0, 6)}…${destination.slice(-4)}` : t("send.freshEntry")) : t("screen.swap.protectedBalance"),
        verified: !edited || destAck,
      },
      protection: privacy?.level ?? "medium",
      large,
      steps: stepsPlan?.n ?? null, // V7 Stage 13: the card says "One order" or the steps planned
      hold: controls.hold,
      confirmDisabled: busy || lintBlocked || destinationLocked || (needsDestAck && !destAck) || !health.ok || !net.online,
      blocked,
    };
    const extra = (
      <>
        {lintItems && (controls.lint || edited) ? <PrivacyLint items={lintItems} compact onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} /> : null}
        {needsDestAck ? (
          <Card padding="md" testId="swap-destination-ack">
            <h2 className="ds-card-title">{t("screen.swap.destinationVerified")}</h2>
            <p className="ds-mono-break" data-testid="swap-destination-full">
              {destination}
            </p>
            {destAck ? (
              <p className="ds-note">✓ {t("screen.send.reviewDestinationDone")}</p>
            ) : (
              <Button variant="secondary" onClick={() => setDestAck(true)} data-testid="swap-destination-ack-button">
                {t("screen.send.reviewDestinationBody")}
              </Button>
            )}
          </Card>
        ) : null}
        {!health.ok ? (
          <p className="ds-note-warn" data-testid="swap-route-health">
            {t(`op.error.${health.code}.reason` as never)}
          </p>
        ) : null}
        {delayOn ? (
          <p className="ds-note" data-testid="swap-review-delay">
            {t(older ? "screen.swap.delayOlderNote" : "screen.swap.delayNote")}
          </p>
        ) : null}
        {status ? (
          <p className="ds-note-warn" data-testid="swap-status">
            {status}
          </p>
        ) : null}
      </>
    );
    return (
      <ReviewView
        model={review}
        actions={{
          onConfirm: () => void (stepsPlan ? confirmProtected() : confirm()),
          onEdit: () => navigate("/swap"),
          onReviewAgain: () => {
            setBlocked(null);
            setRefresh((n) => n + 1);
            navigate("/swap");
          },
        }}
        extra={extra}
        holdMs={holdMs()}
      />
    );
  })();

  return (
    <Routes>
      <Route index element={form} />
      <Route path="review" element={reviewPage} />
      <Route
        path="progress/:opId"
        element={<SwapProgress masterSeed={p.masterSeed} deployment={p.deployment} onDone={() => navigate("/")} onNew={() => navigate("/swap")} />}
      />
      <Route path="steps/:campaignId" element={<SwapSteps advanced={advanced} onDone={() => navigate("/")} onNew={() => navigate("/swap")} />} />
      <Route
        path="protected"
        element={
          // the review round of 2026-11-02 (spec v3.0 §4): the V5 screen is the Advanced experience's (prefs.experience, the gate's
          // flag — not the settings' detail toggle) — reachable by URL, so it is gated here as well as by the Review; the Simple
          // experience reaches it only to see a campaign of the wallet's own
          prefsNow.experience === "advanced" || (location.state as { campaignId?: string } | null)?.campaignId ? (
            <Swap
              masterSeed={p.masterSeed}
              deployment={p.deployment}
              account={p.account}
              onBack={() => navigate("/swap")}
              prefill={(location.state as { prefill?: SwapPrefill } | null)?.prefill ?? null}
              campaignId={(location.state as { campaignId?: string } | null)?.campaignId ?? null}
            />
          ) : (
            <Navigate to="/swap" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/swap" replace />} />
    </Routes>
  );
}

/**
 * /swap/steps/:campaignId — a protected execution (V6 Stage 13; spec v2.0 §7.7, §13.5): the amounts only (completed,
 * executing, remaining), the line of the step in hand, "Return the rest"; a pause with its reason and the way on (a changed
 * route is reviewed on the protected screen); the result. The steps run from any screen while the wallet is unlocked.
 */
function SwapSteps(p: { advanced: boolean; onDone: () => void; onNew: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { campaignId } = useParams();
  const c = useCampaigns().find((x) => x.id.toLowerCase() === (campaignId ?? "").toLowerCase());
  if (!c) return <Navigate to="/swap" replace />;
  const model = campaignProgressModel(c);
  const total = model.large ? formatUsd(Number(model.large.totalUsdCents) / 100) : `${c.request.from.symbol}`;
  const pair = `${c.request.from.symbol} → ${c.request.to.symbol}`;
  if (c.state === "completed" || c.state === "cancelled") {
    return (
      <Page title={t("screen.swap.title")} back={p.onDone} testId="swap-view">
        <SuccessCard
          testId="swap-steps-done"
          title={
            c.state === "completed"
              ? t("screen.swap.stepsDone", { usd: total, pair })
              : // steps delivered before it was cancelled: part of it is complete, never "Returned" alone (the audit's unverified m58)
                exposure(c).completed > 0n
                ? t("screen.swap.stepsPartly", { pair })
                : t("screen.swap.returned")
          }
          actions={
            <>
              <Button onClick={p.onDone} data-testid="swap-finish">
                {t("send.doneButton")}
              </Button>
              <Button variant="secondary" onClick={p.onNew} data-testid="swap-again">
                {t("screen.swap.again")}
              </Button>
            </>
          }
        />
      </Page>
    );
  }
  const winding = c.state === "winding-down";
  if (c.state === "paused" || c.state === "rerouting") {
    // the pause in the catalog's words (audit round 2, n87): its code's title and reason — the runner's own English detail under
    // Advanced; a step that runs longer than expected reads as a delay, not an anomaly
    const code = c.pause ? (c.pause.reason === "user" ? "user_pause" : c.pause.reason.replace(/-/g, "_")) : null;
    const delayed = c.pause?.reason === "anomaly" && /longer than expected/i.test(c.pause.detail);
    // a pause whose funds class is unknown (a funding sent and not confirmed, an anomaly, an unexpected destination) never says the
    // funds are safe (audit round 2, p05): the funding may be on its way to its escrow
    const unknownFunds = code !== null && CATALOG[code]?.fundsClass === "unknown";
    return (
      <Page title={t("screen.swap.title")} back={p.onNew} testId="swap-view">
        <Card padding="md" testId="swap-steps-paused">
          <h2 className="ds-card-title">{code ? t(delayed ? "op.delayed" : (titleKey(code) as MessageKey)) : t("screen.swap.stepsRouteChanged")}</h2>
          {code ? (
            <p className="ds-note" data-testid="swap-steps-reason">
              {t(reasonKey(code) as MessageKey)}
            </p>
          ) : null}
          {p.advanced && c.pause?.detail ? (
            <p className="ds-note" data-testid="swap-steps-detail">
              {c.pause.detail}
            </p>
          ) : null}
          {/* a step funded and not handed over waits for its swap or its refund time, never in the protected balance (the audit
              round of 2026-10-16, c51) */}
          <p className="ds-note" data-testid="swap-steps-safe">
            {t(
              unknownFunds
                ? "op.funds.unknown"
                : c.tranches.some((x) => ["funded", "signed", "failed", "refunding"].includes(x.state))
                  ? "screen.swap.stepsSafeHeld"
                  : "screen.swap.stepsSafe",
            )}
          </p>
          <div className="ds-actions">
            {c.state === "rerouting" ? (
              <Button onClick={() => navigate("/swap/protected", { state: { campaignId: c.id } })} data-testid="swap-steps-review-route">
                {t("screen.swap.stepsReviewRoute")}
              </Button>
            ) : (
              <Button onClick={() => resumeCampaign(c.id)} data-testid="swap-steps-resume">
                {t("campaign.resume")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => cancelCampaign(c.id)} data-testid="swap-steps-return">
              {t("screen.swap.stepsReturn")}
            </Button>
          </div>
        </Card>
      </Page>
    );
  }
  return (
    <div data-state={c.state} data-testid="swap-steps">
      <ProgressView model={model} />
      <p className="ds-note" data-testid="swap-steps-note">
        {t(winding ? "screen.swap.stepsReturning" : "screen.swap.stepsNote")}
      </p>
      {!winding ? (
        <TextButton onClick={() => cancelCampaign(c.id)} data-testid="swap-steps-return">
          {t("screen.swap.stepsReturn")}
        </TextButton>
      ) : null}
      {p.advanced ? (
        <TextButton icon="chevron-right" onClick={() => navigate("/swap/protected", { state: { campaignId: c.id } })} data-testid="swap-steps-detail">
          {t("screen.swap.stepsDetail")}
        </TextButton>
      ) : null}
    </div>
  );
}

/**
 * The tracker's settlement label (its English code, journaled with the track as a string) in the reader's words (audit round 2,
 * n86); every label the tracker writes has its words, a label it does not know is shown as it is.
 */
const SETTLEMENT_WORDS: Record<string, MessageKey | undefined> = {
  Preparing: "settlement.preparing",
  "Waiting for source": "settlement.waitingSource",
  Executing: "settlement.executing",
  "Waiting for destination": "settlement.waitingDestination",
  Partial: "settlement.partial",
  Refunding: "settlement.refunding",
  Refunded: "settlement.refunded",
  Completed: "settlement.completed",
  "Not started": "settlement.notStarted",
  "Needs attention": "settlement.needsAttention",
} satisfies Record<SettlementLabel, MessageKey>;

/** /swap/progress/:opId — the operation's lines while it runs, the paused order's choice, the result. */
function SwapProgress(p: { masterSeed: Uint8Array; deployment: Deployment | null; onDone: () => void; onNew: () => void }) {
  const t = useT();
  const { opId } = useParams();
  const record = useOperation(opId ? idOfRoute(opId) : null);
  useSession();
  const [furthest, setFurthest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (record) setFurthest((f) => furthestLine(f, record));
  }, [record]);
  if (!record) return <Navigate to="/swap" replace />;
  const orderId = record.refs.orderId;
  const stored = orderId && session.isUnlocked() ? session.journal().swaps.find((x) => x.orderId.toLowerCase() === orderId.toLowerCase()) : undefined;
  const sym = record.amounts.outputAsset ?? "";
  const outDecimals = record.amounts.outputDecimals ?? 18;
  const act = (f: () => Promise<unknown> | unknown) => async () => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(classify(e).detail || String(e));
    } finally {
      setBusy(false);
    }
  };
  const giveBack = act(() => returnFunds(orderId!, { masterSeed: p.masterSeed, deployment: p.deployment }));
  const intoProtected = !!stored?.shield;
  // an order the runner stopped before anything was swapped says why, with "Review again" (2026-10-14: an expired order's
  // and an unconfirmed funding's reasons had been hidden behind the plain cancelled card; a V6 follow-up of 2026-10-16: a
  // relayer that does not run the swap service's orders, or a key the swap service no longer takes)
  if (
    record.state === "CANCELLED" &&
    [
      "older_notes_unavailable",
      "order_expired",
      "funding_unconfirmed",
      "relayer_not_ready",
      "service_key_changed",
      "order_outdated",
      "fee_moved",
      "merges_moved",
      "tip_stale",
    ].includes(record.reason?.code ?? "")
  ) {
    return (
      <Page title={t("screen.swap.title")} back={p.onDone} testId="swap-view">
        <OperationProgress
          record={record}
          actions={
            <Button onClick={p.onNew} data-testid="swap-review-again">
              {t("screen.review.blocked.again")}
            </Button>
          }
        />
      </Page>
    );
  }
  if (record.state === "COMPLETED" || record.state === "REFUNDED" || record.state === "CANCELLED") {
    // what arrived, or no amount: never the minimum in its place (audit round 2, r54) — a provider that reports no amount
    // (Across, Mayan) had its worst case named as delivered, and a Mayan refund paid to the destination as the swap
    const delivered = record.amounts.delivered;
    // what came back, from the refund notes the scan found in the order's own asset, and that the privacy fee did not (the seventh review
    // round, 2026-11-03; docs/fee-policy.md §4: the refund screen names the amount that comes back)
    const returnedTitle = () => {
      const vault = String((stored?.params as { refundVault?: string } | undefined)?.refundVault ?? "").toLowerCase();
      const back = (stored?.refunds ?? []).filter((x) => x.vault.toLowerCase() === vault).reduce((a, x) => a + BigInt(x.amount), 0n);
      const from = (stored?.request as { from?: { symbol?: string; decimals?: number } } | undefined)?.from;
      return back > 0n && from?.symbol
        ? t("screen.swap.returnedAmount", { amount: displayAmount(amountFrom(back.toString(), from.symbol, from.decimals ?? 18), "down"), symbol: from.symbol })
        : t("screen.swap.returned");
    };
    const amountOf = (units: string) => displayAmount(amountFrom(units, sym, outDecimals), "down");
    // a finished swap that is not the order's whole delivery says so (the ninth review round, 2026-11-04, C-03/C-07): a refund the provider
    // paid at the destination had read "Swap complete.", and a partial fill "needs attention" for good
    const title =
      record.state === "COMPLETED"
        ? record.outcome === "partial"
          ? delivered
            ? t("screen.swap.donePartial", { amount: amountOf(delivered), symbol: sym })
            : t("screen.swap.donePartialNoAmount")
          : delivered
            ? t(intoProtected ? "screen.swap.doneProtected" : "screen.swap.done", { amount: amountOf(delivered), symbol: sym })
            : t("screen.swap.doneNoAmount")
        : record.state === "REFUNDED"
          ? returnedTitle()
          : t("screen.swap.cancelled");
    const finish = (
      <>
        <Button onClick={p.onDone} data-testid="swap-finish">
          {t("send.doneButton")}
        </Button>
        <Button variant="secondary" onClick={p.onNew} data-testid="swap-again">
          {t("screen.swap.again")}
        </Button>
      </>
    );
    if (record.state === "COMPLETED" && record.outcome === "refunded-at-destination")
      return (
        <Page title={t("screen.swap.title")} back={p.onDone} testId="swap-view">
          <WarningCard testId="swap-not-delivered" title={t("screen.swap.notDelivered", { symbol: sym })} action={finish} />
        </Page>
      );
    return (
      <Page title={t("screen.swap.title")} back={p.onDone} testId="swap-view">
        <SuccessCard
          testId="swap-done"
          title={title}
          actions={
            <>
              <Button onClick={p.onDone} data-testid="swap-finish">
                {t("send.doneButton")}
              </Button>
              <Button variant="secondary" onClick={p.onNew} data-testid="swap-again">
                {t("screen.swap.again")}
              </Button>
            </>
          }
        />
      </Page>
    );
  }
  const paused = stored?.paused;
  if (paused?.code === "minimum_moved" && paused.minOut && paused.approved) {
    // as the Review said them: net of a protected delivery's shield tip (audit round 2, r39)
    const tip = stored?.shield ? BigInt(stored.shield.params.shieldTip) : 0n;
    return (
      <Page title={t("screen.swap.title")} back={p.onNew} testId="swap-view">
        <Card padding="md" testId="swap-minimum-moved">
          <h2 className="ds-card-title">{t("op.error.minimum_moved.title")}</h2>
          <p className="ds-note">
            {t("screen.swap.minimumMoved", {
              now: displayAmount(amountFrom(netOfShield(paused.minOut, tip).toString(), sym, outDecimals), "down"),
              approved: displayAmount(amountFrom(netOfShield(paused.approved, tip).toString(), sym, outDecimals), "down"),
              symbol: sym,
            })}
          </p>
          <p className="ds-note">{t("screen.swap.minimumMovedSafe")}</p>
          <div className="ds-actions">
            <Button onClick={() => acceptNewMinimum(orderId!)} disabled={busy} data-testid="swap-accept-minimum">
              {t("screen.swap.acceptMinimum")}
            </Button>
            <Button variant="secondary" onClick={() => void giveBack()} disabled={busy} data-testid="swap-return-funds">
              {t("screen.swap.returnFunds")}
            </Button>
          </div>
          {error ? <p className="ds-note-warn">{error}</p> : null}
        </Card>
      </Page>
    );
  }
  if (record.state === "RECOVERY_REQUIRED" || record.reason) {
    // Return funds wherever the escrow may hold them (the ninth review round, 2026-11-04, C-05): a handed-over order has no pause, and a
    // late refund ("they wait in your one-time escrow"), a failed refund or an order needing attention had offered nothing here
    const handedOverReturn = !paused && !!stored && fundedOf(stored) && actionsFor(record).includes("start-refund");
    return (
      <Page title={t("screen.swap.title")} back={p.onNew} testId="swap-view">
        <OperationProgress
          record={record}
          actions={
            paused && paused.code !== "reconcile" ? (
              <>
                {paused.code === "execution_unavailable" ? (
                  <Button onClick={() => retryOrder(orderId!)} disabled={busy} data-testid="swap-try-again">
                    {t("screen.swap.tryAgain")}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => void giveBack()} disabled={busy} data-testid="swap-return-funds">
                  {t("screen.swap.returnFunds")}
                </Button>
              </>
            ) : handedOverReturn ? (
              <Button variant="secondary" onClick={() => void giveBack()} disabled={busy} data-testid="swap-return-funds">
                {t("screen.swap.returnFunds")}
              </Button>
            ) : undefined
          }
        />
        {error ? <p className="ds-note-warn">{error}</p> : null}
      </Page>
    );
  }
  const waiting = stored?.runner?.delayUntil && !fundedOf(stored) && stored.runner.delayUntil > Date.now();
  const shielding =
    intoProtected && !stored?.shield?.leaves?.length && (stored?.shield?.job?.state === "shielding" || stored?.shield?.job?.state === "shielded");
  return (
    <div data-state={record.state} data-testid="swap-progress">
      <ProgressView model={progressModelOf(record, furthest)} />
      <AttemptLine orderId={attemptIdOf(record)} testId="swap-attempt" />
      {intoProtected ? (
        <p className="ds-note" data-testid={shielding ? "swap-adding-to-protected" : "swap-into-protected"}>
          {t(shielding ? "screen.swap.addingToProtected" : "screen.swap.intoProtected")}
        </p>
      ) : null}
      {waiting ? (
        <p className="ds-note" data-testid="swap-funding-at">
          {t("screen.swap.fundingAt", { time: formatDateTime(stored!.runner!.delayUntil!) })}
        </p>
      ) : null}
      {stored?.track?.label ? (
        <p className="ds-note" data-testid="swap-settlement">
          {((words) => (words ? t(words) : stored.track!.label))(SETTLEMENT_WORDS[stored.track.label])}
        </p>
      ) : null}
      {waiting ? (
        <TextButton onClick={() => void giveBack()} data-testid="swap-cancel">
          {t("screen.swap.cancelBeforeFunding")}
        </TextButton>
      ) : null}
    </div>
  );
}
