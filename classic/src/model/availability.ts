// What the app can honestly say of a pool right now (spec v3.0 §7.7): each fact apart — the contract against the pins,
// the router's instance, the relayers online, the history synced and verified, the prover, the wallet — as rows of the
// Settings card, and what they allow: a deposit needs the contract, the chain, the router (or the fallback) and the
// wallet on mainnet; a withdrawal needs the contract, a verified history, the prover and a relayer or the wallet. Pure.
import type { PoolId } from "../config";
import type { Availability, Check, ConnectionState } from "./types";

export type ContractFact = "verified" | "differs" | "checking" | "unknown";
export type RouterFact = "enabled" | "disabled" | "checking" | "unknown";
export type HistoryFact = { kind: "ready"; toBlock: number; verified: boolean } | { kind: "loading" } | { kind: "failed" } | { kind: "idle" };
export type ProverFact = "ready" | "loading" | "failed" | "idle";

export interface AvailabilityFacts {
  rpcConfigured: boolean;
  contract: ContractFact;
  router: RouterFact;
  /** null before any relayer was asked */
  relayersOnline: number | null;
  history: HistoryFact;
  prover: ProverFact;
  wallet: ConnectionState | null;
}

const check = (state: Check["state"], text: string, params?: Record<string, string | number>): Check => ({ state, text, ...(params ? { params } : {}) });

export function availabilityOf(pool: PoolId, f: AvailabilityFacts): Availability {
  const contract = !f.rpcConfigured
    ? check("unknown", "availability.noRpc")
    : f.contract === "verified"
      ? check("ok", "availability.contractVerified")
      : f.contract === "differs"
        ? check("off", "availability.contractDiffers")
        : f.contract === "checking"
          ? check("unknown", "availability.checking")
          : check("unknown", "availability.contractUnverified");
  const router = !f.rpcConfigured
    ? check("unknown", "availability.noRpc")
    : f.router === "enabled"
      ? check("ok", "availability.routerEnabled")
      : f.router === "disabled"
        ? check("warn", "availability.routerDisabled")
        : f.router === "checking"
          ? check("unknown", "availability.checking")
          : check("unknown", "availability.routerUnknown");
  const relayers =
    f.relayersOnline === null
      ? check("unknown", "availability.relayersUnknown")
      : f.relayersOnline > 0
        ? check("ok", "availability.relayersOnline", { n: f.relayersOnline })
        : check("off", "availability.relayersNone");
  const history =
    f.history.kind === "ready"
      ? f.history.verified
        ? check("ok", "availability.historySynced", { block: f.history.toBlock })
        : f.rpcConfigured
          ? check("warn", "availability.historyNotVerified") // synced, and the chain or the endpoints did not vouch for it (the critique of C11-12)
          : check("warn", "availability.historyUnverified") // no endpoint: the snapshot or the device's copy, nothing synced
      : f.history.kind === "loading"
        ? check("unknown", "availability.historySyncing")
        : f.history.kind === "failed"
          ? check("off", "availability.historyFailed")
          : check("unknown", "availability.historyUnverified");
  const prover =
    f.prover === "ready"
      ? check("ok", "availability.proverReady")
      : f.prover === "loading"
        ? check("unknown", "availability.proverLoading")
        : f.prover === "failed"
          ? check("off", "availability.proverAbsent")
          : check("unknown", "availability.proverIdle");
  const wallet =
    f.wallet?.status === "connected"
      ? check("ok", "availability.walletConnected")
      : f.wallet?.status === "wrong-network"
        ? check("warn", "availability.walletWrongNetwork")
        : check("off", "availability.walletNotConnected");
  return { pool, contract, router, relayers, history, prover, wallet };
}

/** A deposit: the contract verified now, the router enabled (the direct fallback is the user's explicit choice), the wallet on mainnet. */
export const canDeposit = (f: AvailabilityFacts): boolean => f.rpcConfigured && f.contract === "verified" && f.wallet?.status === "connected";

/** A withdrawal: the contract verified, the history verified, the prover ready, and a relayer online or the wallet on mainnet. */
export const canWithdraw = (f: AvailabilityFacts, via: "relayer" | "wallet"): boolean =>
  f.rpcConfigured &&
  f.contract === "verified" &&
  f.history.kind === "ready" &&
  f.history.verified &&
  f.prover === "ready" &&
  (via === "relayer" ? (f.relayersOnline ?? 0) > 0 : f.wallet?.status === "connected");
