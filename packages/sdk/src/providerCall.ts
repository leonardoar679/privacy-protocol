// The provider call, checked by THIS wallet before the one-time order key signs it (spec v1.1 §2, §5, §7).
// swapGuard.ts already ensures a swap service cannot redirect the private withdrawal, or get a call signed
// other than the one it shows. This module checks what that call DOES, from the wallet's own request and
// pinned contracts, never from the service's description of it:
//  - the call goes to a known provider contract (an ERC-20 escrow approves it for its whole balance);
//  - it pays this wallet's fresh destination, in the asset and on the chain the wallet asked for;
//  - it spends exactly what the escrow forwards, and a provider refund lands in the escrow (where
//    refund() re-shields it) or, for a provider that only refunds at the destination, at that address;
//  - it binds a minimum output the wallet can read; the caller compares it with what the user approved.
// THORChain's inbound vault rotates, so it is confirmed by a quorum of public THORNode gateways queried
// from here (the request carries no order data); the router is pinned. A call this wallet cannot read is
// refused. A minimum it cannot read (LI.FI into Mayan) is accepted only under the Fastest policy (§9).
// Written independently of packages/swap-engine's adapters; the tests check both decoders agree on
// real provider calls.
import { fetchFor } from "@privacy-wallet/privacy-engine/transport/http";
import { base58 } from "@scure/base";
import { bytesToHex, decodeAbiParameters, decodeFunctionData, getAddress, hexToBytes, isAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import type { AssetRef, Policy } from "./swapService";
import { config } from "./config";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const pinned = (value: string | undefined, fallback: string): Address => getAddress(value && isAddress(value) ? value : fallback);

/** Provider contracts on Ethereum, where every escrow lives. A call to any other address is refused. */
export const PINNED = {
  /** THORChain Router v4.1.1 (the router the gateways report; VITE_THORCHAIN_ROUTER after a router upgrade) */
  // read at use: the configured router after an upgrade, the pin otherwise (V6 Stage 3)
  get thorchainRouter(): Address {
    return pinned(config().thorchainRouter, "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146");
  },
  chainflipVault: getAddress("0xf5e10380213880111522dd0efd3dbb45b9f62bcc"),
  lifiDiamond: getAddress("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"),
  mayanForwarder: getAddress("0x337685fdab40d39bd02028545a4ffa7d287cc3e2"),
  mayanFastMctp: getAddress("0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741"),
  /** Swift V2 (Sourcify exact match; on the forwarder's whitelist): SWIFT auction orders, refunded on Ethereum to their trader */
  mayanSwiftV2: getAddress("0x40ffe85a28dc9993541449464d7529a922142960"),
  /** Mayan's EthWrapper (Sourcify exact match): wrap() turns the ETH sent into WETH 1:1 for the caller */
  mayanEthWrapper: getAddress("0x529863940bf6065d8c122a550c2ff37c1cfefa16"),
  acrossSpokePool: getAddress("0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5"),
  /** Across SpokePoolPeriphery: swapAndBridge, a swap on Ethereum and then the bridge (Sourcify exact match) */
  acrossPeriphery: getAddress("0x97ccdbea4632140639ad5ea9b944aa034eb15fd4"),
} as const;

/** On the destination chains: Across's MulticallHandler (a fill with a message lands here) and AcrossEventEmitter (Sourcify exact match, the same addresses on each chain). */
export const ACROSS_DESTINATION = {
  handler: { optimism: getAddress("0x0f7ae28de1c8532170ad4ee566b5801485c13a0e"), base: getAddress("0x0f7ae28de1c8532170ad4ee566b5801485c13a0e"), arbitrum: getAddress("0x0f7ae28de1c8532170ad4ee566b5801485c13a0e") } as Record<string, Address>,
  emitter: { optimism: getAddress("0xbf75133b48b0a42ab9374027902e83c5e2949034"), base: getAddress("0xbf75133b48b0a42ab9374027902e83c5e2949034"), arbitrum: getAddress("0xbf75133b48b0a42ab9374027902e83c5e2949034") } as Record<string, Address>,
};

const EVM_CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, bsc: 56, avalanche: 43114 };
const WETH: Record<string, Address> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", base: "0x4200000000000000000000000000000000000006",
  optimism: "0x4200000000000000000000000000000000000006", arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
/** Tokens the escrow re-shields through refund(): the order's asset; an ETH order also unwraps WETH. */
const ownAsset = (e: CallExpectation, token: Address) => (e.from.asset === "native" ? same(token, ZERO) || same(token, WETH.ethereum) : same(token, e.from.asset));
/** ...through refundToken(), for an ERC-20 order ETH and WETH, as ETH into the native vault (the escrow unwraps the WETH)... */
const asEth = (e: CallExpectation, token: Address) => e.from.asset !== "native" && (same(token, ZERO) || same(token, WETH.ethereum));
/** ...and any token the pool has a vault for (one this wallet can see the note in). */
const reshieldable = (e: CallExpectation, token: Address) => ownAsset(e, token) || asEth(e, token) || (!same(token, ZERO) && (e.pooled ?? []).some((t) => same(t.token, token)));
/** What a token that re-shields is: ETH (ETH and WETH), the order's own asset, a pooled token as the deployment names it. */
const reshieldableAsset = (e: CallExpectation, token: Address): { symbol: string; decimals: number } | undefined =>
  !reshieldable(e, token) ? undefined
  : same(token, ZERO) || same(token, WETH.ethereum) ? { symbol: "ETH", decimals: 18 }
  : e.from.asset !== "native" && same(token, e.from.asset) ? { symbol: e.from.symbol, decimals: e.from.decimals }
  : e.pooled?.find((t) => same(t.token, token));
/**
 * Whether a floor in one asset counts for an output in another: ETH and WETH are one asset, and so are the dollar stablecoins
 * USDC and USDT (LI.FI routes USDC on Base through a USDT deposit, 2026-10). Anything else only counts for itself.
 */
const sameAsset = (a: string, b: string) => { const n = (s: string) => (/^w?eth$/i.test(s) ? "ETH" : /^usd[ct]$/i.test(s) ? "USD" : s.toUpperCase()); return n(a) === n(b); };
/** Whether `floor` (with `floorDecimals`) covers `out` (with `outDecimals`) of the same asset. */
const covers = (floor: bigint, floorDecimals: number, out: bigint, outDecimals: number) => out * 10n ** BigInt(floorDecimals) <= floor * 10n ** BigInt(outDecimals);
/** The floor the executor is told for a listed token: `least` / `divisor` (PP-S12: dust below it is not worth an unpaid re-shield). */
const floorOf = (tokens: Address[] | undefined, least: bigint, divisor: bigint): Record<string, string> | undefined =>
  tokens ? { [tokens[0].toLowerCase()]: (least / divisor).toString() } : undefined;
/** What the facts say about an unfilled deposit coming back to the escrow. */
const refundFact = (e: CallExpectation, tokens: Address[] | undefined) =>
  tokens ? `an unfilled deposit refunds the escrow in ${tokens[0]}, which re-shields ${asEth(e, tokens[0]) ? "as ETH" : "into its vault"}` : "an unfilled deposit refunds the escrow";
/**
 * Across's exclusivity (the eleventh review round, D11-10): no exclusive relayer, or one whose window ends within this — a relayer named
 * exclusive that never fills would hold the deposit until its fill deadline, the escrow refunded hours later after a bundle. The SpokePool
 * reads a parameter up to a year as seconds from the deposit, a larger one as a timestamp.
 */
const ACROSS_MAX_EXCLUSIVITY_SECONDS = 600;
const ACROSS_EXCLUSIVITY_OFFSET_MAX = 31_536_000;
function mustShortExclusivity(P: ProviderName, relayer: Hex, parameter: number | bigint, now: number): void {
  if (BigInt(relayer) === 0n) return;
  const p = Number(parameter);
  const window = p <= ACROSS_EXCLUSIVITY_OFFSET_MAX ? p : p - now;
  must(window <= ACROSS_MAX_EXCLUSIVITY_SECONDS, P, "exclusivity", `only one relayer may fill the deposit for ${window} s (at most ${ACROSS_MAX_EXCLUSIVITY_SECONDS} s here): one that never fills would hold it until its deadline`);
}
/** USDC on Ethereum: Mayan Fast-MCTP's input token (Circle CCTP). */
const USDC_ETHEREUM: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LIFI_CHAIN_ID: Record<string, bigint> = { ...Object.fromEntries(Object.entries(EVM_CHAIN_ID).map(([k, v]) => [k, BigInt(v)])), solana: 1151111081099710n, bitcoin: 20000000000001n };
/** LI.FI's NON_EVM_ADDRESS: BridgeData.receiver for a non-EVM destination (the real receiver is in the facet data). */
const LIFI_NON_EVM_RECEIVER = "0x11f111f111f111f111f111f111f111f111f111f1";
const CCTP_DOMAIN: Record<string, number> = { ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, solana: 5, base: 6, polygon: 7 };
/** Wormhole chain ids, as Swift orders name their destination */
const WORMHOLE_CHAIN: Record<string, number> = { solana: 1, ethereum: 2, bsc: 4, polygon: 5, avalanche: 6, arbitrum: 23, optimism: 24, base: 30 };
/** A SWIFT order's cancel + refund fees, charged only on a refund, at most this share of the order (bps); its deadline at most this far ahead. */
const SWIFT_MAX_REFUND_FEES_BPS = 100n;
const SWIFT_MAX_DEADLINE_SECONDS = 6 * 3600;
/**
 * A Fast-MCTP order's redeem and refund fees (audit 2026-10-16): at most 1 % of the USDC it carries, or 2 USDC when that is more
 * (they pay the destination's gas, about 0.49 USDC each to Solana and under a cent to Base on 2026-10-16). Its refund pays
 * refundFee to whoever calls it, and for a USDC output it is how the order delivers; Circle's fee at most 1 %; the deadline
 * within the SWIFT bound.
 */
const FAST_MCTP_MAX_FEES_BPS = 100n;
const FAST_MCTP_MIN_FEE_CAP = 2_000_000n;
export const THOR_CHAIN: Record<string, string> = { ethereum: "ETH", bitcoin: "BTC", solana: "SOL", base: "BASE", avalanche: "AVAX", bsc: "BSC", litecoin: "LTC", doge: "DOGE", tron: "TRON" };
const CF_CHAIN: Record<string, [string, number]> = { ethereum: ["Ethereum", 1], bitcoin: ["Bitcoin", 3], arbitrum: ["Arbitrum", 4], solana: ["Solana", 5], tron: ["Tron", 7] };
const CF_ASSET: Record<string, number> = {
  "Ethereum.ETH": 1, "Ethereum.FLIP": 2, "Ethereum.USDC": 3, "Bitcoin.BTC": 5, "Arbitrum.ETH": 6, "Arbitrum.USDC": 7, "Ethereum.USDT": 8,
  "Solana.SOL": 9, "Solana.USDC": 10, "Arbitrum.USDT": 14, "Ethereum.WBTC": 15, "Solana.USDT": 16, "Tron.TRX": 17, "Tron.USDT": 18,
};
/** Chainflip's fill-or-kill retry is in 6-second blocks; a day is the most this wallet lets an order wait before its refund — a DCA's chunks and their spacing count towards it. */
const CF_MAX_RETRY_BLOCKS = 14_400;
/** A THORChain stream this wallet signs (whale spec §12): an explicit quantity (0 would let the network choose), at most THORNode's own day of 6-second blocks, at most 100 blocks apart. */
const THOR_MAX_STREAM_PARTS = 14_400;
const THOR_MAX_INTERVAL_BLOCKS = 100;
/** The most digits a memo's limit may have (10^30 in 1e8 units: more than any asset's supply). */
export const THOR_LIMIT_DIGITS = 30;

