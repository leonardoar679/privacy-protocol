// The Send screen's model (spec v2.0 §7.4; doc §24–§25): what the destination is — a privacy address (a private
// transfer inside the pool: nothing public), an EVM address on the pool's chain (a public exit), a Bitcoin address (a
// cross-chain send, continued in the swap flow), an address that names another chain (asked first: the network never
// changes silently) —, its checks, and the fee split by §3's formulas (exact input by default: what is typed leaves the
// balance and "Recipient receives" is the largest number). Pure: the screen gathers the facts.
import { CHAINS } from "@privacy-wallet/config";
import { decodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { evmChainHint, looksLikeChain, parseBitcoin, parseEvm } from "@privacy-wallet/protocol/wallet/destinations";
import { exactInput, exactOutput, type FeeSplit, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import type { CheckState } from "@privacy-wallet/ui";
import { amountOf } from "../amounts";
import { TARGETS, type Target } from "../swap/targets";
import type { SendModel } from "./View";

export type Destination =
  | { kind: "empty" }
  | { kind: "private"; address: string }
  | { kind: "public"; address: string }
  | { kind: "bitcoin"; address: string }
  /** an EVM address that names another chain (ERC-3770, EIP-681), or another chain's format (Solana) */
  | { kind: "other-chain"; chain: string; chainKey: string | null; address: string }
  | { kind: "invalid"; reason: string };

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The registry's chain for an EIP-155 id. */
const chainOfId = (id: number | null) => (id === null ? undefined : Object.values(CHAINS).find((c) => c.chainId === id));

/** The destination a typed text makes, for a pool on `poolChainId`. */
export function destinationOf(text: string, poolChainId: number): Destination {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (t.toLowerCase().startsWith("pp1")) {
    try {
      decodePrivacyAddress(t);
      return { kind: "private", address: t };
    } catch (e) {
      return { kind: "invalid", reason: reasonOf(e) };
    }
  }
  const hint = evmChainHint(t);
  if (hint) {
    const evm = parseEvm(hint.address);
    if (!evm.ok) return { kind: "invalid", reason: evm.reason };
    if (hint.chainId === poolChainId) return { kind: "public", address: evm.normalized };
    const chain = chainOfId(hint.chainId);
    return {
      kind: "other-chain",
      chain: chain?.name ?? (hint.chainId !== null ? `chain ${hint.chainId}` : hint.name),
      chainKey: chain?.id ?? null,
      address: evm.normalized,
    };
  }
  const evm = parseEvm(t);
  if (evm.ok) return { kind: "public", address: evm.normalized };
  const btc = parseBitcoin(t);
  if (btc.ok) return { kind: "bitcoin", address: btc.normalized };
  if (looksLikeChain(t) === "solana") return { kind: "other-chain", chain: CHAINS.solana.name, chainKey: "solana", address: t };
  if (/^0x/i.test(t)) return { kind: "invalid", reason: evm.reason };
  if (/^(bc1|tb1|[123mn])/i.test(t)) return { kind: "invalid", reason: btc.reason };
  return { kind: "invalid", reason: "not an address this wallet sends to" };
}

/**
 * The swap target a Bitcoin or another chain's destination continues to (spec v2.0 §7.4–§7.5): the same asset on that
 * chain, else the chain's native asset — the swap screen shows the conversion before anything is confirmed —; null when
 * this wallet cannot reach the chain (never a silent fallback to another chain).
 */
export function crossTargetOf(d: Destination, symbol: string, targets: readonly Target[] = Object.values(TARGETS)): Target | null {
  const chain = d.kind === "bitcoin" ? "bitcoin" : d.kind === "other-chain" ? d.chainKey : null;
  if (!chain) return null;
  const on = targets.filter((x) => x.ref.chain === chain);
  return on.find((x) => x.ref.symbol === symbol) ?? on.find((x) => x.ref.asset === "native") ?? null;
}

/** The checks under the address (doc §25): four for a privacy or an EVM address, two for Bitcoin. */
export function checksOf(d: Destination, assetSupported: boolean): SendModel["checks"] {
  const asset: CheckState = assetSupported ? "ok" : "fail";
  switch (d.kind) {
    case "empty":
      return [
        { kind: "valid", state: "idle" },
        { kind: "network", state: "idle" },
        { kind: "asset", state: "idle" },
        { kind: "format", state: "idle" },
      ];
    case "private":
    case "public":
      return [
        { kind: "valid", state: "ok" },
        { kind: "network", state: "ok" },
        { kind: "asset", state: asset },
        { kind: "format", state: "ok" },
      ];
    case "bitcoin":
      return [
        { kind: "btc-address", state: "ok" },
        { kind: "btc-network", state: "ok" },
      ];
    case "other-chain":
      return [
        { kind: "valid", state: "ok" },
        { kind: "network", state: "fail" },
        { kind: "asset", state: asset },
        { kind: "format", state: "ok" },
      ];
    case "invalid":
      return [
        { kind: "valid", state: "fail" },
        { kind: "network", state: "idle" },
        { kind: "asset", state: asset },
        { kind: "format", state: "fail" },
      ];
  }
}

/** The fee split of a send (spec v2.0 §3): exact input — R = A − p(A) − F —, or exact output — the least A that delivers R. */
export function sendSplit(units: bigint, terms: FeeTerms, exact: boolean): FeeSplit | null {
  if (units <= 0n) return null;
  const s = exact ? exactOutput(units, terms) : exactInput(units, terms);
  return s.tooSmall ? null : s;
}

export interface SendFacts {
  asset: { symbol: string; decimals: number } | null;
  amount: string;
  to: string;
  destination: Destination;
  exact: boolean;
  split: FeeSplit | null;
  /** the user confirmed the other chain's network (doc §25) */
  otherChainConfirmed: boolean;
  /** submitted through the connected wallet (Advanced): no relayer, no fee note — the wallet pays the network */
  selfSubmitted?: boolean;
  book?: SendModel["book"];
}

/** The view-model the screen hands SendView. */
export function sendModel(f: SendFacts): SendModel {
  const d = f.destination;
  const a = f.asset;
  const quote =
    a && f.split && (d.kind === "private" || d.kind === "public")
      ? {
          receive: amountOf(f.split.delivered, a.symbol, a.decimals),
          privacyFee: amountOf(f.split.privacy, a.symbol, a.decimals),
          relayerFee: amountOf(f.split.network, a.symbol, a.decimals),
          ...(f.exact ? { total: amountOf(f.split.total, a.symbol, a.decimals) } : {}),
          ...(f.selfSubmitted ? { relayerPaidByWallet: true } : {}),
        }
      : null;
  const continuing = d.kind === "bitcoin" || (d.kind === "other-chain" && f.otherChainConfirmed);
  return {
    asset: a ?? { symbol: "", decimals: 18 },
    amount: f.amount,
    to: f.to,
    checks: checksOf(d, !!a),
    destination: d.kind === "private" ? "private" : d.kind === "public" ? "public" : d.kind === "bitcoin" ? "bitcoin" : null,
    exact: f.exact,
    quote,
    otherChain: d.kind === "other-chain" && !f.otherChainConfirmed ? { chain: d.chain } : null,
    ...(f.book ? { book: f.book } : {}),
    canReview: continuing ? !!a && f.amount !== "" : !!quote,
    action: continuing ? "continue" : "review",
  };
}
