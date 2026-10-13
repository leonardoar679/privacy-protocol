// The swap's destinations and words (spec §3.6–§3.7; private-swap spec; whale spec §23): the target assets the
// engine routes to, the asset reference of a vault asset, the provider's settlement words, the custody and gate words
// of the risk model, the duration words. Pure.
import { CHAINS, assetLabel, crossChainTargets } from "@privacy-wallet/config";
import type { AssetRef } from "@privacy-wallet/sdk/swapService";
import type { Asset } from "@privacy-wallet/sdk/assets";

export interface Target { id: string; ref: AssetRef; network: string }
/** The cross-chain destinations, from the asset registry (V6 Stage 3: no token named in a component). */
export const TARGETS: Record<string, Target> = Object.fromEntries(
  crossChainTargets().map((a) => {
    const id = assetLabel(a);
    return [id, { id, ref: { chain: a.chain as AssetRef["chain"], asset: a.address ?? "native", decimals: a.decimals, symbol: a.symbol }, network: CHAINS[a.chain].name }];
  }),
);
export const targetFor = (symbol: string, chain: string): Target => Object.values(TARGETS).find((x) => x.ref.symbol === symbol && x.ref.chain === chain) ?? TARGETS.BTC;

export const refOf = (a: Asset): AssetRef => ({ chain: "ethereum", asset: a.token ?? "native", decimals: a.decimals, symbol: a.symbol });
export const hours = (s: number): string => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
export const durationWords = (seconds: number): string => (seconds >= 2 * 86400 ? `${Math.round(seconds / 86400)} days` : seconds >= 3600 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 60)} min`);
export const riskWord = (security: number): "Low" | "Medium" | "High" => (security >= 85 ? "Low" : security >= 70 ? "Medium" : "High");
export const settlementWords = (p: string): string => (p === "thorchain" || p === "chainflip" ? "native deposit address" : p === "near-intents" ? "solver network" : p === "mayan" ? "signed intent (drivers compete)" : "aggregator / bridge");
export const providerKind = (p: string): "deposit-address" | "signed-intent" | "aggregator-api" => (p === "thorchain" || p === "chainflip" || p === "near-intents" ? "deposit-address" : p === "mayan" ? "signed-intent" : "aggregator-api");
export const CUSTODY_WORDS: Record<string, string> = { "tss-vaults": "threshold-signed vaults", "mpc-vault": "an MPC vault", "relayer-bridge": "a relayer bridge", cctp: "Circle's CCTP attestation", solver: "solver execution", aggregator: "an aggregator over bridges", intent: "an intent settled by solvers", otc: "a counterparty" };
export const GATE_WORDS: Record<string, string> = { source: "settled at the source", "destination-submitted": "settled once the destination transaction is sent", "destination-final": "settled once the destination is final" };
/** A job state in which the order can be signed again against a fresh quote. */
export const OPEN_FOR_RESIGN = ["expired", "execute-failed", "refund-only"];
/** A funded order can still be returned unexecuted while no execution is running or settled. */
export const canReturn = (jobState: string | null | undefined): boolean => !jobState || ["waiting-funding", "expired", "execute-failed"].includes(jobState);
