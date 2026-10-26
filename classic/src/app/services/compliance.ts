// The original's compliance behaviour behind switches, off until the owner's legal review (spec v3.0 §7.7; the
// owner's decision 9): the sanctions oracle the original UI asked at connect — Chainalysis' `isSanctioned(address)` on
// Ethereum — and the country geofence, which a host answers with HTTP 451 (the original's edge function did). Both are
// read only when their switch is on; a probe that fails blocks nothing.
import { keccak256 } from "js-sha3";
import type { Rpc } from "../../history/sync";
import { call, wordOf } from "../../history/verify";

/** The Chainalysis sanctions oracle the original UI read (mainnet). */
export const SANCTIONS_ORACLE = "0x40c57923924b5c5c5455c48d93317139addac8fb" as const;
const IS_SANCTIONED = "0x" + keccak256("isSanctioned(address)").slice(0, 8);

export async function isSanctioned(rpc: Rpc, address: `0x${string}`): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("an address is 0x and 40 hex digits");
  return wordOf(await call(rpc, SANCTIONS_ORACLE, IS_SANCTIONED + address.slice(2).toLowerCase().padStart(64, "0"))) === 1n;
}

export type GeofenceAnswer = "allowed" | "blocked" | "unknown";

/** 451 is a block; anything else, or no answer, allows. */
export function geofenceAnswer(status: number | null): GeofenceAnswer {
  if (status === null) return "unknown";
  return status === 451 ? "blocked" : "allowed";
}