/**
 * Whether a memo's number is in the canonical decimal form, bounded (the eleventh review round, 2026-11-04, D11-1): THORNode reads a single
 * swap's limit with Go's base-0 rule, where a leading 0 is octal — `050000000` is 10,485,760, not the 50,000,000 a decimal reading gives —, and
 * a number it cannot parse (an 8 or 9 after a leading 0, more than 256 bits) makes the memo invalid, which THORChain refunds to the
 * transaction's signer: the relayer. A stream's numbers it reads in base 10; the wallet signs the canonical form only, there too.
 */
export const isThorDecimal = (n: string, digits: number = THOR_LIMIT_DIGITS): boolean => n.length <= digits && (n === "0" || /^[1-9]\d*$/.test(n));
/**
 * The third review round (2026-11-03): an ETH → USDC leg a Mayan order runs first (a router Mayan names, bounded on chain by the
 * forwarder's minMiddleAmount) must be bounded at this share of the ETH's value at this wallet's own agreed Chainlink price, or
 * the call is refused. Before, any positive floor passed: a swap service could route the whole order through its own pool with
 * the Mayan order holding one USDC unit — the order's own minimum is conditional on a fill — while the wallet's minimum check
 * still passed. Two per cent covers the feed's deviation threshold, the leg's slippage and the router's fee.
 */
export const MAYAN_MIDDLE_MAX_SHORTFALL_BPS = 200n;

export type ProviderName = "thorchain" | "chainflip" | "mayan" | "lifi" | "across";

export interface ProviderCall { provider: Address; value: bigint; calldata: Hex }

export interface CallExpectation {
  /** the order's escrow, recomputed by this wallet from its own factory (swapGuard.checkOrder) */
  escrow: Address;
  /** what this wallet asked for, from its own journal, never the service's echo */
  from: AssetRef;
  to: AssetRef;
  destination: string;
  /** amount − executor tip: what the escrow forwards to the provider */
  net: bigint;
  policy: Policy;
  /** the deployment's chain: the pinned provider contracts exist on Ethereum mainnet (1) only */
  chainId?: bigint;
  /** tokens the pool has a vault for (this wallet's configured ERC-20 assets, as its deployment names them): a token a provider pays back in re-shields there through the escrow's refundToken, and this wallet sees the note */
  pooled?: { token: string; symbol: string; decimals: number }[];
  /** this wallet's own agreed, fresh Chainlink prices by symbol (`usd1e8`), read through its RPC quorum at signing (the third review round, 2026-11-03): a swap-first Mayan leg is bounded against ETH's (and USDC's, when a feed gives one) and refused without */
  usd?: Record<string, bigint>;
  /** unix seconds (tests) */
  now?: number;
}

export interface CheckedCall {
  provider: ProviderName;
  receiver: string;
  /** the least the call can deliver, in `to` base units; null when the call binds no minimum this wallet can read */
  minOut: bigint | null;
  /** where a provider-level refund lands */
  refundTo: "escrow" | "destination" | "provider";
  /** tokens other than the order's asset the call may pay back to the escrow (a source swap's output): the executor re-shields them through refundToken */
  refundTokens?: Address[];
  /** per listed token (lowercase): the least balance worth a re-shield nothing pays for, a share of the least the route moves in it (PP-S12) */
  refundFloors?: Record<string, string>;
  /** what this wallet confirmed, in plain words */
  facts: string[];
}

export class ProviderCallMismatch extends Error {
  constructor(public readonly provider: string, public readonly field: string, detail: string) {
    super(`the provider call does not do what this wallet asked for (${provider} ${field}: ${detail}) — not signing it`);
  }
}

/**
 * The call cannot go ahead right now: too few THORNode gateways answered, or THORChain has halted the chain's inbound.
 * Nothing goes ahead, and the runner tries again later (an order whose window closes meanwhile stops for "Return funds").
 * It is an outage, not a call that does something else (ProviderCallMismatch). Before (V6 follow-ups of 2026-10-14), a
 * gateway outage — and a halt, when the call was one the user had accepted before — stopped a funded swap as an unsafe
 * call, and a protected execution's step as an unexpected destination.
 */
export class ProviderCallUnverified extends Error {
  constructor(public readonly provider: string, detail: string) {
    super(`the provider call cannot be checked right now (${provider}: ${detail}); nothing goes ahead until it can be`);
  }
}

/** The call is sound but guarantees less than the user approved; signing needs the user's consent to the new minimum. */
export class MinimumMoved extends Error {
  constructor(public readonly minOut: bigint, public readonly approved: bigint) {
    super(`the route now guarantees at least ${minOut}, below the ${approved} you approved`);
  }
}

/**
 * `router` is set for EVM chains only (UTXO chains are paid at the vault address directly). `address` is the inbound vault
 * every gateway that answered reports, or "" while they report different ones: THORChain is moving it between its active
 * vaults, and a vault is then confirmed against their lists of active vaults (ActiveVaultLookup).
 */
export interface InboundVault {
  address: string;
  router?: string;
  halted: boolean;
  agreeing: string[];
  /** every chain a reachable gateway reports halted or trading-paused, from the same answers (the eleventh review round, D11-9) */
  haltedChains?: string[];
}
/** THORChain's EVM chains: their inbound entries carry a router contract. */
const THOR_EVM_CHAINS = ["ETH", "BASE", "AVAX", "BSC"];
export type InboundLookup = (chain: string) => Promise<InboundVault>;
/** Confirms `vault` as one of THORChain's active vaults for `chain` (thornodeActiveVault), or throws. */
export type ActiveVaultLookup = (chain: string, vault: string) => Promise<{ confirmedBy: string[] }>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The 32-byte form of an address on `chain`: an EVM address left-padded, a Solana key as is. */
export function bytes32Of(chain: string, address: string): Hex {
  if (EVM_CHAIN_ID[chain] !== undefined) {
    if (!isAddress(address, { strict: false })) throw new Error(`not an EVM address: ${address}`);
    return padHex(address.toLowerCase() as Hex, { size: 32 });
  }
  if (chain === "solana") {
    const b = base58.decode(address);
    if (b.length !== 32) throw new Error(`not a Solana address: ${address}`);
    return bytesToHex(b);
  }
  throw new Error(`no 32-byte address form for ${chain}`);
}

/** THORChain's short form for a UTXO memo that must fit 80 bytes (`ETH.USDC`, as its own quote API writes it); native assets stay full. */
export function thorAssetShort(a: AssetRef): string {
  const full = thorAsset(a);
  return a.asset === "native" ? full : full.slice(0, full.indexOf("-"));
}

/** THORChain asset notation, as the engine writes it into the memo: CHAIN.SYMBOL or CHAIN.SYMBOL-0XTOKEN. */
export function thorAsset(a: AssetRef): string {
  const chain = THOR_CHAIN[a.chain];
  if (!chain) throw new Error(`THORChain does not serve ${a.chain}`);
  return a.asset === "native" ? `${chain}.${a.symbol.toUpperCase()}` : `${chain}.${a.symbol.toUpperCase()}-${a.asset.toUpperCase()}`;
}

/** THORChain limits are in 1e8 units whatever the asset's decimals. */
export const from1e8 = (v: bigint, decimals: number) => (v * 10n ** BigInt(decimals)) / 10n ** 8n;

// ---- THORNode gateways: the inbound vault, confirmed from this wallet -----------------------------

/** The gateways and their quorum from the configuration (V6 Stage 3); the platform allowlists them (spec §7). */
// each gateway once, as first named (the audit's unverified m25): one named twice counted its operator twice toward the quorum
export const thornodeGateways = (): string[] => {
  const seen = new Set<string>();
  return config()
    .thornode.gateways.map((s) => s.trim().replace(/\/+$/, ""))
    .filter((u) => {
      if (!u || seen.has(u.toLowerCase())) return false;
      seen.add(u.toLowerCase());
      return true;
    });
};
export const thornodeQuorum = (): number => Math.max(2, config().thornode.quorum);

/**
 * The inbound vault + router for `chain` (THORChain notation, e.g. "ETH"), as at least `quorum` gateways
 * report it; any reachable gateway that reports another router fails the lookup (fail closed), and halted
 * on any of them is halted. Gateways that report different vaults leave `address` empty: THORChain moves
 * its inbound vault between its active vaults several times an hour, and a gateway a block behind still
 * reports the previous one — the vault is then confirmed against every gateway's list of active vaults
 * (thornodeActiveVault). The request is the same for every user (all chains, no amounts, no addresses),
 * and carries no cookie or referrer.
 */
