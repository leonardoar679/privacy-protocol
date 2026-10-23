// The facts of a swap's Reviews (whale spec §24; V3 §15, §43; V4 §55, §69): the lines of plan §4 at the commit
// moment, the execute moment, the protected execution and its reroute, the campaign facts (the draft plan, the
// maximum-loss model, the combined verdict, the protection details) and the quote's view. Pure builders over the
// quote set, the service's recommendation and the wallet's own bounds; every sentence comes from the message
// catalog through `t`.
import { assessPrivacy } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { maximumLossModel, type Campaign, type DestinationPolicy } from "@privacy-wallet/protocol/wallet/campaign";
import { unacknowledgedBlocks, type LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import { formatUsd, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { formatCount, formatUsdCompact } from "../../app/i18n/intl";
import { formatAmount, isBucketFor, type Asset } from "@privacy-wallet/sdk/assets";
import { fmtUnits } from "@privacy-wallet/sdk/format";
import type { Policy, Preference, Protection, ProviderRiskView, QuoteSet, RouteScore, ServiceQuote, ServiceOrder, AssetRef } from "@privacy-wallet/sdk/swapService";
import type { Signed } from "@privacy-wallet/sdk/swapExecute";
import { IMPACT_CAP_BPS } from "@privacy-wallet/sdk/tiers";
import { feeSummary } from "@privacy-wallet/sdk/swapService";
import { buildCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import type { DestinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { MaximumLoss, ProtectionDetails, ReviewLine, Verdict, RouteDetails } from "../review/ReviewScreen";
import { CUSTODY_WORDS, GATE_WORDS, durationWords, providerKind, refOf, settlementWords, type Target } from "./targets";
import { netOfShield } from "./model";
import { destinationStatusWords } from "../destinationWords";
import { planDetail, planText } from "../review/words";
import { hoursText } from "../../app/i18n/duration";

export type T = (key: MessageKey, vars?: Vars) => string;
const fmt = (units: string | bigint, decimals: number) => fmtUnits(units, decimals);
/**
 * A protected execution's per-step price bound in whole units of the output per whole unit of the input (audit round 2, r37):
 * the bound is a 1e18 rate of output base units per input base unit, and formatted as 18 decimals it read "0.000000 BTC per
 * ETH" — 10^10 too small — and a hundred times too much BTC per USDC.
 */
export const boundPerUnit = (rateE18: string | bigint, fromDecimals: number, toDecimals: number): string =>
  fmtUnits((BigInt(rateE18) * 10n ** BigInt(fromDecimals)) / 10n ** 18n, toDecimals, toDecimals);

export interface SwapContext {
  t: T;
  quotes: QuoteSet;
  fromAsset: Asset;
  to: Target;
  units: bigint;
  usd: number | null;
  tier: Tier;
  controls: { twoQuotes: boolean; destinationLock: boolean; export: boolean; reviewHold: boolean; secondFactor: boolean; secondDevice: boolean };
  policy: Policy;
  preference: Preference;
  destination: string;
  destinationEdited: boolean;
  parsedOk: boolean;
  destAck: boolean;
  routeAck: boolean;
  destCheck: DestinationCheck | null;
  destinationLocked: boolean;
  lintItems: LintItem[] | null;
  protection: { mode: Campaign["mode"]; capBps?: number };
  relayerFee: bigint | null;
}

export const usdOfUnits = (c: Pick<SwapContext, "usd" | "units" | "fromAsset">, x: bigint): string | null => {
  if (c.usd === null || c.units <= 0n) return null;
  const usdPer = c.usd / (Number(c.units) / 10 ** c.fromAsset.decimals);
  return formatUsdCompact(usdPer * (Number(x) / 10 ** c.fromAsset.decimals));
};
export const amountWords = (c: Pick<SwapContext, "usd" | "units" | "fromAsset">, x: bigint): string => `${formatAmount(c.fromAsset, x)} ${c.fromAsset.symbol}${usdOfUnits(c, x) ? ` (≈ ${usdOfUnits(c, x)})` : ""}`;
export const liveQuotesOf = (q: QuoteSet): number => (q.competition ? q.competition.filter((x) => x.outcome === "quoted").length : q.quotes.length);
export const alternativesOf = (q: QuoteSet, prov: string): RouteDetails["alternatives"] => (q.competition ?? []).filter((x) => x.provider !== prov).map((x) => ({ provider: x.provider, outcome: x.outcome, reason: x.reason }));

/** The privacy line of the lines (plan §4): every privacy check is ok, a warning, or acknowledged. */
const privacyLine = (t: T, lint: LintItem[] | null): ReviewLine => ({ id: "privacy", label: t("swap.lines.privacy"), ok: !lint || unacknowledgedBlocks(lint).length === 0, meaning: t("swap.lines.privacyMeaning") });
const routeLine = (c: SwapContext, live: number, onRouteAck: () => void): ReviewLine => ({
  id: "route", label: t0(c, "swap.lines.route"), ok: !c.controls.twoQuotes || live >= 2 || c.routeAck,
  meaning: live >= 2 ? c.t("swap.lines.routeTwo", { n: live }) : c.t("swap.lines.routeOne"),
  ...(c.controls.twoQuotes && live < 2 ? { ack: { text: c.t("swap.lines.acceptSingle"), done: c.routeAck, onAck: onRouteAck } } : {}),
});
const t0 = (c: SwapContext, k: MessageKey) => c.t(k);
const destinationLine = (c: SwapContext, onDestAck: () => void, every: boolean): ReviewLine => ({
  id: "destination", label: c.t("swap.lines.destination"), ok: !c.destinationEdited || (c.parsedOk && c.destAck && (every ? (c.destCheck?.verified ?? false) : !c.destinationLocked)),
  meaning: c.destinationEdited
    ? `${every ? c.t("swap.lines.destinationEveryStep") : c.t("swap.lines.destinationEntered")}${c.destCheck ? `; ${destinationStatusWords(c.t, c.destCheck)}` : ""}`
    : every ? c.t("swap.lines.destinationFreshPerStep") : c.t("swap.lines.destinationFresh"),
  ...(c.destinationEdited && !c.destAck ? { ack: { text: c.t("swap.lines.checkedGroups"), done: c.destAck, onAck: onDestAck } } : {}),
});

/** The commit moment (spec §24): the five lines from the quote set and the lint. */
export function commitLines(c: SwapContext, prov: string, quote: ServiceQuote, onRouteAck: () => void, onDestAck: () => void): ReviewLine[] {
  const dec = c.to.ref.decimals, sym = c.to.ref.symbol;
  return [
    { id: "price", label: c.t("swap.lines.price"), ok: BigInt(quote.toAmountMin) > 0n, meaning: c.t("swap.lines.priceCommit", { amount: `${fmt(netOfShield(quote.toAmountMin, c.to.protected ? BigInt(c.quotes.shieldTip ?? "0") : 0n), dec)} ${sym}` }) },
    routeLine(c, liveQuotesOf(c.quotes), onRouteAck),
    destinationLine(c, onDestAck, false),
    { id: "slippage", label: c.t("swap.lines.slippage"), ok: quote.impactBps === undefined || quote.impactBps <= IMPACT_CAP_BPS, meaning: quote.impactBps === undefined ? c.t("swap.lines.slippageNoFigure") : c.t("swap.lines.slippageImpact", { bps: quote.impactBps, cap: IMPACT_CAP_BPS }) },
    privacyLine(c.t, c.lintItems),
  ];
}

export function commitDetails(c: SwapContext, prov: string, quote: ServiceQuote, score: RouteScore): RouteDetails {
  const dec = c.to.ref.decimals, sym = c.to.ref.symbol;
  return { provider: prov, mode: quote.plan?.mode ?? "single", parts: quote.plan?.parts, fees: feeSummary(quote), expectedOutput: `${fmt(quote.toAmount, dec)} ${sym}`, settlement: settlementWords(prov), alternatives: alternativesOf(c.quotes, prov), score: `${score.total}`, linkEvidence: c.quotes.links?.[prov]?.evidence };
}

export const commitExecution = (c: SwapContext, quote: ServiceQuote) => ({ words: planText(c.t, quote.plan), detail: quote.plan && quote.plan.mode !== "single" ? planDetail(c.t, quote.plan) : undefined, eta: `~${hoursText(c.t, quote.etaSeconds)}${c.policy !== "fastest" ? c.t("swap.afterFunding") : ""}` });

/** The execute moment (spec §24): the checked call, the simulation, the lint read against the call. */
export function executeLines(t: T, s: Signed, stored: StoredSwap | null, to: AssetRef, dest: string, signLint: LintItem[] | null): ReviewLine[] {
  const dec = to.decimals, sym = to.symbol;
  const approved = stored?.approvedMin ? BigInt(stored.approvedMin) : 0n;
  const quote = (stored?.quote ?? {}) as { impactBps?: number };
  return [
    { id: "price", label: t("swap.lines.price"), ok: s.call.minOut !== null && s.call.minOut >= approved, meaning: s.call.minOut !== null ? t("swap.lines.priceExecute", { amount: `${fmt(s.call.minOut.toString(), dec)} ${sym}` }) : t("swap.lines.priceUnreadable") },
    { id: "route", label: t("swap.lines.route"), ok: s.sim.ok, meaning: s.sim.ok ? t("swap.lines.routeSimulated", { n: s.sim.endpoints, plural: s.sim.endpoints === 1 ? "" : "s", gas: formatCount(Number(s.sim.gas)) }) : s.sim.reason },
    { id: "destination", label: t("swap.lines.destination"), ok: true, meaning: t("swap.lines.destinationFromCalldata", { address: `${dest.slice(0, 10)}…` }) },
    { id: "slippage", label: t("swap.lines.slippage"), ok: quote.impactBps === undefined || quote.impactBps <= IMPACT_CAP_BPS, meaning: quote.impactBps === undefined ? t("swap.lines.slippageMinimumBounds") : t("swap.lines.slippageImpact", { bps: quote.impactBps, cap: IMPACT_CAP_BPS }) },
    privacyLine(t, signLint),
  ];
}

export interface CampaignFacts {
  quote: ServiceQuote; score: RouteScore; risk: ProviderRiskView | undefined; p: Protection; draft: Campaign; steps: number; verdict: Verdict; details: ProtectionDetails; maximumLoss: MaximumLoss; destinationPolicy: DestinationPolicy; privacyView: ReturnType<typeof assessPrivacy>; cadence: string;
}

/** The facts of the chosen route for the wizard and the Review (the service's risk view is advice; the wallet's own bounds come from buildCampaign). */
export function campaignFacts(c: SwapContext, provider: string, now = Date.now()): CampaignFacts {
  const q = c.quotes, p = q.protection!;
  const quote = q.quotes.find((x) => x.provider === provider)!;
  const score = q.scores.find((x) => x.provider === provider) ?? q.chosen!;
  const risk: ProviderRiskView | undefined = q.risk?.[provider];
  const destinationPolicy: DestinationPolicy = c.destinationEdited ? { kind: "entered", address: c.destination } : { kind: "fresh-per-tranche" };
  const draft = buildCampaign({ quotes: q, provider, from: refOf(c.fromAsset), fromAsset: c.fromAsset, to: c.to.ref, amount: c.units, tier: c.tier, mode: c.protection.mode, preference: c.preference, policy: c.policy, destination: destinationPolicy, usd: c.usd, capBps: c.protection.capBps, now, rng: () => 0.5 });
  const loss = maximumLossModel(draft);
  const steps = draft.tranches.length;
  const incidentDays = risk?.security.incidentList.map((i) => (now - Date.parse(i.date)) / 86_400_000).filter((d) => d >= 0) ?? [];
  const recent = incidentDays.some((d) => d <= 30), within90 = incidentDays.some((d) => d <= 90);
  const security = risk?.security.total ?? score.components.security;
  const reliability = risk?.reliability ?? score.components.reliability;
  const verdictSecurity: Verdict["security"] = security < 60 || reliability < 40 ? "Do not execute" : security < 70 || recent || reliability < 60 || p.thinMarket ? "Review" : "Safe to execute";
  const why = [
    c.t("swap.facts.security", { security, basis: risk ? c.t("swap.facts.securityBasis", { baseline: risk.security.baseline, incidents: risk.security.incidents }) : c.t("swap.facts.securityFromScore") }),
    c.t("swap.facts.reliability", { reliability }),
    incidentDays.length ? c.t("swap.facts.incidents", { n: incidentDays.length, plural: incidentDays.length === 1 ? "" : "s", when: recent ? c.t("swap.facts.within30") : within90 ? c.t("swap.facts.within90") : c.t("swap.facts.older") }) : c.t("swap.facts.noIncident"),
    ...(p.thinMarket ? [c.t("swap.facts.thinMarket")] : []),
  ].join(" · ");
  const pieces = draft.tranches.map((x) => BigInt(x.amount));
  const privacyView = assessPrivacy({ sourceIsPool: true, amount: { kind: pieces.every((x) => isBucketFor(c.fromAsset, x)) ? "bucket" : "pair" }, delaySeconds: p.cadenceSeconds[0], destination: c.destinationEdited ? "entered" : "fresh-per-tranche", steps, provider: { linkPublic: q.links?.[provider]?.public ?? null, kind: providerKind(provider), etaSeconds: quote.etaSeconds }, crossChain: c.to.ref.chain !== refOf(c.fromAsset).chain, sameSizeConsecutive: p.sizing === "varied" && pieces.some((x, i) => i > 0 && x === pieces[i - 1]), cadenceFixed: false });
  const liveQuotes = liveQuotesOf(q) || q.quotes.length;
  const execution: NonNullable<Verdict["execution"]> = liveQuotes >= 2 ? (q.chosen?.provider === provider ? "Best available" : "Review") : "Only route";
  const executionWhy = liveQuotes >= 2 ? (execution === "Best available" ? c.t("swap.facts.wonOnWeights", { n: liveQuotes, provider }) : c.t("swap.facts.chosenOverWinner", { n: liveQuotes, provider, winner: q.chosen?.provider ?? "" })) : c.t("swap.facts.onlyRoute");
  const verdict: Verdict = { security: verdictSecurity, privacy: privacyView.level, why, execution, executionWhy };
  const cadence = c.t("swap.facts.cadence", { lo: durationWords(p.cadenceSeconds[0]), hi: durationWords(p.cadenceSeconds[1]) });
  const details: ProtectionDetails = {
    riskClass: p.riskClass + (p.flags.length ? ` + ${p.flags.join(", ")}` : ""), custody: CUSTODY_WORDS[p.custody] ?? p.custody, band: `${p.bandBps[0] / 100}–${p.bandBps[1] / 100} %`, cap: `${draft.plan.capBps / 100} %`,
    gate: GATE_WORDS[p.gate] ?? p.gate, steps: `${steps} (${p.concurrency === "sequential" ? c.t("swap.oneAtATime") : c.t("swap.upToAtATime", { n: p.maxParallel })})`, duration: c.t("swap.facts.about", { duration: durationWords(p.estimatedSeconds) }), cadence,
    elpf: p.elpf.perCampaignUsd !== null ? c.t("swap.facts.elpf", { step: formatUsd(p.elpf.perTrancheUsd ?? 0), operation: formatUsd(p.elpf.perCampaignUsd), prior: (p.elpf.prior * 100).toFixed(1) }) : c.t("swap.facts.elpfPrior", { prior: (p.elpf.prior * 100).toFixed(1) }),
    concentration: p.concentration.singleVenue ? c.t("swap.facts.singleVenue") : c.t("swap.facts.venues", { n: p.concentration.providers.length, cap: p.concentration.capBps / 100 }),
    ...((q.competition ?? []).find((x) => x.provider !== provider && x.outcome === "quoted")?.provider ? { alternative: (q.competition ?? []).find((x) => x.provider !== provider && x.outcome === "quoted")!.provider } : {}),
  };
  const prep = c.relayerFee !== null ? c.t("swap.facts.prepValued", { n: steps, eth: fmt((c.relayerFee * BigInt(steps)).toString(), 18) }) : c.t("swap.facts.prepLive", { n: steps });
  const maximumLoss: MaximumLoss = { order: amountWords(c, loss.order), cap: amountWords(c, loss.cap), maxExposure: amountWords(c, loss.maxExposure), protected: amountWords(c, loss.protected), preparation: prep };
  return { quote, score, risk, p, draft, steps, verdict, details, maximumLoss, destinationPolicy, privacyView, cadence };
}

/** The Review before a protected execution (spec §15): the five lines plus Exposure and Security. */
export function campaignLines(c: SwapContext, f: CampaignFacts, onRouteAck: () => void, onDestAck: () => void): ReviewLine[] {
  const dec = c.to.ref.decimals, sym = c.to.ref.symbol;
  const live = liveQuotesOf(c.quotes);
  return [
    { id: "price", label: c.t("swap.lines.priceProtected"), ok: BigInt(f.quote.toAmountMin) > 0n, meaning: `${c.t("swap.lines.priceCampaign", { minimum: `${boundPerUnit(f.draft.bounds.minimumOutput, c.fromAsset.decimals, dec)} ${sym}`, from: c.fromAsset.symbol })}; ${c.t("swap.lines.priceGuardAgain")}` },
    routeLine(c, live, onRouteAck),
    destinationLine(c, onDestAck, true),
    { id: "slippage", label: c.t("swap.lines.slippage"), ok: f.quote.impactBps === undefined || (f.p.trancheImpactBps ?? 0) <= IMPACT_CAP_BPS, meaning: f.p.trancheImpactBps !== null && f.p.trancheImpactBps !== undefined ? c.t("swap.lines.slippagePerStep", { bps: f.p.trancheImpactBps, cap: IMPACT_CAP_BPS }) : c.t("swap.lines.slippageNoFigure") },
    { id: "exposure", label: c.t("swap.lines.exposure"), ok: f.draft.plan.capBps <= 5000, meaning: c.t("swap.lines.exposureMeaning", { cap: amountWords(c, maximumLossModel(f.draft).cap), percent: f.draft.plan.capBps / 100, concurrency: f.p.concurrency === "sequential" ? c.t("swap.oneStepAtATime") : c.t("swap.upToAtATime", { n: f.p.maxParallel }) }) },
    { id: "security", label: c.t("swap.lines.security"), ok: f.verdict.security !== "Do not execute", meaning: f.verdict.why },
    privacyLine(c.t, c.lintItems),
  ];
  void dec;
}

/** The reroute Review (spec §8): a route change on a large operation is confirmed, never adopted quietly. */
export function rerouteLines(t: T, c: Campaign, np: Protection | null, provider: string, fmtFrom: (u: string) => string): ReviewLine[] {
  return [
    { id: "route", label: t("swap.lines.route"), ok: true, meaning: t("swap.lines.rerouteRoute", { provider, before: c.provider ?? "—" }) },
    { id: "exposure", label: t("swap.lines.exposure"), ok: true, meaning: t("swap.lines.rerouteExposure", { cap: fmtFrom(c.bounds.maxExternalExposure) }) },
    { id: "security", label: t("swap.lines.security"), ok: !np || np.riskClass !== "R6", meaning: np ? `${provider}: ${t("swap.lines.rerouteSecurity", { cls: np.riskClass, custody: CUSTODY_WORDS[np.custody] ?? np.custody, gate: GATE_WORDS[np.gate] ?? np.gate })}${np.reasons.length ? `; ${np.reasons.join("; ")}` : ""}` : t("swap.lines.rerouteNoView") },
    { id: "privacy", label: t("swap.lines.privacy"), ok: true, meaning: t("swap.lines.reroutePrivacy") },
  ];
}

/** The order's target from a journaled request. */
export const orderTarget = (stored: StoredSwap | null, fallback: Target, targets: Record<string, Target>): Target => {
  const to = (stored?.request as { to?: AssetRef } | undefined)?.to;
  if (!to) return fallback;
  return Object.values(targets).find((x) => x.ref.symbol === to.symbol && x.ref.chain === to.chain) ?? fallback;
};

export type { ServiceOrder };
