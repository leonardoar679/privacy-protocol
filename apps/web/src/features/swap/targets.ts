// The swap's destinations and words (spec §3.6–§3.7; private-swap spec; whale spec §23): the target assets the
// engine routes to, the asset reference of a vault asset, the provider's settlement words, the custody and gate words
// of the risk model, the duration words. Pure.
import { CHAINS, assetLabel, crossChainTargets } from "@privacy-wallet/config";
import type { AssetRef } from "@privacy-wallet/sdk/swapService";
import type { Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { protectable } from "@privacy-wallet/sdk/shieldReceiver";
import type { BasisWords, PrivacyAssessment } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";

type T = (key: MessageKey, vars?: Vars) => string;

/** `protected`: V6 Stage 12 (spec v2.0 §11.2) — a same-chain target, received into the protected balance through a shield receiver. */
export interface Target { id: string; ref: AssetRef; network: string; protected?: boolean }
/** The cross-chain destinations, from the asset registry (V6 Stage 3: no token named in a component). */
export const TARGETS: Record<string, Target> = Object.fromEntries(
  crossChainTargets().map((a) => {
    const id = assetLabel(a);
    return [id, { id, ref: { chain: a.chain as AssetRef["chain"], asset: a.address ?? "native", decimals: a.decimals, symbol: a.symbol }, network: CHAINS[a.chain].name }];
  }),
);
export const targetFor = (symbol: string, chain: string): Target => Object.values(TARGETS).find((x) => x.ref.symbol === symbol && x.ref.chain === chain) ?? TARGETS.BTC;

export const refOf = (a: Asset): AssetRef => ({ chain: "ethereum", asset: a.token ?? "native", decimals: a.decimals, symbol: a.symbol });

/** V6 Stage 12: the pool's assets this deployment can receive into the protected balance (a shield receiver factory and a canonical vault). */
export function sameChainTargets(assets: Asset[], deployment: Deployment | null): Record<string, Target> {
  if (!deployment?.shieldFactory) return {};
  return Object.fromEntries(
    assets.filter((a) => protectable(deployment, a.token ?? "native")).map((a) => [a.symbol, { id: a.symbol, ref: refOf(a), network: CHAINS.ethereum.name, protected: true }]),
  );
}
export const hours = (s: number): string => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
export const riskWord = (security: number): "Low" | "Medium" | "High" => (security >= 85 ? "Low" : security >= 70 ? "Medium" : "High");
export const settlementWords = (p: string): string => (p === "thorchain" || p === "chainflip" ? "native deposit address" : p === "near-intents" ? "solver network" : p === "mayan" ? "signed intent (drivers compete)" : "aggregator / bridge");
export const providerKind = (p: string): "deposit-address" | "signed-intent" | "aggregator-api" => (p === "thorchain" || p === "chainflip" || p === "near-intents" ? "deposit-address" : p === "mayan" ? "signed-intent" : "aggregator-api");
// the risk model's words in the reader's language (audit round 2, r55): a custody or a gate the catalog does not know keeps its code
const CUSTODY_WORDS: Record<string, MessageKey> = { "tss-vaults": "custody.tss-vaults", "mpc-vault": "custody.mpc-vault", "relayer-bridge": "custody.relayer-bridge", cctp: "custody.cctp", solver: "custody.solver", aggregator: "custody.aggregator", intent: "custody.intent", otc: "custody.otc" };
const GATE_WORDS: Record<string, MessageKey> = { source: "gate.source", "destination-submitted": "gate.destination-submitted", "destination-final": "gate.destination-final" };
export const custodyWords = (t: T, custody: string): string => (CUSTODY_WORDS[custody] ? t(CUSTODY_WORDS[custody]) : custody);
export const gateWords = (t: T, gate: string): string => (GATE_WORDS[gate] ? t(GATE_WORDS[gate]) : gate);
/** A provider's proper name (a name: never translated). */
const PROVIDER_NAMES: Record<string, string> = { thorchain: "THORChain", chainflip: "Chainflip", "near-intents": "NEAR Intents", mayan: "Mayan", lifi: "LI.FI", "uniswap-across": "Uniswap + Across" };
export const providerName = (id: string): string => PROVIDER_NAMES[id] ?? id;
/** The plan's reasons in the reader's words: by their codes when the service sends them, its English otherwise (an older service). */
export function protectionReasons(t: T, p: { reasons: string[]; reasonCodes?: { code: string; risks?: string[] }[] }): string[] {
  if (!p.reasonCodes || p.reasonCodes.length !== p.reasons.length) return p.reasons;
  return p.reasonCodes.map((r) => t(`protection.reason.${r.code}` as MessageKey, { risks: (r.risks ?? []).map((x) => t(`protection.risk.${x}` as MessageKey)).join("; ") }));
}
/** The privacy basis in the reader's words: by its codes, its English otherwise. */
export function basisText(t: T, a: Pick<PrivacyAssessment, "basis" | "basisWords">): string[] {
  if (!a.basisWords || a.basisWords.length !== a.basis.length) return a.basis;
  return a.basisWords.map((w: BasisWords) => t(`basis.${w.code}` as MessageKey, { ...(w.hours !== undefined ? { hours: w.hours } : {}), ...(w.set !== undefined ? { set: w.set } : {}) }));
}
/** A job state in which the order can be signed again against a fresh quote. */
export const OPEN_FOR_RESIGN = ["expired", "execute-failed", "refund-only"];
/**
 * A relayer's "refunded" the tracker reads back, the escrow read at dust: REFUNDED, or a partial fill's rest re-shielded (PARTIAL, DESTINATION_SUBMITTED on
 * that word); one over an escrow that still holds the order, or one not read, is no refund yet (the twelfth review round, XN's critique: "Refunded on
 * chain" had stood beside a dropped order; XO's: a partial fill's rest had lost its line). PROVIDER_EXECUTING is left out: on that word it also reads a
 * refund at the destination whose refund tokens were not read (XP's critique). The swap screen's refund line.
 */
export const refundReadBack = (jobState: string | null | undefined, reading?: string): boolean =>
  jobState === "refunded" && !!reading && ["REFUNDED", "PARTIAL", "DESTINATION_SUBMITTED"].includes(reading);
/**
 * A funded order can still be returned unexecuted while no execution is running or settled — and one whose reading offers its return, whatever its
 * relayer's job says: FAILED, DROPPED (a relayer's "refunded" over an escrow that still holds the order) and LATE_REFUND (the twelfth review round,
 * XG's and XH's critiques).
 */
export const canReturn = (jobState: string | null | undefined, reading?: string): boolean =>
  !jobState || ["waiting-funding", "expired", "execute-failed"].includes(jobState) || reading === "FAILED" || reading === "DROPPED" || reading === "LATE_REFUND";