export async function thornodeInbound(chain: string, opts: { gateways?: string[]; quorum?: number; fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<InboundVault> {
  const gateways = opts.gateways ?? thornodeGateways(), quorum = opts.quorum ?? thornodeQuorum(), fetchFn = opts.fetchFn ?? fetchFor("thornode");
  const answers = await Promise.all(gateways.map(async (base) => {
    try {
      const r = await fetchFn(`${base}/thorchain/inbound_addresses`, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      if (!r.ok) return { base };
      const list = (await r.json()) as any[];
      const e = Array.isArray(list) ? list.find((c) => c?.chain === chain) : undefined;
      const ok = !!e && (THOR_EVM_CHAINS.includes(chain) ? isAddress(String(e.address)) && isAddress(String(e.router)) : typeof e.address === "string" && /^[a-zA-Z0-9:]{20,100}$/.test(e.address));
      const halted = list.filter((c) => !!(c?.halted || c?.global_trading_paused || c?.chain_trading_paused)).map((c) => String(c?.chain));
      return ok ? { base, entry: e, halted } : { base };
    } catch { return { base }; }
  }));
  const reachable = answers.filter((a) => a.entry);
  if (reachable.length < quorum) throw new ProviderCallUnverified("thorchain", `only ${reachable.length} of ${gateways.length} THORNode gateways answered for ${chain}; ${quorum} must agree`);
  const router = (e: any) => String(e.router ?? "").toLowerCase();
  if (reachable.some((a) => router(a.entry) !== router(reachable[0].entry))) throw new ProviderCallMismatch("thorchain", "router", `THORNode gateways disagree on the ${chain} router`);
  const e: any = reachable[0].entry;
  const moving = reachable.some((a) => !same(String(a.entry.address), String(e.address)));
  const evm = THOR_EVM_CHAINS.includes(chain);
  return {
    address: moving ? "" : evm ? getAddress(e.address) : String(e.address),
    router: evm ? getAddress(e.router) : undefined,
    halted: reachable.some(({ entry: x }: any) => !!(x.halted || x.global_trading_paused || x.chain_trading_paused)),
    agreeing: reachable.map((a) => a.base),
    haltedChains: [...new Set(reachable.flatMap((a) => (a as { halted?: string[] }).halted ?? []))],
  };
}

/**
 * `vault` as one of THORChain's active vaults for `chain`: listed among its ActiveVault addresses by every gateway that
 * answers (at least `quorum` of them; one that does not list it fails the check — fail closed: a lying gateway cannot add
 * a vault, and an honest one is never outvoted). THORNode processes a deposit into any of its vaults that is not inactive;
 * the inbound vault is the one it suggests at that moment, and it moves the suggestion between its active vaults several
 * times an hour (2026-10-14: a swap whose call named the vault suggested half a minute earlier had stopped as an unsafe
 * call). The request is the same for every user.
 */
export async function thornodeActiveVault(chain: string, vault: string, opts: { gateways?: string[]; quorum?: number; fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<{ confirmedBy: string[] }> {
  const gateways = opts.gateways ?? thornodeGateways(), quorum = opts.quorum ?? thornodeQuorum(), fetchFn = opts.fetchFn ?? fetchFor("thornode");
  const lists = await Promise.all(gateways.map(async (base) => {
    try {
      const r = await fetchFn(`${base}/thorchain/vaults/asgard`, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      if (!r.ok) return { base };
      const vaults = (await r.json()) as any[];
      const active = (Array.isArray(vaults) ? vaults : [])
        .filter((v) => v?.status === "ActiveVault" && Array.isArray(v.addresses))
        .flatMap((v) => v.addresses.filter((a: any) => a?.chain === chain && typeof a.address === "string").map((a: any) => String(a.address)));
      return active.length ? { base, active } : { base }; // a list without one active vault for the chain is no answer
    } catch { return { base }; }
  }));
  const answered = lists.filter((l): l is { base: string; active: string[] } => !!l.active);
  if (answered.length < quorum) throw new ProviderCallUnverified("thorchain", `only ${answered.length} of ${gateways.length} THORNode gateways listed THORChain's ${chain} vaults; ${quorum} must agree`);
  const missing = answered.filter((l) => !l.active.some((a) => same(a, vault)));
  // listed by none: not THORChain's vault; by some only: a gateway behind a churn — the check cannot be made yet, asked again (the eleventh review
  // round, after its critique: a delayed order had been abandoned on one gateway's lag)
  if (missing.length === answered.length) throw new ProviderCallMismatch("thorchain", "vault", `${vault} is not an active THORChain ${chain} vault on ${missing.length} of the ${answered.length} THORNode gateways that answered`);
  if (missing.length) throw new ProviderCallUnverified("thorchain", `${vault} is not an active THORChain ${chain} vault on ${missing.length} of the ${answered.length} THORNode gateways that answered (one behind a churn): asked again`);
  return { confirmedBy: answered.map((l) => l.base) };
}

// ---- ABIs (the provider contracts' entry points the engine's adapters produce) --------------------

const THOR_ABI = parseAbi(["function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiry) payable"]);
const CHAINFLIP_ABI = parseAbi([
  "function xSwapNative(uint32 dstChain, bytes dstAddress, uint32 dstToken, bytes cfParameters) payable",
  "function xSwapToken(uint32 dstChain, bytes dstAddress, uint32 dstToken, address srcToken, uint256 amount, bytes cfParameters)",
]);
/** SpokePoolPeriphery.swapAndBridge (contracts/interfaces/SpokePoolPeripheryInterface.sol as deployed 2026-10) */
const PERIPHERY_ABI = parseAbi([
  "struct Fees { uint256 amount; address recipient; }",
  "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
  "function swapAndBridge(SwapAndDepositData swapAndDepositData) payable",
]);
/** MulticallHandler's message: Instructions { Call[] calls; address fallbackRecipient } */
const HANDLER_MESSAGE = [{ type: "tuple", components: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }, { name: "value", type: "uint256" }] }, { name: "fallbackRecipient", type: "address" }] }] as const;
const HANDLER_ABI = parseAbi(["function drainLeftoverTokens(address token, address destination)", "function emitData(bytes data)", "function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)"]);
const WETH_ABI = parseAbi(["function withdraw(uint256 wad)"]);

const ACROSS_ABI = parseAbi(["function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable"]);
const MAYAN_FORWARDER_ABI = parseAbi([
  "struct PermitParams { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function swapAndForwardEth(uint256 amountIn, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address mayanProtocol, bytes mayanData) payable",
  "function forwardERC20(address tokenIn, uint256 amountIn, PermitParams permitParams, address mayanProtocol, bytes protocolData) payable",
]);
/** SwiftSource V2 (Mayan, verified source): createOrderWithToken; a tokenIn of 0 locks WETH and refunds ETH ("wrap & lock") */
const SWIFT_V2_ABI = parseAbi([
  "struct OrderParams { uint8 payloadType; bytes32 trader; bytes32 destAddr; uint16 destChainId; bytes32 referrerAddr; bytes32 tokenOut; uint64 minAmountOut; uint64 gasDrop; uint64 cancelFee; uint64 refundFee; uint64 deadline; uint8 referrerBps; uint8 auctionMode; bytes32 random; }",
  "function createOrderWithToken(address tokenIn, uint256 amountIn, OrderParams params, bytes customPayload) returns (bytes32)",
]);
const SEL_WRAP = "0xd46eb119"; // EthWrapper.wrap()
const FAST_MCTP_ABI = parseAbi([
  "struct OrderPayload { uint8 payloadType; bytes32 destAddr; bytes32 tokenOut; uint64 amountOutMin; uint64 gasDrop; uint64 redeemFee; uint64 refundFee; uint64 deadline; bytes32 referrerAddr; uint8 referrerBps; }",
  "function createOrder(address tokenIn, uint256 amountIn, uint256 circleMaxFee, uint32 destDomain, uint32 minFinalityThreshold, OrderPayload orderPayload)",
]);
/** LI.FI diamond: the facets this wallet reads (lifinance/contracts AcrossFacetV4.sol, MayanFacet.sol as deployed 2026-10). */
const LIFI_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
  "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData) payable",
  "function startBridgeTokensViaMayan(BridgeData _bridgeData, MayanData _mayanData) payable",
  "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
]);
/** AcrossFacetV4.MULTIPLIER_BASE */
const ACROSS_MULTIPLIER_BASE = 10n ** 18n;

/** Decode against `abi` or refuse: a selector outside it is a call this wallet cannot read. */
function decode<A extends readonly unknown[]>(provider: ProviderName, abi: A, data: Hex): { functionName: string; args: readonly any[] } {
  try { return decodeFunctionData({ abi: abi as any, data }) as any; }
  catch { throw new ProviderCallMismatch(provider, "call", `${data.slice(0, 10)} is not an entry point this wallet can read`); }
}

// ---- the check ---------------------------------------------------------------------------------------

/**
 * Throws ProviderCallMismatch unless `call` is one this wallet can read, sent to a pinned provider
 * contract, paying `e.destination` in `e.to`, spending `e.net` of `e.from`, with provider refunds to the
 * escrow. Returns what it confirmed, including the minimum output (compare it with `checkMinimum`).
 */
export async function checkProviderCall(call: ProviderCall, e: CallExpectation, deps: { inbound?: InboundLookup; active?: ActiveVaultLookup } = {}): Promise<CheckedCall> {
  if (e.from.chain !== "ethereum") throw new ProviderCallMismatch("escrow", "source", "escrows live on Ethereum");
  // on a testnet the pinned addresses hold no contract: the escrow's call would succeed and pay an empty address
  if (e.chainId !== undefined && e.chainId !== 1n) throw new ProviderCallMismatch("escrow", "chain", `the provider contracts are on Ethereum mainnet; this deployment is chain ${e.chainId}, where they do not exist (return the order to your private balance instead)`);
  if (!isAddress(call.provider)) throw new ProviderCallMismatch("escrow", "provider", `${call.provider} is not an address`);
  const now = e.now ?? Math.floor(Date.now() / 1000);
  let checked: CheckedCall;
  const guarded = async (name: ProviderName, f: () => CheckedCall | Promise<CheckedCall>) => {
    // an outage stays an outage: the runner tries again, it never reads it as a call that does something else
    try { return await f(); } catch (err) { throw err instanceof ProviderCallMismatch || err instanceof ProviderCallUnverified ? err : new ProviderCallMismatch(name, "call", String((err as Error).message ?? err)); }
  };
  if (same(call.provider, PINNED.thorchainRouter))
    checked = await guarded("thorchain", () => thorchain(call, e, now, deps.inbound ?? ((chain) => thornodeInbound(chain)), deps.active ?? ((chain, vault) => thornodeActiveVault(chain, vault))));
  else if (same(call.provider, PINNED.chainflipVault)) checked = await guarded("chainflip", () => chainflip(call, e));
  else if (same(call.provider, PINNED.acrossSpokePool)) checked = await guarded("across", () => across(call, e, now));
  else if (same(call.provider, PINNED.acrossPeriphery)) checked = await guarded("across", () => acrossSwap(call, e, now));
  else if (same(call.provider, PINNED.mayanForwarder)) checked = await guarded("mayan", () => mayan(call, e, now));
  else if (same(call.provider, PINNED.lifiDiamond)) checked = await guarded("lifi", () => lifi(call, e, now));
  else if (e.from.asset !== "native" && same(call.provider, e.from.asset)) {
    throw new ProviderCallMismatch("deposit address", "receiver", "a token transfer to a provider's deposit address: where that address pays out is the provider's promise, not something this wallet can read");
  } else if (call.calldata === "0x") {
    throw new ProviderCallMismatch("deposit address", "receiver", `${call.provider} is a plain deposit address: where it pays out is the provider's promise, not something this wallet can read`);
  } else {
    throw new ProviderCallMismatch("unknown", "provider", `${call.provider} is not a provider contract this wallet knows`);
  }
  if (checked.minOut === null && e.policy !== "fastest") throw new ProviderCallMismatch(checked.provider, "minimum", "this call binds no minimum output this wallet can read; only the Fastest policy accepts that");
  if (checked.minOut === null) checked.facts.push("minimum output: not readable in this call (accepted under Fastest)");
  return checked;
}

/** Throws MinimumMoved when the call guarantees less than the user approved. */
export function checkMinimum(checked: CheckedCall, approved: bigint): void {
  if (checked.minOut !== null && checked.minOut < approved) throw new MinimumMoved(checked.minOut, approved);
}

function must(ok: boolean, provider: ProviderName, field: string, detail: string): asserts ok {
  if (!ok) throw new ProviderCallMismatch(provider, field, detail);
}

