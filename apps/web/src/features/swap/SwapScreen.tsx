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
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { availablePrice, atLeast, formatUsd, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { parseDestination, looksLikeChain } from "@privacy-wallet/protocol/wallet/destinations";
import { assessSwapPrivacy } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { unacknowledgedBlocks, type LintId } from "@privacy-wallet/protocol/wallet/privacyLint";
import { swapFunding, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import type { BlockerCode } from "@privacy-wallet/protocol-types";
import { AssetSelector, Button, Card, ListRow, Page, SuccessCard, TextButton, type AssetOption } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { assetsOf, formatAmount, isBucketFor, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { swapService, type QuoteSet } from "@privacy-wallet/sdk/swapService";
import { feeTerms } from "@privacy-wallet/sdk/privateTx";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { controlsFor, holdMs, issuerLine, routeKind } from "@privacy-wallet/sdk/tiers";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { destinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import { walletLint, topBucket } from "@privacy-wallet/sdk/wallet/lintFacts";
import { holdersAbove } from "@privacy-wallet/sdk/poolDeposits";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { fundingTiming } from "@privacy-wallet/sdk/wallet/privacyTiming";
import { acceptNewMinimum, confirmOrder, retryOrder, returnFunds } from "@privacy-wallet/sdk/wallet/orderRunner";
import { progressLine, TERMINAL_STATES } from "@privacy-wallet/sdk/wallet/campaigns";
import { swapRecordId } from "@privacy-wallet/sdk/operations/swapRecords";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { DELAY_WINDOW, policyFromPreference } from "@privacy-wallet/sdk/policy";
import { PrivacyLint } from "../../components/PrivacyLint";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { Review } from "../review/ReviewScreen";
import { BLOCKER_WORDS, ReviewView, type ReviewModel } from "../review/View";
import { OperationProgress } from "../operations/OperationProgress";
import { ProgressView } from "../progress/View";
import { furthestLine, progressModelOf } from "../progress/model";
import { amountFrom, amountOf, centsOf, displayAmount } from "../amounts";
import { CompareRoutes } from "./CompareRoutes";
import { Swap, type SwapPrefill } from "./Swap";
import { SwapView } from "./View";
import { chosenQuoteOf, confirmBlockers, destinationChecks, expiresInOf, quoteLines, routeDetails, shieldTipOf } from "./model";
import { commitDetails, commitExecution, commitLines, type SwapContext } from "./facts";
import { cappedSlippageBps, providerHealthy } from "./protectedChecks";
import { TARGETS, refOf, riskWord, sameChainTargets } from "./targets";
import { useCampaigns, useOperation, usePoolStats, usePrices, useSession, useSettings, useNotes } from "../../hooks";

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
  useSession();
  useNotes();
  usePoolStats();
  const prices = usePrices();
  const running = useCampaigns().filter((c) => !TERMINAL_STATES.includes(c.state));
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

  const to = targets[target] ?? TARGETS.BTC;
  const intoProtected = !!to.protected; // a same-chain swap: the destination is the protected balance (spec v2.0 §11.2)
  const chain = chainKindOf(to.ref.chain);
  const units = fromAsset ? parseAmount(fromAsset, amount) : 0n;
  const fresh = peekFreshAddress(p.masterSeed, chain).address;
  const edited = typed.trim() !== "";
  const destination = edited ? typed.trim() : fresh;
  const parsed = edited ? parseDestination(chain, typed) : null;
  const destinationOk = !edited || parsed?.ok === true;
  const otherChain = edited ? looksLikeChain(typed.trim()) : null;
  const priced = feedsConfigured(p.deployment);
  const assessment = fromAsset && units > 0n && priced ? priceStore.assess(units, fromAsset) : null;
  const usd = assessment && "usd" in assessment.value ? assessment.value.usd : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  const destCheck = edited && parsed?.ok ? destinationCheck(chain, destination, { tier }) : null;
  const destinationLocked = controls.destinationLock && !!destCheck && !destCheck.ok;
  const balance = fromAsset ? noteStore.balance(BigInt(fromAsset.vault)) : 0n;
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

  // the quote, fetched as the user types (debounced); a newer request makes an older answer stale
  const seq = useRef(0);
  const quotable = !!p.deployment && !!fromAsset && units > 0n && units <= balance && destinationOk;
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
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const read = submission.kind === "relayer" ? await feeTerms(deployment, submission, fromAsset.vault) : null;
          const tm: FeeTerms | null = read ? { minimum: read.fee.amount, feePercentBps: read.info.feePercentBps ?? 0 } : null;
          const split = tm ? swapFunding(units, tm) : null;
          if (split?.tooSmall) throw new Error(t("swap.tooSmallForFees"));
          const set = await swapService.quote({
            from: refOf(fromAsset),
            to: to.ref,
            amount: (split ? split.delivered : units).toString(),
            destination: "", // the engine quotes a placeholder: the destination is sent at the confirmation (spec v2.0 §13.2)
            slippageBps: controls.strictQuote ? cappedSlippageBps(50) : 50,
            preference,
            ...(assessment ? { tier: assessment.tier } : {}),
            destinationKind: edited ? "entered" : "fresh",
            preferNative: preference === "native",
            mode: protection.mode,
            ...(intoProtected ? { destinationType: "protected" as const } : {}),
          });
          if (seq.current !== mine) return;
          setTerms(tm);
          setQuotes(set);
          setQuotedAt(Date.now());
          setNow(Date.now());
          setQuoteError(set.chosen ? null : t("swap.noRoute"));
        } catch (e) {
          if (seq.current === mine) setQuoteError(classify(e).detail || String(e));
        } finally {
          if (seq.current === mine) setQuoting(false);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the quote follows what the user chose, not the price store's ticks
  }, [quotable, units, fromAsset, target, edited, preference, protection.mode, submission, p.deployment, refresh]);
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
  const privacy =
    fromAsset && units > 0n
      ? assessSwapPrivacy({
          sourceIsPool: true,
          amount: { kind: isBucketFor(fromAsset, units) ? "bucket" : "exact" },
          timing,
          ...(delay ? { delaySeconds: DELAY_WINDOW.balanced[0] } : {}),
          destination: edited ? "entered" : "fresh",
          provider: { linkPublic: quotes && chosen ? (quotes.links?.[chosen.provider]?.public ?? true) : null },
          crossChain: to.ref.chain !== "ethereum",
        })
      : null;
  const priceFrom = fromAsset ? availablePrice(prices.prices, fromAsset.symbol) : null;
  const priceTo = availablePrice(prices.prices, to.ref.symbol);
  const protectionPlan = quotes?.protection ?? null;
  // the protected screen (V5's, until Stage 13) knows only cross-chain targets: a swap into the protected balance stays
  // one order here, with the hold from $50K
  const campaignMode =
    !intoProtected &&
    !!protectionPlan &&
    protection.enabled &&
    (controls.campaign ||
      (tier === "enhanced" && (protectionPlan.staged || protection.protectFromEnhanced)) ||
      (tier === "large-protected" && protectionPlan.staged));
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
          amountIsBucket: isBucketFor(fromAsset, units),
          holders,
          acknowledged,
          destination,
          destinationKind: edited ? "entered" : "fresh",
          delaySeconds: delay ? DELAY_WINDOW.balanced[0] : 0,
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
                error: parsed && !parsed.ok ? t("swap.destinationError", { reason: parsed.reason }) : null,
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
              })
            : null,
        expiresIn,
        expired,
        quoting,
        noRoute: !quoting ? (units > balance && units > 0n ? t("send.notEnough", { symbol: fromAsset.symbol }) : quoteError) : null,
        privacy: privacy?.recent ? { recent: true, delay } : null,
        notice: assessment && tier !== "standard" ? (assessment.failSafe ? t("swap.largeFailSafe") + t("swap.largeNotice") : t("swap.largeNotice")) : null,
        details: advanced && routeQuotes ? routeDetails(routeQuotes, to, privacy, chosen ? riskWord(chosen.components.security) : "—") : null,
        canReview: !!quote && !expired && destinationOk && !destinationLocked && !busy,
      }
    : null;

  const addressStatus =
    controls.destinationLock && edited && parsed?.ok ? (
      <DestinationStatus chain={chain} address={destination} tier={tier} masterSeed={p.masterSeed} deployment={p.deployment} asset={to.ref.symbol} />
    ) : null;

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
      const r = await confirmOrder({
        masterSeed: p.masterSeed,
        deployment: p.deployment,
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
        ...(shield ? { shield } : {}),
        policy,
        provider: chosen.provider,
        fromAsset,
        shown: quote,
        competition: quotes.competition ?? null,
        lint: lintItems,
        preference,
        walletTier: assessment ? tier : null,
        delay,
      });
      navigate(`/swap/progress/${swapRecordId(r.stored.orderId)}`);
    } catch (e) {
      setStatus(classify(e).detail || String(e));
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
                    subtitle={progressLine(c, advanced)}
                    trailing={
                      <Button variant="secondary" onClick={() => navigate("/swap/protected", { state: { campaignId: c.id } })}>
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
            onDelay: setDelay,
            ...(balance > 0n ? { onMax: () => setAmount(formatAmount(fromAsset, balance)) } : {}),
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
    if (atLeast(tier, "enhanced")) {
      // from $100K the V2–V4 Review stays as it was (spec v2.0 §2), with one confirmation after it
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
            usd={usd !== null ? formatUsd(usd) : null}
            amount={`${formatAmount(fromAsset, units)} ${fromAsset.symbol}`}
            from={t("swap.fromProtected", { symbol: fromAsset.symbol })}
            to={{
              network: to.network,
              asset: to.ref.symbol,
              address: intoProtected ? "" : destination,
              kind: intoProtected ? "privacy-address" : edited ? "entered" : "fresh",
              ...(intoProtected ? { label: t("screen.swap.protectedBalance") } : {}),
            }}
            receiveMin={`${displayAmount(amountOf(BigInt(quote.toAmountMin) - (intoProtected ? shieldTipOf(quotes) : 0n), to.ref.symbol, to.ref.decimals, to.ref.chain))} ${to.ref.symbol}`}
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
            issuer={issuerLine(fromAsset.symbol) ?? issuerLine(to.ref.symbol)}
            routeKind={routeKind(refOf(fromAsset), to.ref, quote.nativeAssets)}
            crossChain={crossChain}
            details={commitDetails(ctx, chosen.provider, quote, score)}
            advanced={advanced}
            secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null}
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
    const price = priceFrom;
    const cents = (u: bigint) => (price ? centsOf(u, fromAsset.decimals, price.usd1e8) : null);
    const split = terms ? swapFunding(units, terms) : { privacy: 0n, network: 0n, delivered: units };
    const tip = BigInt(quotes.executorTip ?? "0");
    const providerCents = BigInt(Math.round((quote.fees ?? []).reduce((s, x) => s + (typeof x.usd === "number" ? x.usd : 0), 0) * 100));
    const privacyCents = cents(split.privacy);
    // into the protected balance the relayer also gets the shield tip, in the output asset: what arrives is the delivery less it
    const shieldTip = intoProtected ? shieldTipOf(quotes) : 0n;
    const shieldCents = shieldTip > 0n ? (priceTo ? centsOf(shieldTip, to.ref.decimals, priceTo.usd1e8) : null) : 0n;
    const sourceRelayerCents = cents(split.network + tip);
    const relayerCents = sourceRelayerCents !== null && shieldCents !== null ? sourceRelayerCents + shieldCents : null;
    const large = atLeast(tier, "large-protected");
    const review: ReviewModel = {
      kind: crossChain ? "cross-chain" : "swap",
      pay: { usdCents: cents(units), amount: amountOf(units, fromAsset.symbol, fromAsset.decimals) },
      receive: { amount: amountOf(BigInt(quote.toAmount) - shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain), approx: true },
      minimum: amountOf(BigInt(quote.toAmountMin) - shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain),
      fees: [
        ...(split.privacy > 0n
          ? [{ kind: "privacy" as const, usdCents: privacyCents, amount: amountOf(split.privacy, fromAsset.symbol, fromAsset.decimals) }]
          : []),
        {
          kind: "relayer" as const,
          usdCents: relayerCents,
          amount: amountOf(split.network + tip, fromAsset.symbol, fromAsset.decimals),
          ...(shieldTip > 0n ? { also: amountOf(shieldTip, to.ref.symbol, to.ref.decimals, to.ref.chain) } : {}),
        },
        { kind: "provider" as const, usdCents: providerCents },
      ],
      totalFeesUsdCents: privacyCents !== null && relayerCents !== null ? privacyCents + relayerCents + providerCents : null,
      destination: {
        label: crossChain ? (edited ? `${destination.slice(0, 6)}…${destination.slice(-4)}` : t("send.freshEntry")) : t("screen.swap.protectedBalance"),
        verified: !edited || destAck,
      },
      protection: privacy?.level ?? "medium",
      large,
      hold: controls.hold,
      confirmDisabled: busy || lintBlocked || destinationLocked || (needsDestAck && !destAck) || !health.ok,
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
        {delay ? (
          <p className="ds-note" data-testid="swap-review-delay">
            {t("screen.swap.delayNote")}
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
          onConfirm: () => void confirm(),
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
      <Route
        path="protected"
        element={
          <Swap
            masterSeed={p.masterSeed}
            deployment={p.deployment}
            account={p.account}
            onBack={() => navigate("/swap")}
            prefill={(location.state as { prefill?: SwapPrefill } | null)?.prefill ?? null}
            campaignId={(location.state as { campaignId?: string } | null)?.campaignId ?? null}
          />
        }
      />
      <Route path="*" element={<Navigate to="/swap" replace />} />
    </Routes>
  );
}

/** /swap/progress/:opId — the operation's lines while it runs, the paused order's choice, the result. */
function SwapProgress(p: { masterSeed: Uint8Array; deployment: Deployment | null; onDone: () => void; onNew: () => void }) {
  const t = useT();
  const { opId } = useParams();
  const record = useOperation(opId ?? null);
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
  if (record.state === "COMPLETED" || record.state === "REFUNDED" || record.state === "CANCELLED") {
    const delivered = record.amounts.delivered ?? record.amounts.minimumOutput;
    const title =
      record.state === "COMPLETED"
        ? delivered
          ? t(intoProtected ? "screen.swap.doneProtected" : "screen.swap.done", { amount: displayAmount(amountFrom(delivered, sym, outDecimals)), symbol: sym })
          : t("screen.swap.doneNoAmount")
        : record.state === "REFUNDED"
          ? t("screen.swap.returned")
          : t("screen.swap.cancelled");
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
    return (
      <Page title={t("screen.swap.title")} back={p.onNew} testId="swap-view">
        <Card padding="md" testId="swap-minimum-moved">
          <h2 className="ds-card-title">{t("op.error.minimum_moved.title")}</h2>
          <p className="ds-note">
            {t("screen.swap.minimumMoved", {
              now: displayAmount(amountFrom(paused.minOut, sym, outDecimals)),
              approved: displayAmount(amountFrom(paused.approved, sym, outDecimals)),
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
            ) : undefined
          }
        />
        {error ? <p className="ds-note-warn">{error}</p> : null}
      </Page>
    );
  }
  const waiting = stored?.runner?.delayUntil && !stored.fundedTx && stored.runner.delayUntil > Date.now();
  const shielding =
    intoProtected && !stored?.shield?.leaves?.length && (stored?.shield?.job?.state === "shielding" || stored?.shield?.job?.state === "shielded");
  return (
    <div data-state={record.state} data-testid="swap-progress">
      <ProgressView model={progressModelOf(record, furthest)} />
      {intoProtected ? (
        <p className="ds-note" data-testid={shielding ? "swap-adding-to-protected" : "swap-into-protected"}>
          {t(shielding ? "screen.swap.addingToProtected" : "screen.swap.intoProtected")}
        </p>
      ) : null}
      {waiting ? (
        <p className="ds-note" data-testid="swap-funding-at">
          {t("screen.swap.fundingAt", { time: new Date(stored!.runner!.delayUntil!).toLocaleString() })}
        </p>
      ) : null}
      {stored?.track?.label ? (
        <p className="ds-note" data-testid="swap-settlement">
          {stored.track.label}
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
