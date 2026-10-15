// The executor tip (Privacy Wallet Web spec v2.0 §3): the execution's gas cost, not a percentage of the order —
// T = ⌈units × (2·baseFee + priorityFee) × 1.2⌉, the fees from eth_feeHistory through the service's own RPC endpoints
// (never a fixed gas price), in the order's asset: wei for ETH; for an ERC-20 order the same cost in the token at the
// agreed Chainlink prices of the service's valuer (tip_unpriced without them — never a guess). The escrow caps the tip
// at 1 % of its amount on chain (SwapOrderEscrow.sol:74): a tip above that refuses the order, amount_too_small. The
// units and the formula are @privacy-wallet/contracts' (forge's measured deployAndExecute plus the provider's call), the
// conversion @privacy-wallet/protocol's — the wallet checks the tip against its own estimate with the same pieces.
// The privacy fee is not here: it is the wallet's fee note (packages/protocol/src/wallet/fees.ts).
// V6 Stage 12 (spec v2.0 §11.2): a same-chain swap into the protected balance also pays a shield tip — the receiver's
// deployment and deposit at the same fees, in the OUTPUT asset; a route whose minimum could not pay it a hundred times
// over (the receiver's own 1 % rule) cannot be shielded.
import {
  ERC20_ORDER_UNITS,
  GAS_UNITS,
  PROVIDER_CALL_UNITS,
  SHIELD_TIP_DIVISOR,
  executionUnits as unitsOf,
  gasCeilingWei,
  type GasFees,
} from "@privacy-wallet/contracts";
import { weiInAsset, type Prices } from "@privacy-wallet/protocol/wallet/valuation";
import type { AssetRef } from "./types";
import type { Valuer } from "./valuation";

export { ERC20_ORDER_UNITS, PROVIDER_CALL_UNITS, type GasFees };
/** SwapOrderTypes.TIP_DIVISOR: the escrow refuses executorTip > amount / 100. */
export const TIP_DIVISOR = 100n;

export type TipErrorCode = "amount_too_small" | "tip_unpriced" | "fee_history_unavailable";
export class TipError extends Error {
  constructor(
    readonly code: TipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TipError";
  }
}

export interface FeeSource {
  fees(): Promise<GasFees>;
}
/** What the engine asks for an order's tip (./engine.ts EngineConfig.tips), and a protected destination's shield tip. */
export interface TipSource {
  tipFor(from: AssetRef, amount: bigint): Promise<bigint>;
  shieldTipFor?(to: AssetRef): Promise<bigint>;
}
export { SHIELD_TIP_DIVISOR };

/** The gas units of an order's execution. */
export const executionUnits = (from: AssetRef): bigint => unitsOf(from.asset !== "native");

/** ⌈units × (2·baseFee + priorityFee) × 1.2⌉ wei. */
export const tipWei = gasCeilingWei;

/** A cost in wei as `from`'s own units: wei for ETH; a token's units at the agreed ETH and token prices, rounded up. */
export function tipInAsset(wei: bigint, from: AssetRef, prices: Prices | null): bigint {
  const tip = weiInAsset(wei, { symbol: from.symbol, decimals: from.decimals, native: from.asset === "native" }, prices);
  if (tip === null) throw new TipError("tip_unpriced", `no agreed ETH and ${from.symbol} prices: the execution's gas cannot be valued in ${from.symbol}`);
  return tip;
}

/** An order's executor tip: the execution's gas in the order's asset, refused when the escrow could not pay it. */
export async function executorTip(from: AssetRef, amount: bigint, d: { fees: FeeSource; valuer?: Valuer }): Promise<bigint> {
  let fees: GasFees;
  try {
    fees = await d.fees.fees();
  } catch (e) {
    throw new TipError("fee_history_unavailable", `the gas price cannot be read: ${String((e as Error)?.message ?? e)}`);
  }
  const prices = from.asset === "native" ? null : ((await d.valuer?.prices().catch(() => null)) ?? null);
  const tip = tipInAsset(tipWei(executionUnits(from), fees), from, prices);
  if (tip > amount / TIP_DIVISOR)
    throw new TipError("amount_too_small", `executing costs ${tip} of ${from.symbol}'s base units in gas, more than the escrow may pay from ${amount} (1 %)`);
  return tip;
}