async function thorchain(call: ProviderCall, e: CallExpectation, now: number, inbound: InboundLookup, active: ActiveVaultLookup): Promise<CheckedCall> {
  const P: ProviderName = "thorchain";
  const { args } = decode(P, THOR_ABI, call.calldata);
  const [vault, asset, amount, memo, expiry] = args as [Address, Address, bigint, string, bigint];
  const v = await inbound("ETH");
  // a halt is THORChain's outage, as the API reads it when it prepares a call: tried again, never an unsafe call
  if (v.halted) throw new ProviderCallUnverified(P, "THORChain has halted Ethereum inbound");
  // and the destination chain's (the eleventh review round, D11-9): THORChain refunds a swap into a halted or trading-paused chain at once,
  // less its outbound fee — nothing swapped, the tip spent and the escrow's refund waited for. The engine refuses such a call when it
  // prepares it; the wallet reads it too, from the same quorum, and tries again later
  const destChain = THOR_CHAIN[e.to.chain];
  if (destChain && destChain !== "ETH" && v.haltedChains?.includes(destChain)) throw new ProviderCallUnverified(P, `THORChain has halted ${destChain}: it would refund the swap at once, less its outbound fee`);
  must(!!v.router && same(v.router, call.provider), P, "router", `the gateways report router ${v.router}, the call targets ${call.provider}`);
  // the vault THORChain suggests now, or another of its active vaults (it moves the suggestion between them several times
  // an hour; a call prepared a moment before names the previous one): every gateway that answers must list it
  const vaultFact = v.address && same(vault, v.address)
    ? `inbound vault confirmed by ${v.agreeing.length} THORNode gateways`
    : `an active THORChain vault, listed by the ${(await active("ETH", vault)).confirmedBy.length} THORNode gateways that answered`;
  must(same(asset, e.from.asset === "native" ? ZERO : e.from.asset), P, "asset", `deposits ${asset}, not ${e.from.symbol}`);
  must(amount === e.net, P, "amount", `${amount} != ${e.net}`);
  must(call.value === (e.from.asset === "native" ? e.net : 0n), P, "value", `${call.value} forwarded`);
  must(expiry > BigInt(now), P, "expiry", "already passed");
  // =:ASSET:DEST/REFUND:LIMIT[/INTERVAL/QUANTITY] — no affiliate: exactly the swap this wallet asked for; a stream's plan is explicit and bounded (whale spec §12, §15)
  const m = /^=:([^:]+):([^:/]+)\/([^:/]+):(\d+)(?:\/(\d+)\/(\d+))?$/.exec(memo);
  must(!!m, P, "memo", `"${memo}" is not =:ASSET:DEST/REFUND:LIMIT[/INTERVAL/QUANTITY]`);
  const [, memoAsset, memoDest, memoRefund, limit, interval, quantity] = m!;
  must(isThorDecimal(limit), P, "memo", `the memo's limit ${limit.length > 40 ? limit.slice(0, 40) + "…" : limit} is not in the canonical decimal form (no leading zero, at most ${THOR_LIMIT_DIGITS} digits): THORNode reads a single swap's limit with a leading zero as octal, and one it cannot parse makes the memo invalid, refunded to the relayer`);
  must(interval === undefined || (isThorDecimal(interval, 5) && isThorDecimal(quantity!, 5)), P, "streaming", `the stream's interval ${interval} and quantity ${quantity} are not plain decimals of at most 5 digits`);
  must(memoAsset === thorAsset(e.to), P, "memo asset", `${memoAsset} is not ${thorAsset(e.to)}`);
  must(memoDest === e.destination, P, "receiver", `the memo pays ${memoDest}, not your fresh address`);
  must(same(memoRefund, e.escrow), P, "refund", `a refund would go to ${memoRefund}, not the escrow`);
  let planFact = "one swap";
  if (interval !== undefined) {
    const i = Number(interval), n = Number(quantity);
    // the whole stream within a day of blocks too (the third review round, 2026-11-03): the parts and the spacing had been bounded apart
    must(i >= 1 && i <= THOR_MAX_INTERVAL_BLOCKS && n >= 1 && n <= THOR_MAX_STREAM_PARTS && i * n <= THOR_MAX_STREAM_PARTS, P, "streaming", `${n} sub-swaps every ${i} block(s) is outside what this wallet accepts (1–${THOR_MAX_STREAM_PARTS} sub-swaps, 1–${THOR_MAX_INTERVAL_BLOCKS} blocks apart, the whole stream within ${THOR_MAX_STREAM_PARTS} blocks; a quantity of 0 would let the network choose)`);
    planFact = `streams ${n} sub-swaps, one every ${i} block(s): the limit applies per sub-swap; sub-swaps that do not execute refund the escrow`;
  }
  const minOut = from1e8(BigInt(limit), e.to.decimals);
  return {
    provider: P, receiver: memoDest, minOut, refundTo: "escrow",
    facts: [`router pinned; ${vaultFact}`, "memo pays your fresh address", "a THORChain refund goes to the escrow", `limit ${limit} (1e8 units)`, planFact],
  };
}

function chainflip(call: ProviderCall, e: CallExpectation): CheckedCall {
  const P: ProviderName = "chainflip";
  const { functionName, args } = decode(P, CHAINFLIP_ABI, call.calldata);
  const dst = CF_CHAIN[e.to.chain];
  must(!!dst, P, "destination", `Chainflip does not serve ${e.to.chain}`);
  const dstSymbol = e.to.asset === "native" ? ({ bitcoin: "BTC", solana: "SOL", tron: "TRX" } as Record<string, string>)[e.to.chain] ?? "ETH" : e.to.symbol.toUpperCase();
  const [dstChain, dstAddress, dstToken] = args as [number, Hex, number];
  must(dstChain === dst[1], P, "chain", `pays out on Chainflip chain ${dstChain}, not ${dst[0]}`);
  must(dstToken === CF_ASSET[`${dst[0]}.${dstSymbol}`], P, "asset", `pays out asset ${dstToken}, not ${dst[0]}.${dstSymbol}`);
  const want = e.to.chain === "bitcoin" ? new TextEncoder().encode(e.destination) : e.to.chain === "solana" ? base58.decode(e.destination) : hexToBytes(e.destination as Hex);
  must(bytesEqual(hexToBytes(dstAddress), want), P, "receiver", "the vault swap pays another address than your fresh one");
  let srcAmount: bigint, cfParameters: Hex;
  if (functionName === "xSwapNative") {
    must(e.from.asset === "native", P, "asset", "a native swap for a token order");
    must(call.value === e.net, P, "value", `${call.value} != ${e.net}`);
    srcAmount = call.value; cfParameters = args[3] as Hex;
  } else {
    const [, , , srcToken, amount, cf] = args as [number, Hex, number, Address, bigint, Hex];
    must(e.from.asset !== "native" && same(srcToken, e.from.asset), P, "asset", `swaps ${srcToken}, not ${e.from.symbol}`);
    must(amount === e.net && call.value === 0n, P, "amount", `${amount} (value ${call.value}) != ${e.net}`);
    srcAmount = amount; cfParameters = cf;
  }
  const cf = decodeCfParameters(hexToBytes(cfParameters));
  must(same(cf.refundAddress, e.escrow), P, "refund", `a fill-or-kill refund would go to ${cf.refundAddress}, not the escrow`);
  must(cf.brokerBps === 0 && cf.boostFee === 0, P, "fees", "carries a broker fee or boost");
  must(cf.retryDuration <= CF_MAX_RETRY_BLOCKS, P, "retry", `${cf.retryDuration} blocks before a refund`);
  // a DCA plan (whale spec §12, §15): the min price applies per chunk, unfilled chunks refund the escrow; the whole plan plus the retry fits a day
  if (cf.dca) must(cf.dca.chunks >= 1 && cf.dca.interval >= 1 && cf.dca.chunks * cf.dca.interval + cf.retryDuration <= CF_MAX_RETRY_BLOCKS, P, "dca", `${cf.dca.chunks} chunks every ${cf.dca.interval} block(s) plus ${cf.retryDuration} retry blocks exceed a day`);
  const minOut = (srcAmount * cf.minPriceX128) >> 128n;
  return { provider: P, receiver: e.destination, minOut, refundTo: "escrow", facts: ["vault pinned", "pays your fresh address", "fill-or-kill refund to the escrow", "no broker fee or boost", cf.dca ? `DCA: ${cf.dca.chunks} chunks, one every ${cf.dca.interval} block(s); the min price applies per chunk, unfilled chunks refund the escrow` : "one swap"] };
}

interface CfParameters { refundAddress: Address; retryDuration: number; minPriceX128: bigint; boostFee: number; brokerBps: number; dca: { chunks: number; interval: number } | null }

/** cfParameters v1 for an EVM-source vault swap (SCALE, little-endian), as Chainflip's backend encodes it. */
export function decodeCfParameters(b: Uint8Array): CfParameters {
  const fail = (why: string): never => { throw new ProviderCallMismatch("chainflip", "cfParameters", why); };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n: number) => { if (i + n > b.length) fail("truncated"); };
  need(1); if (b[i++] !== 1) fail(`version ${b[0]} not understood`);
  need(4); const retryDuration = dv.getUint32(i, true); i += 4;
  need(20); const refundAddress = getAddress(bytesToHex(b.subarray(i, i + 20))); i += 20;
  need(32); let minPriceX128 = 0n; for (let k = 31; k >= 0; k--) minPriceX128 = (minPriceX128 << 8n) | BigInt(b[i + k]); i += 32;
  need(1); if (b[i++] !== 0) fail("refund CCM metadata present");
  // an Option is 0 or 1 in SCALE (the eleventh review round, D11-5): Chainflip's witness refuses another tag and ignores the vault swap — no
  // swap and no refund; any other byte had read as None here
  const option = (what: string): boolean => { need(1); const t = b[i++]; if (t > 1) fail(`the ${what} option's tag is ${t}, not 0 or 1: Chainflip would ignore the swap`); return t === 1; };
  if (option("max oracle slippage")) { need(2); i += 2; } // max oracle slippage: does not move money
  let dca: CfParameters["dca"] = null; if (option("DCA")) { need(8); dca = { chunks: dv.getUint32(i, true), interval: dv.getUint32(i + 4, true) }; i += 8; }
  need(1); const boostFee = b[i++];
  need(32); i += 32; // broker account
  need(2); const brokerBps = dv.getUint16(i, true); i += 2;
  need(1); if (b[i++] !== 0) fail("affiliate fees present");
  if (i !== b.length) fail(`${b.length - i} trailing bytes`);
  return { refundAddress, retryDuration, minPriceX128, boostFee, brokerBps, dca };
}

/**
 * Across's swap leg: SpokePoolPeriphery.swapAndBridge swaps on Ethereum and deposits the result into the SpokePool
 * it is told (any address: so it must be the pinned one). The guaranteed output is the deposit's outputAmount
 * (proportional adjustment only raises it), backed by the swap's own floor; an unfilled deposit refunds the
 * depositor in the swapped token. The fill pays the fresh address directly, or the pinned MulticallHandler whose
 * message must hand the output token to it (anything a message leaves in the handler can be taken by anyone).
 */
