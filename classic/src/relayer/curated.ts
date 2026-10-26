// The curated relayers (spec v3.0 §7.5): classic/relayers.json as classic/scripts/relayers.mjs wrote it from the registry
// and the relayers' own status answers — who the app may ask, and the hosts its content security policy allows. The
// status is read again from each one when a withdrawal is prepared; nothing here is trusted beyond "may be asked".
import list from "../../relayers.json";
import type { RelayerInfo } from "../model/types";

export interface CuratedRelayer {
  ensName: string;
  relayerAddress: string;
  /** https://host */
  url: string;
  rewardAccount: string;
  stakeTorn: string;
  feePercent: number;
  version: string;
  currentQueue: number;
}

export const CURATED_RELAYERS: readonly CuratedRelayer[] = list.relayers;
export const CURATED_AT = { generatedAt: list.generatedAt, block: list.block };

/** The curated list as the screens' relayer rows, their status unknown until asked. */
export const curatedAsInfo = (): RelayerInfo[] =>
  CURATED_RELAYERS.map((r) => ({ id: r.ensName, name: r.ensName, url: r.url, feePercentE4: Math.round(r.feePercent * 10_000), status: "unknown" }));