/** The gas units of a shield receiver's deployAndShield: forge's measurement for an ETH or a token receipt. */
export const shieldUnits = (to: AssetRef): bigint => (to.asset === "native" ? GAS_UNITS.shieldETH : GAS_UNITS.shieldERC20);

/** A protected destination's shield tip: the receiver's deployment, tip transfer and deposit at today's fees, in the output asset. */
export async function shieldTip(to: AssetRef, d: { fees: FeeSource; valuer?: Valuer }): Promise<bigint> {
  let fees: GasFees;
  try {
    fees = await d.fees.fees();
  } catch (e) {
    throw new TipError("fee_history_unavailable", `the gas price cannot be read: ${String((e as Error)?.message ?? e)}`);
  }
  const prices = to.asset === "native" ? null : ((await d.valuer?.prices().catch(() => null)) ?? null);
  return tipInAsset(tipWei(shieldUnits(to), fees), to, prices);
}

/** The service's tips: the gas from its fee source, an ERC-20 order's (and a token receipt's) valued by its valuer. */
export const gasTips = (fees: FeeSource, valuer?: Valuer): TipSource => ({
  tipFor: (from, amount) => executorTip(from, amount, { fees, valuer }),
  shieldTipFor: (to) => shieldTip(to, { fees, valuer }),
});

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "an RPC endpoint";
  }
};

async function feeHistory(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<GasFees> {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: ["0x5", "latest", [50]] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as { result?: { baseFeePerGas?: string[]; reward?: string[][] }; error?: { message: string } };
  // the endpoint named by its host only: its path carries a key (a V6 follow-up of 2026-10-15)
  if (j.error || !j.result?.baseFeePerGas?.length) throw new Error(`${hostOf(url)}: ${j.error?.message ?? "no fee history"}`);
  const base = BigInt(j.result.baseFeePerGas[j.result.baseFeePerGas.length - 1]); // the next block's
  const rewards = (j.result.reward ?? []).map((x) => BigInt(x[0] ?? "0x0")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { baseFeePerGas: base, priorityFeePerGas: rewards.length ? rewards[rewards.length >> 1] : 0n };
}

/**
 * eth_feeHistory over the service's RPC endpoints: the next block's base fee and the median priority fee of the last
 * five blocks, the higher of the endpoints that answer (the safe side), cached for 15 s; every endpoint failing fails.
 */
export class RpcFeeSource implements FeeSource {
  private cache: { at: number; fees: GasFees } | null = null;
  constructor(
    readonly rpcUrls: string[],
    private readonly fetchImpl: typeof fetch = fetch,
    readonly ttlMs = 15_000,
    readonly timeoutMs = 10_000,
  ) {
    if (!rpcUrls.length) throw new Error("RpcFeeSource needs at least one RPC URL");
  }
  async fees(): Promise<GasFees> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.fees;
    const reads = await Promise.all(this.rpcUrls.map((u) => feeHistory(this.fetchImpl, u, this.timeoutMs).catch((e: Error) => e)));
    const ok = reads.filter((x): x is GasFees => !(x instanceof Error));
    if (!ok.length) throw new Error(reads.map((e) => (e as Error).message).join("; "));
    const fees = ok.reduce((a, b) => ({
      baseFeePerGas: a.baseFeePerGas > b.baseFeePerGas ? a.baseFeePerGas : b.baseFeePerGas,
      priorityFeePerGas: a.priorityFeePerGas > b.priorityFeePerGas ? a.priorityFeePerGas : b.priorityFeePerGas,
    }));
    this.cache = { at: Date.now(), fees };
    return fees;
  }
}