function acrossSwap(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "across";
  const { args } = decode(P, PERIPHERY_ABI, call.calldata);
  const s = args[0] as { submissionFees: { amount: bigint }; depositData: { inputToken: Address; outputToken: Hex; outputAmount: bigint; depositor: Address; recipient: Hex; destinationChainId: bigint; exclusiveRelayer: Hex; fillDeadline: number; exclusivityParameter: number; message: Hex }; swapToken: Address; swapTokenAmount: bigint; minExpectedInputTokenAmount: bigint; spokePool: Address; nonce: bigint };
  const d = s.depositData;
  const nativeOut = e.to.asset === "native";
  const outToken = nativeOut ? WETH[e.to.chain] : (e.to.asset as Address);
  must(EVM_CHAIN_ID[e.to.chain] !== undefined && !!outToken, P, "destination", `the swap leg pays on an EVM chain it knows, not ${e.to.symbol} on ${e.to.chain}`);
  must(d.destinationChainId === BigInt(EVM_CHAIN_ID[e.to.chain]), P, "chain", `bridges to chain ${d.destinationChainId}, not ${e.to.chain}`);
  const native = e.from.asset === "native";
  must(same(s.swapToken, native ? WETH.ethereum : e.from.asset) && s.swapTokenAmount === e.net && call.value === (native ? e.net : 0n), P, "amount", `swaps ${s.swapTokenAmount} of ${s.swapToken} (value ${call.value}), not ${e.net} ${e.from.symbol}`);
  must(same(s.spokePool, PINNED.acrossSpokePool), P, "contract", `deposits into ${s.spokePool}, not the pinned SpokePool (the periphery would approve it for the swapped tokens)`);
  must(same(d.depositor, e.escrow), P, "refund", `an unfilled deposit would refund ${d.depositor}, not the escrow`);
  must(same(d.outputToken, bytes32Of(e.to.chain, outToken)), P, "asset", `delivers ${d.outputToken}, not ${e.to.symbol}`);
  must(s.submissionFees.amount === 0n && s.nonce === 0n, P, "fee", "a submission fee or a signed-deposit nonce is set");
  must(s.minExpectedInputTokenAmount > 0n && d.outputAmount > 0n, P, "minimum", "a zero minimum");
  must(d.fillDeadline > now, P, "deadline", "the fill deadline has passed");
  mustShortExclusivity(P, d.exclusiveRelayer, d.exclusivityParameter, now);
  must(reshieldable(e, d.inputToken), P, "refund", `swaps into ${d.inputToken} before bridging: an unfilled deposit would come back to the escrow in a token it cannot re-shield`);
  // the swap's own floor backs the deposit (audit 2026-10-16): the exchange and its calldata stay opaque, and the periphery deposits
  // whatever the swap returned against outputAmount. So the swapped-into token must be the asset delivered (sameAsset), and
  // minExpectedInputTokenAmount must cover outputAmount in its units: a swap below it reverts the call, and a deposit nobody fills
  // refunds the escrow at least the output's worth. Otherwise the exchange could keep the order and return one unit
  const bridged = reshieldableAsset(e, d.inputToken);
  must(!!bridged && sameAsset(bridged.symbol, e.to.symbol), P, "asset", `bridges ${d.inputToken} for ${e.to.symbol}: the swap's floor must be counted in the asset delivered, or an unfilled deposit refunds less than the output is worth`);
  must(covers(s.minExpectedInputTokenAmount, bridged.decimals, d.outputAmount, e.to.decimals), P, "minimum", `the swap's own floor ${s.minExpectedInputTokenAmount} does not cover the deposit's output ${d.outputAmount}: the exchange could keep the order`);
  if (d.message === "0x") {
    must(same(d.recipient, bytes32Of(e.to.chain, e.destination)), P, "receiver", "the deposit pays another address than your fresh one");
  } else {
    const handler = ACROSS_DESTINATION.handler[e.to.chain], emitter = ACROSS_DESTINATION.emitter[e.to.chain];
    must(!!handler && same(d.recipient, bytes32Of(e.to.chain, handler)), P, "receiver", "the deposit pays neither your fresh address nor the pinned Across handler");
    let ins: { calls: readonly { target: Address; callData: Hex; value: bigint }[]; fallbackRecipient: Address };
    try { [ins] = decodeAbiParameters(HANDLER_MESSAGE, d.message) as any; } catch { throw new ProviderCallMismatch(P, "message", "the handler message is unreadable"); }
    must(same(ins.fallbackRecipient, ZERO) || same(ins.fallbackRecipient, e.destination), P, "receiver", `the handler's fallback recipient ${ins.fallbackRecipient} is not your fresh address`);
    // native out: the handler unwraps its own WETH, then a drain of native ETH to the fresh address follows the unwrap
    let drained = !nativeOut && same(ins.fallbackRecipient, e.destination);
    let unwrapped = false;
    for (const c of ins.calls) {
      must(c.value === 0n, P, "message", "a destination call forwards value");
      let fn: { functionName: string; args: readonly any[] } | null = null;
      try { fn = decodeFunctionData({ abi: HANDLER_ABI, data: c.callData }) as any; } catch { fn = null; }
      if (fn?.functionName === "drainLeftoverTokens" && same(c.target, handler)) {
        const token = fn.args[0] as Address;
        // native out: the WETH is drained only after the unwrap, its leftover (the eleventh review round, D11-8) — a drain of the WETH before the
        // unwrap had handed the fill over as WETH, the unwrap and the ETH drain then moving nothing, while the facts said "the ETH"
        must((same(token, outToken) || (nativeOut && same(token, ZERO))) && same(fn.args[1], e.destination), P, "receiver", "the handler would drain another token, or to another address than your fresh one");
        must(!(nativeOut && same(token, outToken) && !unwrapped), P, "receiver", "the handler would hand over the WETH before unwrapping it, where the ETH you asked for goes to your fresh address");
        if (nativeOut ? same(token, ZERO) && unwrapped : true) drained = true;
      } else if (nativeOut && fn?.functionName === "makeCallWithBalance" && same(c.target, handler)) {
        const [target, inner, value, reps] = fn.args as [Address, Hex, bigint, readonly { token: Address; offset: bigint }[]];
        let w: { functionName: string; args: readonly any[] } | null = null;
        try { w = decodeFunctionData({ abi: WETH_ABI, data: inner }) as any; } catch { w = null; }
        must(same(target, outToken) && value === 0n && w?.functionName === "withdraw" && w.args[0] === 0n && inner.length === 2 + 72 && reps.length === 1 && same(reps[0].token, outToken) && reps[0].offset === 4n, P, "message", "a balance call on the destination that is not the handler unwrapping its own WETH");
        unwrapped = true;
      } else {
        must(!!emitter && fn?.functionName === "emitData" && same(c.target, emitter), P, "message", `the destination message calls ${c.target} (${c.callData.slice(0, 10)})`);
      }
    }
    must(drained, P, "receiver", nativeOut ? "no drain of native ETH to your fresh address after the unwrap (the handler would keep it)" : "nothing hands the output token to your fresh address (the handler would keep it)");
  }
  const refundTokens = ownAsset(e, d.inputToken) ? undefined : [getAddress(d.inputToken)];
  const refundFloors = floorOf(refundTokens, s.minExpectedInputTokenAmount, 100n); // an unfilled deposit returns at least this
  return {
    provider: P, receiver: e.destination, minOut: d.outputAmount, refundTo: "escrow", ...(refundTokens ? { refundTokens, refundFloors } : {}),
    facts: ["Across periphery and SpokePool pinned; swapAndBridge decoded", d.message === "0x" ? "pays your fresh address" : nativeOut ? "pays the pinned Across handler, which unwraps the WETH and sends the ETH to your fresh address" : "pays the pinned Across handler, which hands the output token to your fresh address", "minimum = the deposit's output amount, covered by the swap's own floor", refundFact(e, refundTokens)],
  };
}

function across(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "across";
  const { args } = decode(P, ACROSS_ABI, call.calldata);
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, , fillDeadline, exclusivityDeadline, message] = args as [Address, Address, Address, Address, bigint, bigint, bigint, Address, number, number, number, Hex];
  must(EVM_CHAIN_ID[e.to.chain] !== undefined, P, "destination", `Across bridges between EVM chains, not to ${e.to.chain}`);
  must(destinationChainId === BigInt(EVM_CHAIN_ID[e.to.chain]), P, "chain", `bridges to chain ${destinationChainId}, not ${e.to.chain}`);
  must(same(recipient, e.destination), P, "receiver", `pays ${recipient}, not your fresh address`);
  must(same(depositor, e.escrow), P, "refund", `an unfilled deposit would refund ${depositor}, not the escrow`);
  must(same(inputToken, e.from.asset === "native" ? WETH.ethereum : e.from.asset), P, "asset", `spends ${inputToken}, not ${e.from.symbol}`);
  const wantOut = e.to.asset === "native" ? WETH[e.to.chain] : e.to.asset;
  must(!!wantOut && same(outputToken, wantOut), P, "asset", `delivers ${outputToken}, not ${e.to.symbol}`);
  must(inputAmount === e.net && call.value === (e.from.asset === "native" ? e.net : 0n), P, "amount", `${inputAmount} (value ${call.value}) != ${e.net}`);
  must(message === "0x", P, "message", "a destination call is attached");
  must(fillDeadline > now, P, "deadline", "the fill deadline has passed");
  mustShortExclusivity(P, exclusiveRelayer, exclusivityDeadline, now);
  return { provider: P, receiver: recipient, minOut: outputAmount, refundTo: "escrow", facts: ["SpokePool pinned", "pays your fresh address", "exact fill amount, an unfilled deposit refunds the escrow"] };
}

/** The least USDC (base units) an ETH → USDC leg may be bounded at: the ETH at the agreed prices, less MAYAN_MIDDLE_MAX_SHORTFALL_BPS. */
export function middleFloorUsdc(ethWei: bigint, ethUsd1e8: bigint, usdcUsd1e8: bigint = 10n ** 8n): bigint {
  const expected = (ethWei * ethUsd1e8 * 10n ** 6n) / (10n ** 18n * usdcUsd1e8);
  return (expected * (10_000n - MAYAN_MIDDLE_MAX_SHORTFALL_BPS)) / 10_000n;
}

/** A swap-first leg (ETH → USDC by a router the provider names): in USDC, and bounded at the floor this wallet's own price gives. */
function mustBoundMiddle(e: CallExpectation, P: ProviderName, swap: { middleToken: Address; minMiddle: bigint }, ethWei: bigint): void {
  must(same(swap.middleToken, USDC_ETHEREUM) && swap.minMiddle > 0n, P, "swap", "the ETH → USDC leg is not bounded in USDC");
  const ethUsd = e.usd?.ETH;
  // a check that cannot be made is an outage, never a refusal (the eleventh review round, after its critique): the delayed funding's check stops
  // an order for good on a refusal, and a price read that failed had abandoned it
  if (ethUsd === undefined || ethUsd <= 0n) throw new ProviderCallUnverified(P, "the ETH → USDC leg cannot be bounded: this wallet has no fresh agreed ETH price (its price feeds are unavailable or stale), so the floor a router must meet cannot be checked yet");
  const floor = middleFloorUsdc(ethWei, ethUsd, e.usd?.USDC);
  must(swap.minMiddle >= floor, P, "swap", `the ETH → USDC leg is bounded at ${swap.minMiddle} USDC base units, below ${floor} — ${(10_000n - MAYAN_MIDDLE_MAX_SHORTFALL_BPS) / 100n} % of the ${ethWei} wei at this wallet's own price; a router could keep the difference`);
}
/**
 * A source swap's on-chain floor against what the escrow forwards, at this wallet's own prices (the eleventh review round, 2026-11-04, the
 * verifier's NF-1): LI.FI's swap-then-Mayan entry enforces only the swap's output ≥ BridgeData.minAmount and hands Mayan exactly that, and the
 * minimum read from the Mayan order binds only a fill — a minAmount of one unit let the swap keep the order. A dollar stablecoin without a
 * feed counts at $1, as the ETH → USDC leg's floor does.
 */
function mustBoundSourceSwap(e: CallExpectation, P: ProviderName, bridged: Address, minAmount: bigint): void {
  const into = reshieldableAsset(e, bridged);
  must(!!into, P, "swap", `swaps into ${bridged}, whose value this wallet does not know: the swap's floor cannot be checked`);
  const usdOf = (symbol: string): bigint | undefined => {
    const s = /^w?eth$/i.test(symbol) ? "ETH" : symbol.toUpperCase();
    return e.usd?.[s] ?? (/^usd[ct]$/i.test(s) ? 10n ** 8n : undefined);
  };
  // into the same asset (LI.FI's fee collection, ETH → ETH; one dollar stablecoin into another) no price is needed: one unit is one unit
  const fromSymbol = e.from.asset === "native" ? "ETH" : e.from.symbol;
  const alike = sameAsset(fromSymbol, into!.symbol);
  const fromUsd = alike ? 1n : usdOf(fromSymbol);
  const intoUsd = alike ? 1n : usdOf(into!.symbol);
  if (fromUsd === undefined || fromUsd <= 0n || intoUsd === undefined || intoUsd <= 0n)
    throw new ProviderCallUnverified(P, "the swap before the bridge cannot be bounded: this wallet has no fresh agreed price for one of its two assets, so the floor a router must meet cannot be checked yet");
  const expected = (e.net * fromUsd! * 10n ** BigInt(into!.decimals)) / (10n ** BigInt(e.from.decimals) * intoUsd!);
  const floor = (expected * (10_000n - MAYAN_MIDDLE_MAX_SHORTFALL_BPS)) / 10_000n;
  must(minAmount >= floor, P, "swap", `the swap before the bridge is bounded at ${minAmount} ${into!.symbol} base units, below ${floor} — ${(10_000n - MAYAN_MIDDLE_MAX_SHORTFALL_BPS) / 100n} % of the order at this wallet's own price; a router could keep the difference`);
}
const MIDDLE_FACT = `within ${(10_000n - MAYAN_MIDDLE_MAX_SHORTFALL_BPS) / 100n === 98n ? "2" : String(MAYAN_MIDDLE_MAX_SHORTFALL_BPS / 100n)} % of the ETH at this wallet's own price`;

/**
 * A Mayan SWIFT order (Swift V2): decoded in full. ETH must be wrapped 1:1 by the pinned wrapper (wrap(), the whole amount
 * bounded in WETH) and locked as "wrap & lock" (tokenIn 0), so a refund pays ETH; an ERC-20 locks itself. The trader, where an
 * unfilled order is refunded after its deadline, must be the escrow; the order must pay the fresh address on the asked chain
 * in the asked asset, with no gas drop, no referrer, cancel + refund fees within 1% and a deadline within 6 h.
 */
function mayanSwift(e: CallExpectation, now: number, swap: { protocol: Address; data: Hex; middleToken: Address; minMiddle: bigint } | null, data: Hex): CheckedCall {
  const P: ProviderName = "mayan";
  const native = e.from.asset === "native";
  // an ETH order is wrapped 1:1 by the pinned wrapper (wrap & lock, refunded as ETH) or — Mayan's routing for a small order — swapped into
  // USDC by a router Mayan names, bounded on chain by minMiddle, and the USDC locked (swap & lock, refunded as USDC to the escrow: the pool must
  // have a USDC vault, PP-S08); the forwarder overwrites the order's amountIn with the USDC the router produced (verified source)
  let swapAndLock = false;
  if (native) {
    must(!!swap, P, "swap", "an ETH order is neither wrapped nor swapped first");
    if (same(swap!.protocol, PINNED.mayanEthWrapper)) {
      must(swap!.data.toLowerCase() === SEL_WRAP, P, "swap", "the ETH is not wrapped by the pinned wrapper's wrap()");
      must(same(swap!.middleToken, WETH.ethereum) && swap!.minMiddle === e.net, P, "swap", "the wrap is not bounded to the whole amount in WETH");
    } else {
      mustBoundMiddle(e, P, swap!, e.net);
      must(reshieldable(e, USDC_ETHEREUM), P, "refund", "swaps the ETH into USDC first: an unfilled order would refund USDC to the escrow, which cannot re-shield it (no USDC vault)");
      swapAndLock = true;
    }
  } else must(!swap, P, "swap", "an ERC-20 order swaps first");
  const { args } = decode(P, SWIFT_V2_ABI, data);
  const [tokenIn, amountIn, o, customPayload] = args as [Address, bigint, { payloadType: number; trader: Hex; destAddr: Hex; destChainId: number; referrerAddr: Hex; tokenOut: Hex; minAmountOut: bigint; gasDrop: bigint; cancelFee: bigint; refundFee: bigint; deadline: bigint; referrerBps: number; auctionMode: number }, Hex];
  must(native ? (swapAndLock ? same(tokenIn, USDC_ETHEREUM) : same(tokenIn, ZERO)) : same(tokenIn, e.from.asset), P, "order", native ? (swapAndLock ? "the swapped USDC is not what the order locks" : "the ETH is not locked as wrap & lock: a refund would not pay ETH") : `locks ${tokenIn}, not ${e.from.symbol}`);
  must(swapAndLock ? amountIn === swap!.minMiddle : amountIn === e.net, P, "order", swapAndLock ? `orders ${amountIn} USDC, not the ${swap!.minMiddle} the leg is bounded at` : `orders ${amountIn}, not ${e.net}`);
  must(o.payloadType === 1 && customPayload === "0x", P, "order", "carries a custom payload");
  must(same(o.trader, bytes32Of("ethereum", e.escrow)), P, "refund", "an unfilled order would be refunded to another address than the escrow");
  must(WORMHOLE_CHAIN[e.to.chain] !== undefined && o.destChainId === WORMHOLE_CHAIN[e.to.chain], P, "chain", `delivers to Wormhole chain ${o.destChainId}, not ${e.to.chain}`);
  must(same(o.destAddr, bytes32Of(e.to.chain, e.destination)), P, "receiver", "the order pays another address than your fresh one");
  const wantTokenOut = e.to.asset === "native" ? padHex("0x", { size: 32 }) : bytes32Of(e.to.chain, e.to.asset);
  must(same(o.tokenOut, wantTokenOut), P, "asset", `delivers ${o.tokenOut}, not ${e.to.symbol}`);
  must(o.gasDrop === 0n, P, "order", "asks for a gas drop");
  must(BigInt(o.referrerAddr) === 0n && o.referrerBps === 0, P, "fees", "carries a referrer fee");
  // Swift amounts carry at most 8 decimals; a swap & lock order is in USDC (6 decimals), at least the bounded minMiddle of it
  const inDecimals = swapAndLock ? 6 : native ? 18 : e.from.decimals;
  const orderIn = swapAndLock ? swap!.minMiddle : e.net;
  const normalizedIn = inDecimals > 8 ? orderIn / 10n ** BigInt(inDecimals - 8) : orderIn;
  must((o.cancelFee + o.refundFee) * 10000n <= normalizedIn * SWIFT_MAX_REFUND_FEES_BPS, P, "fees", "the cancel and refund fees exceed 1% of the order");
  must(o.deadline > BigInt(now) && o.deadline <= BigInt(now + SWIFT_MAX_DEADLINE_SECONDS), P, "deadline", "the order deadline has passed or lies more than 6 h ahead");
  must(o.auctionMode > 0, P, "order", "no auction mode");
  const minOut = e.to.decimals > 8 ? o.minAmountOut * 10n ** BigInt(e.to.decimals - 8) : o.minAmountOut;
  must(minOut > 0n, P, "minimum", "a zero minimum");
  const refundTokens = swapAndLock ? [USDC_ETHEREUM] : undefined;
  return {
    provider: P, receiver: e.destination, minOut, refundTo: "escrow", ...(refundTokens ? { refundTokens, refundFloors: floorOf(refundTokens, swap!.minMiddle, 100n) } : {}),
    facts: ["forwarder and Swift V2 pinned; the order is decoded", native ? (swapAndLock ? `the ETH is swapped into USDC by a router Mayan names, bounded on chain at ${swap!.minMiddle} USDC base units, ${MIDDLE_FACT}` : "the ETH is wrapped 1:1 by the pinned wrapper") : `${e.from.symbol} is locked as is`, "the order pays your fresh address", swapAndLock ? "an unfilled order is cancelled after its deadline and refunds USDC to the escrow, re-shielded into its vault" : "an unfilled order is cancelled after its deadline and refunded to the escrow"],
  };
}

function mayan(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "mayan";
  const { functionName, args } = decode(P, MAYAN_FORWARDER_ABI, call.calldata);
  let mayanProtocol: Address, protocolData: Hex;
  let swap: { protocol: Address; data: Hex; middleToken: Address; minMiddle: bigint } | null = null;
  if (functionName === "swapAndForwardEth") {
    const [amountIn, swapProtocol, swapData, middleToken, minMiddleAmount, protocol, data] = args as [bigint, Address, Hex, Address, bigint, Address, Hex];
    must(e.from.asset === "native" && amountIn === e.net && call.value === e.net, P, "amount", `${amountIn} (value ${call.value}) != ${e.net}`);
    swap = { protocol: swapProtocol, data: swapData, middleToken, minMiddle: minMiddleAmount };
    mayanProtocol = protocol; protocolData = data;
  } else {
    const [tokenIn, amountIn, permit, protocol, data] = args as [Address, bigint, { value: bigint; deadline: bigint }, Address, Hex];
    must(e.from.asset !== "native" && same(tokenIn, e.from.asset) && amountIn === e.net && call.value === 0n, P, "amount", `${amountIn} of ${tokenIn} != ${e.net} ${e.from.symbol}`);
    must(permit.value === 0n && permit.deadline === 0n, P, "permit", "carries a permit (the escrow approves instead)");
    mayanProtocol = protocol; protocolData = data;
  }
  if (same(mayanProtocol, PINNED.mayanSwiftV2)) return mayanSwift(e, now, swap, protocolData);
  if (swap) mustBoundMiddle(e, P, swap, e.net);
  must(same(mayanProtocol, PINNED.mayanFastMctp), P, "protocol", `hands the order to ${mayanProtocol}, not the pinned Fast-MCTP or Swift contract`);
  const order = decode(P, FAST_MCTP_ABI, protocolData);
  const [tokenIn, amountIn, circleMaxFee, destDomain, , payload] = order.args as [Address, bigint, bigint, number, number, { payloadType: number; destAddr: Hex; tokenOut: Hex; amountOutMin: bigint; gasDrop: bigint; redeemFee: bigint; refundFee: bigint; deadline: bigint; referrerAddr: Hex; referrerBps: number }];
  must(same(tokenIn, USDC_ETHEREUM), P, "order", "the order is not funded in USDC");
  // MayanForwarder (verified source, Sourcify): swapAndForwardEth overwrites the order's amountIn with the
  // USDC its whitelisted router produced (replaceMiddleAmount); forwardERC20 passes the order through as
  // is after pulling amountIn, so there the two must match or the difference stays in the forwarder
  if (e.from.asset !== "native") must(amountIn === e.net, P, "order", `orders ${amountIn}, not ${e.net}`);
  must(CCTP_DOMAIN[e.to.chain] !== undefined && destDomain === CCTP_DOMAIN[e.to.chain], P, "chain", `delivers to CCTP domain ${destDomain}, not ${e.to.chain}`);
  must(payload.payloadType === 3, P, "order", `payload type ${payload.payloadType}`);
  must(same(payload.destAddr, bytes32Of(e.to.chain, e.destination)), P, "receiver", "the order pays another address than your fresh one");
  const wantTokenOut = e.to.asset === "native" ? padHex("0x", { size: 32 }) : bytes32Of(e.to.chain, e.to.asset);
  must(same(payload.tokenOut, wantTokenOut), P, "asset", `delivers ${payload.tokenOut}, not ${e.to.symbol}`);
  must(BigInt(payload.referrerAddr) === 0n && payload.referrerBps === 0, P, "fees", "carries a referrer fee");
  must(payload.deadline > BigInt(now), P, "deadline", "the order deadline has passed");
  // bounded as a SWIFT order's are (audit 2026-10-16): Mayan's verified FastMCTP pays refundFee to whoever calls refund (for a USDC
  // output that is how the order delivers), takes redeemFee at the destination, and holds an unfilled order's USDC until its deadline
  must(payload.deadline <= BigInt(now + SWIFT_MAX_DEADLINE_SECONDS), P, "deadline", `the order deadline is more than ${SWIFT_MAX_DEADLINE_SECONDS / 3600} h away (an unfilled order's USDC would wait for it)`);
  must(payload.gasDrop === 0n, P, "fees", "a gas drop was not asked for (a solver pays it out of the order)");
  // the USDC the order carries: its own amount, or for ETH the swap's floor (the forwarder overwrites amountIn with what the router produced)
  const usdc = swap ? swap.minMiddle : amountIn;
  const feeCap = (usdc * FAST_MCTP_MAX_FEES_BPS) / 10_000n > FAST_MCTP_MIN_FEE_CAP ? (usdc * FAST_MCTP_MAX_FEES_BPS) / 10_000n : FAST_MCTP_MIN_FEE_CAP;
  must(payload.redeemFee + payload.refundFee <= feeCap, P, "fees", `redeem + refund fees ${payload.redeemFee + payload.refundFee} are above ${feeCap} USDC base units (1 % of the order, or 2 USDC)`);
  must(circleMaxFee * 10_000n <= usdc * FAST_MCTP_MAX_FEES_BPS, P, "fees", `Circle's maximum fee ${circleMaxFee} is above 1 % of the order`);
  // amountOutMin carries min(8, decimals) decimals
  const minOut = e.to.decimals > 8 ? payload.amountOutMin * 10n ** BigInt(e.to.decimals - 8) : payload.amountOutMin;
  return {
    provider: P, receiver: e.destination, minOut, refundTo: "destination",
    facts: ["forwarder and Fast-MCTP pinned", ...(swap ? [`the ETH is swapped into USDC by a router Mayan names, bounded on chain at ${swap.minMiddle} USDC base units, ${MIDDLE_FACT}`] : []), "the order pays your fresh address", "an unfilled order refunds USDC to your fresh address, not to the pool"],
  };
}

/**
 * The Mayan order inside LI.FI's MayanFacet (the third review round, 2026-11-03): the facet hands `protocolData` to `mayanProtocol`
 * as is, so the trader a cancelled Swift order refunds, the receiver, the asset and the minimum are read as a direct Mayan call's
 * are — before, only the facet's own sweep recipient was, and a service could name itself the trader of an order it then let
 * lapse. A swap leg inside (ETH → USDC) is bounded as the direct call's is. Gives the route a minimum this wallet can read.
 */
function lifiMayanOrder(
  e: CallExpectation,
  now: number,
  m: { mayanProtocol: Address; protocolData: Hex; swapProtocol: Address; middleToken: Address; minMiddleAmount: bigint; mayanAmountIn: bigint },
  bd: { sendingAssetId: Address; minAmount: bigint },
): { minOut: bigint; refundTo: "escrow" | "destination"; fact: string; refundTokens?: Address[]; refundFloors?: Record<string, string> } {
  const P: ProviderName = "lifi";
  const bridged = getAddress(bd.sendingAssetId);
  const leg = BigInt(m.swapProtocol) !== 0n || BigInt(m.middleToken) !== 0n || m.minMiddleAmount !== 0n;
  if (leg) {
    must(same(bridged, ZERO), P, "swap", "a swap leg inside Mayan on a token the facet already bridges");
    // bounded on what the facet forwards (the eleventh review round, D11-3): the bridge-only entry never reads mayanAmountIn — LI.FI's
    // MayanFacet swaps the whole bridged ETH (`_bridgeData.minAmount`) under the leg's floor, so a floor read on mayanAmountIn of one wei was 0
    mustBoundMiddle(e, P, { middleToken: m.middleToken, minMiddle: m.minMiddleAmount }, bd.minAmount);
  }
  // what the order carries, for its fee bounds (the eleventh review round, D11-2): the leg's USDC floor, or the bridged token's amount — the
  // direct decoders bound the fees, the order inside LI.FI had not been, and an order nobody fills pays them out of itself
  const carriedDecimals = leg ? 6 : same(bridged, ZERO) ? 18 : reshieldableAsset(e, bridged)?.decimals;
  must(carriedDecimals !== undefined, P, "fees", `the order inside is funded in ${bridged}, whose decimals this wallet does not know: its fees cannot be bounded`);
  const carried = leg ? m.minMiddleAmount : bd.minAmount;
  const dest32 = bytes32Of(e.to.chain, e.destination);
  const wantTokenOut = e.to.asset === "native" ? padHex("0x", { size: 32 }) : bytes32Of(e.to.chain, e.to.asset);
  const scaled = (x: bigint) => (e.to.decimals > 8 ? x * 10n ** BigInt(e.to.decimals - 8) : x);
  if (same(m.mayanProtocol, PINNED.mayanSwiftV2)) {
    const { args } = decode(P, SWIFT_V2_ABI, m.protocolData);
    const [, , o, customPayload] = args as [Address, bigint, { payloadType: number; trader: Hex; destAddr: Hex; destChainId: number; referrerAddr: Hex; tokenOut: Hex; minAmountOut: bigint; gasDrop: bigint; cancelFee: bigint; refundFee: bigint; deadline: bigint; referrerBps: number; auctionMode: number }, Hex];
    must(o.payloadType === 1 && customPayload === "0x", P, "order", "the Mayan order carries a custom payload");
    must(same(o.trader, bytes32Of("ethereum", e.escrow)), P, "refund", "an unfilled Mayan order would be refunded to another address than the escrow");
    must(WORMHOLE_CHAIN[e.to.chain] !== undefined && o.destChainId === WORMHOLE_CHAIN[e.to.chain], P, "chain", `the Mayan order delivers to Wormhole chain ${o.destChainId}, not ${e.to.chain}`);
    must(same(o.destAddr, dest32), P, "receiver", "the Mayan order pays another address than your fresh one");
    must(same(o.tokenOut, wantTokenOut), P, "asset", `the Mayan order delivers ${o.tokenOut}, not ${e.to.symbol}`);
    must(o.gasDrop === 0n && BigInt(o.referrerAddr) === 0n && o.referrerBps === 0, P, "fees", "the Mayan order asks for a gas drop or carries a referrer fee");
    must(o.deadline > BigInt(now) && o.deadline <= BigInt(now + SWIFT_MAX_DEADLINE_SECONDS) && o.auctionMode > 0, P, "deadline", "the Mayan order's deadline has passed or lies more than 6 h ahead, or it has no auction mode");
    // Swift amounts carry at most 8 decimals: the fees within 1 % of what the order carries, as a direct Swift order's (D11-2)
    const normalizedIn = carriedDecimals! > 8 ? carried / 10n ** BigInt(carriedDecimals! - 8) : carried;
    must((o.cancelFee + o.refundFee) * 10000n <= normalizedIn * SWIFT_MAX_REFUND_FEES_BPS, P, "fees", "the Mayan order's cancel and refund fees exceed 1% of the order");
    const minOut = scaled(o.minAmountOut);
    must(minOut > 0n, P, "minimum", "the Mayan order binds a zero minimum");
    // swap & lock: an unfilled order refunds the USDC the leg produced to the escrow (the eleventh review round, D11-6) — the pool must have a
    // USDC vault, and the executor is told the token, as a direct swap & lock order's are
    if (leg) {
      must(reshieldable(e, USDC_ETHEREUM), P, "refund", "the ETH is swapped into USDC first: an unfilled order would refund USDC to the escrow, which cannot re-shield it (no USDC vault)");
      const refundTokens = [USDC_ETHEREUM];
      return { minOut, refundTo: "escrow", refundTokens, refundFloors: floorOf(refundTokens, m.minMiddleAmount, 100n), fact: "the Swift order inside is decoded, its fees within 1 %: it pays your fresh address; unfilled, it is cancelled after its deadline and refunds USDC to the escrow, re-shielded into its vault" };
    }
    return { minOut, refundTo: "escrow", fact: "the Swift order inside is decoded, its fees within 1 %: it pays your fresh address; unfilled, it is cancelled after its deadline and refunded to the escrow" };
  }
  must(same(m.mayanProtocol, PINNED.mayanFastMctp), P, "protocol", `hands the order to ${m.mayanProtocol}, not the pinned Fast-MCTP or Swift contract`);
  const order = decode(P, FAST_MCTP_ABI, m.protocolData);
  const [tokenIn, , circleMaxFee, destDomain, , payload] = order.args as [Address, bigint, bigint, number, number, { payloadType: number; destAddr: Hex; tokenOut: Hex; amountOutMin: bigint; gasDrop: bigint; redeemFee: bigint; refundFee: bigint; deadline: bigint; referrerAddr: Hex; referrerBps: number }];
  must(same(tokenIn, USDC_ETHEREUM), P, "order", "the Mayan order is not funded in USDC");
  // its fees as a direct Fast-MCTP order's (D11-2): redeem + refund within 1 % of the USDC it carries (or 2 USDC), Circle's within 1 %
  const usdc = carried;
  const feeCap = (usdc * FAST_MCTP_MAX_FEES_BPS) / 10_000n > FAST_MCTP_MIN_FEE_CAP ? (usdc * FAST_MCTP_MAX_FEES_BPS) / 10_000n : FAST_MCTP_MIN_FEE_CAP;
  must(payload.redeemFee + payload.refundFee <= feeCap, P, "fees", `the Mayan order's redeem + refund fees ${payload.redeemFee + payload.refundFee} are above ${feeCap} USDC base units (1 % of the order, or 2 USDC)`);
  must(circleMaxFee * 10_000n <= usdc * FAST_MCTP_MAX_FEES_BPS, P, "fees", `the Mayan order's Circle maximum fee ${circleMaxFee} is above 1 % of the order`);
  must(CCTP_DOMAIN[e.to.chain] !== undefined && destDomain === CCTP_DOMAIN[e.to.chain], P, "chain", `the Mayan order delivers to CCTP domain ${destDomain}, not ${e.to.chain}`);
  must(payload.payloadType === 3, P, "order", `the Mayan order's payload type ${payload.payloadType}`);
  must(same(payload.destAddr, dest32), P, "receiver", "the Mayan order pays another address than your fresh one");
  must(same(payload.tokenOut, wantTokenOut), P, "asset", `the Mayan order delivers ${payload.tokenOut}, not ${e.to.symbol}`);
  must(payload.gasDrop === 0n && BigInt(payload.referrerAddr) === 0n && payload.referrerBps === 0, P, "fees", "the Mayan order asks for a gas drop or carries a referrer fee");
  must(payload.deadline > BigInt(now) && payload.deadline <= BigInt(now + SWIFT_MAX_DEADLINE_SECONDS), P, "deadline", "the Mayan order's deadline has passed or lies more than 6 h ahead");
  const minOut = scaled(payload.amountOutMin);
  must(minOut > 0n, P, "minimum", "the Mayan order binds a zero minimum");
  return { minOut, refundTo: "destination", fact: "the Fast-MCTP order inside is decoded, its fees bounded: it pays your fresh address; unfilled, it refunds USDC to your fresh address" };
}

function lifi(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "lifi";
  const { functionName, args } = decode(P, LIFI_ABI, call.calldata);
  const bd = args[0] as { sendingAssetId: Address; receiver: Address; minAmount: bigint; destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean };
  const swaps = (bd.hasSourceSwaps ? args[1] : []) as { sendingAssetId: Address; fromAmount: bigint }[];
  const facet = args[args.length - 1] as any;
  must(bd.hasSourceSwaps === functionName.startsWith("swapAnd"), P, "call", "BridgeData.hasSourceSwaps disagrees with the entry point");
  must(LIFI_CHAIN_ID[e.to.chain] !== undefined && bd.destinationChainId === LIFI_CHAIN_ID[e.to.chain], P, "chain", `bridges to ${bd.destinationChainId}, not ${e.to.chain}`);
  must(!bd.hasDestinationCall, P, "receiver", "a destination call is attached (the bridge would pay a contract, not your fresh address)");
  const ours = e.from.asset === "native" ? ZERO : getAddress(e.from.asset);
  if (bd.hasSourceSwaps) must(swaps.length > 0 && same(swaps[0].sendingAssetId, ours) && swaps[0].fromAmount === e.net, P, "amount", `the first swap spends ${swaps[0]?.fromAmount} of ${swaps[0]?.sendingAssetId}, not ${e.net} ${e.from.symbol}`);
  // exactly what the escrow forwards (the third review round, 2026-11-03): a smaller minAmount left the rest in the escrow, below the
  // floors that re-shield or offer it back — LI.FI's quotes bridge the whole amount
  else must(same(bd.sendingAssetId, ours) && bd.minAmount === e.net, P, "amount", `bridges ${bd.minAmount} of ${bd.sendingAssetId}, not the ${e.net} ${e.from.symbol} the escrow forwards`);
  must(call.value === (e.from.asset === "native" ? e.net : 0n), P, "value", `${call.value} forwarded`);
  // what comes back to the escrow is the bridged token: an unfilled Across deposit refunds it, the Mayan facet sweeps
  // the swap surplus in it; a source swap into a token the escrow cannot re-shield would strand it there (PP-S08)
  if (bd.hasSourceSwaps) must(reshieldable(e, bd.sendingAssetId), P, "refund", `swaps into ${bd.sendingAssetId} before bridging: an unfilled deposit or the swap surplus would come back to the escrow in a token it cannot re-shield`);
  const refundTokens = bd.hasSourceSwaps && !ownAsset(e, bd.sendingAssetId) ? [getAddress(bd.sendingAssetId)] : undefined;
  // Across returns an unfilled deposit whole (at least minAmount); the Mayan facet sweeps only the swap surplus above it
  const refundFloors = floorOf(refundTokens, bd.minAmount, functionName.endsWith("AcrossV4") ? 100n : 1000n);
  const evmDest = EVM_CHAIN_ID[e.to.chain] !== undefined;
  if (evmDest) must(same(bd.receiver, e.destination), P, "receiver", `pays ${bd.receiver}, not your fresh address`);
  else must(same(bd.receiver, LIFI_NON_EVM_RECEIVER), P, "receiver", "a non-EVM destination without LI.FI's non-EVM marker");
  const destination32 = bytes32Of(e.to.chain, e.destination);

  if (functionName.endsWith("AcrossV4")) {
    const a = facet as { receiverAddress: Hex; refundAddress: Hex; sendingAssetId: Hex; receivingAssetId: Hex; outputAmount: bigint; outputAmountMultiplier: bigint; exclusiveRelayer: Hex; exclusivityParameter: number; message: Hex };
    must(same(a.receiverAddress, destination32), P, "receiver", "Across would pay another address than your fresh one");
    must(same(a.refundAddress, bytes32Of("ethereum", e.escrow)), P, "refund", "an unfilled Across deposit would refund another address than the escrow");
    if (!same(bd.sendingAssetId, ZERO)) must(same(a.sendingAssetId, bytes32Of("ethereum", bd.sendingAssetId)), P, "asset", "Across would be told to pull another token than the one bridged");
    const wantOut = e.to.asset === "native" ? WETH[e.to.chain] : e.to.asset;
    must(!!wantOut && same(a.receivingAssetId, bytes32Of(e.to.chain, wantOut)), P, "asset", `delivers ${a.receivingAssetId}, not ${e.to.symbol}`);
    must(a.message === "0x", P, "message", "a destination message is attached");
    mustShortExclusivity(P, a.exclusiveRelayer, a.exclusivityParameter, now);
    // the swap variant overwrites outputAmount on chain: (swap result, >= minAmount) × multiplier / 1e18
    const minOut = bd.hasSourceSwaps ? (bd.minAmount * a.outputAmountMultiplier) / ACROSS_MULTIPLIER_BASE : a.outputAmount;
    if (bd.hasSourceSwaps) must(a.outputAmount === minOut, P, "minimum", "outputAmount disagrees with minAmount × outputAmountMultiplier");
    // the facet never asks Across for more than it bridges (audit 2026-10-16): the bridged token must be the asset delivered
    // (sameAsset), and in its units the multiplier is at most one (the swap variant: whatever the swap returns, at
    // least minAmount, the facet asks for no more of it) and outputAmount at most minAmount (the bridge alone). The minimum is then
    // backed by minAmount, the source swap's floor on chain, and a deposit nobody fills refunds the escrow at least it. Otherwise a
    // minAmount of one unit under an inflated multiplier would read as any minimum while the source swap kept the order
    const bridged = reshieldableAsset(e, bd.sendingAssetId);
    must(!!bridged && sameAsset(bridged.symbol, e.to.symbol), P, "asset", `bridges ${bd.sendingAssetId} for ${e.to.symbol}: the floor must be counted in the asset delivered, or an unfilled deposit refunds less than the output is worth`);
    if (bd.hasSourceSwaps) must(a.outputAmountMultiplier * 10n ** BigInt(bridged.decimals) <= ACROSS_MULTIPLIER_BASE * 10n ** BigInt(e.to.decimals), P, "minimum", `the output multiplier ${a.outputAmountMultiplier} asks Across for more than the swap bridges: the minimum would not be backed by minAmount, the swap's floor`);
    else must(covers(bd.minAmount, bridged.decimals, a.outputAmount, e.to.decimals), P, "minimum", `asks Across for ${a.outputAmount}, more than the ${bd.minAmount} it bridges`);
    return { provider: P, receiver: e.destination, minOut, refundTo: "escrow", ...(refundTokens ? { refundTokens, refundFloors } : {}), facts: ["LI.FI diamond pinned; Across facet decoded", "pays your fresh address", refundFact(e, refundTokens), bd.hasSourceSwaps ? "minimum = bridged amount × LI.FI's output multiplier (what the facet hands Across), backed by the swap's floor" : "exact fill amount, within what is bridged"] };
  }
  // MayanFacet: the facet checks the receiver against Mayan's order on chain; it sweeps excess value
  // and, in the swap variant, everything above mayanAmountIn to refundRecipient
  const m = facet as { nonEVMReceiver: Hex; mayanProtocol: Address; protocolData: Hex; swapProtocol: Address; swapData: Hex; middleToken: Address; minMiddleAmount: bigint; refundRecipient: Address; mayanAmountIn: bigint };
  if (!evmDest) must(same(m.nonEVMReceiver, destination32), P, "receiver", "Mayan would pay another address than your fresh one");
  must(same(m.refundRecipient, e.escrow), P, "refund", `excess value and swap surplus would go to ${m.refundRecipient}, not the escrow`);
  if (bd.hasSourceSwaps) must(m.mayanAmountIn === bd.minAmount, P, "amount", `hands Mayan ${m.mayanAmountIn} of the ${bd.minAmount} bridged; the rest would be swept away`);
  // the swap before the facet bounded at this wallet's own prices (NF-1): its minAmount is all the chain enforces of it
  if (bd.hasSourceSwaps) mustBoundSourceSwap(e, P, getAddress(bd.sendingAssetId), bd.minAmount);
  const inner = lifiMayanOrder(e, now, m, bd);
  // the tokens an unfilled order or the facet's sweep may pay back: the bridged token of a source swap, and an inner swap & lock order's USDC (D11-6)
  const tokens = [...(refundTokens ?? []), ...(inner.refundTokens ?? []).filter((t) => !(refundTokens ?? []).some((x) => same(x, t)))];
  const floors = { ...(refundFloors ?? {}), ...(inner.refundFloors ?? {}) };
  return { provider: P, receiver: e.destination, minOut: inner.minOut, refundTo: inner.refundTo, ...(tokens.length ? { refundTokens: tokens, refundFloors: floors } : {}), facts: ["LI.FI diamond pinned; Mayan facet decoded", "pays your fresh address", "excess value and swap surplus return to the escrow", inner.fact] };
}
