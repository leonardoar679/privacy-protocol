// Destination addresses (whale spec §21, plan V2 §58–§59): one parser per chain the wallet pays to, so
// a typed address is checked for its format before a quote is asked, refused with the chain's name when
// it belongs to another chain ("this looks like an Ethereum address; the destination is Bitcoin"), and
// shown grouped in fours on the destination card. Mainnet only: a testnet address is refused as such.
// Formats: EVM — 20 bytes hex, EIP-55 checked when mixed-case; Bitcoin — bech32 "bc1q" (witness v0,
// 20 or 32 bytes), bech32m "bc1p" (v1, 32 bytes), base58check P2PKH (0x00) and P2SH (0x05); Solana —
// base58, 32 bytes, not the system program.
import { base58, base58check, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes } from "@noble/hashes/utils";
import { eip55, type ChainKind } from "./chainKeys";

export const CHAIN_NAMES: Record<ChainKind, string> = { evm: "Ethereum", bitcoin: "Bitcoin", solana: "Solana" };
export type BitcoinFormat = "p2wpkh" | "p2wsh" | "p2tr" | "p2pkh" | "p2sh";
export type Format = "evm" | BitcoinFormat | "ed25519";

/**
 * What a refused destination tells the user, in their language (a V6 follow-up of 2026-10-16: the screens map each code to
 * its words; before, the English `reason` was dropped into every language's sentence). `reason` keeps the detail.
 */
export type DestinationCode =
  | "empty"
  | "evm_format"
  | "evm_checksum"
  | "btc_testnet"
  | "btc_invalid"
  | "sol_invalid"
  | "sol_system"
  | "other_chain"
  | "zero_address"
  | "burn_address"
  | "protocol_contract"
  | "token_contract"
  | "privacy_invalid"
  | "unknown_format";

export type ParsedDestination =
  | { ok: true; chain: ChainKind; /** the address as typed, trimmed */ address: string; /** the canonical form (EIP-55, lowercase bech32) */ normalized: string; format: Format }
  | {
      ok: false;
      chain: ChainKind;
      reason: string;
      code: DestinationCode;
      /** the chain whose format the text does match */ looksLike?: ChainKind;
      /** the token's symbol of a token_contract */ symbol?: string;
    };

const b58check = base58check(sha256);

export function parseEvm(text: string): ParsedDestination {
  const chain: ChainKind = "evm";
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return { ok: false, chain, reason: "an Ethereum address is 0x followed by 40 hex characters", code: "evm_format" };
  const hex = text.slice(2);
  const checksummed = eip55(hexToBytes(hex.toLowerCase()));
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && text !== checksummed) return { ok: false, chain, reason: "the checksum does not match: a character was mistyped", code: "evm_checksum" };
  return { ok: true, chain, address: text, normalized: checksummed, format: "evm" };
}

export function parseBitcoin(text: string): ParsedDestination {
  const chain: ChainKind = "bitcoin";
  const lower = text.toLowerCase();
  if (lower.startsWith("tb1") || /^[mn2]/.test(text)) return { ok: false, chain, reason: "a Bitcoin testnet address; the destination is Bitcoin mainnet", code: "btc_testnet" };
  if (lower.startsWith("bc1")) {
    if (text !== lower && text !== text.toUpperCase()) return { ok: false, chain, reason: "a bech32 address is all lowercase or all uppercase", code: "btc_invalid" };
    let words: number[];
    let encoding: "bech32" | "bech32m";
    try { words = [...bech32.decode(lower as `${string}1${string}`, 90).words]; encoding = "bech32"; }
    catch { try { words = [...bech32m.decode(lower as `${string}1${string}`, 90).words]; encoding = "bech32m"; } catch { return { ok: false, chain, reason: "not a valid bech32 address (checksum)", code: "btc_invalid" }; } }
    const version = words[0];
    const program = bech32.fromWords(words.slice(1));
    if (version === 0) {
      if (encoding !== "bech32") return { ok: false, chain, reason: "a witness v0 address uses bech32, not bech32m", code: "btc_invalid" };
      if (program.length === 20) return { ok: true, chain, address: text, normalized: lower, format: "p2wpkh" };
      if (program.length === 32) return { ok: true, chain, address: text, normalized: lower, format: "p2wsh" };
      return { ok: false, chain, reason: `a witness v0 program is 20 or 32 bytes, not ${program.length}`, code: "btc_invalid" };
    }
    if (version === 1) {
      if (encoding !== "bech32m") return { ok: false, chain, reason: "a taproot address uses bech32m, not bech32", code: "btc_invalid" };
      if (program.length === 32) return { ok: true, chain, address: text, normalized: lower, format: "p2tr" };
      return { ok: false, chain, reason: `a taproot program is 32 bytes, not ${program.length}`, code: "btc_invalid" };
    }
    return { ok: false, chain, reason: `witness version ${version} is not one this wallet pays to`, code: "btc_invalid" };
  }
  let payload: Uint8Array;
  try { payload = b58check.decode(text); } catch { return { ok: false, chain, reason: "not a valid Bitcoin address (base58check)", code: "btc_invalid" }; }
  if (payload.length !== 21) return { ok: false, chain, reason: "not a valid Bitcoin address (length)", code: "btc_invalid" };
  if (payload[0] === 0x00) return { ok: true, chain, address: text, normalized: text, format: "p2pkh" };
  if (payload[0] === 0x05) return { ok: true, chain, address: text, normalized: text, format: "p2sh" };
  if (payload[0] === 0x6f || payload[0] === 0xc4) return { ok: false, chain, reason: "a Bitcoin testnet address; the destination is Bitcoin mainnet", code: "btc_testnet" };
  return { ok: false, chain, reason: `version byte ${payload[0]} is not a Bitcoin address this wallet pays to`, code: "btc_invalid" };
}

export function parseSolana(text: string): ParsedDestination {
  const chain: ChainKind = "solana";
  let bytes: Uint8Array;
  try { bytes = base58.decode(text); } catch { return { ok: false, chain, reason: "not a valid Solana address (base58)", code: "sol_invalid" }; }
  if (bytes.length !== 32) return { ok: false, chain, reason: `a Solana address is 32 bytes, not ${bytes.length}`, code: "sol_invalid" };
  if (bytes.every((b) => b === 0)) return { ok: false, chain, reason: "the system program, not a wallet", code: "sol_system" };
  return { ok: true, chain, address: text, normalized: text, format: "ed25519" };
}

const PARSERS: Record<ChainKind, (text: string) => ParsedDestination> = { evm: parseEvm, bitcoin: parseBitcoin, solana: parseSolana };

/** The chain whose address format the text matches, if any (a text matches at most one: hex, base58check / bech32, 32-byte base58). */
export function looksLikeChain(text: string): ChainKind | null {
  for (const chain of ["evm", "bitcoin", "solana"] as ChainKind[]) if (PARSERS[chain](text.trim()).ok) return chain;
  return null;
}

/** The burn addresses: what is sent to them is lost (the zero address, and the conventional 0x…dEaD). */
export const BURN_ADDRESSES: readonly string[] = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];
/** An address of the wallet's own deployment (the pool, a vault, the router, a factory) or a token's own contract. */
export interface KnownAddress {
  address: string;
  kind: "protocol" | "token";
  symbol?: string;
}

/**
 * Why an EVM address must not receive a payment, or null (a V6 follow-up of 2026-10-16). The zero address and the burn
 * address lose what they receive; a contract of this wallet's own deployment and a token's own contract keep it, with no way
 * back. Such an address is well formed and passes every other check, so it is asked before a send or a swap goes to it.
 */
export function refusedRecipient(address: string, known: readonly KnownAddress[] = []): { code: DestinationCode; reason: string; symbol?: string } | null {
  const a = address.toLowerCase();
  if (a === BURN_ADDRESSES[0]) return { code: "zero_address", reason: "the zero address: what is sent to it is lost" };
  if (BURN_ADDRESSES.includes(a)) return { code: "burn_address", reason: "a burn address: what is sent to it is lost" };
  const k = known.find((x) => x.address.toLowerCase() === a);
  if (k?.kind === "token")
    return { code: "token_contract", reason: `the ${k.symbol ?? "token"} token's own contract: what is sent to it cannot come back`, ...(k.symbol ? { symbol: k.symbol } : {}) };
  if (k) return { code: "protocol_contract", reason: "a contract of this wallet's own protocol: what is sent to it cannot come back" };
  return null;
}

/**
 * Parse a typed destination for `chain`; a text that is another chain's address is refused with that chain's name (plan §59).
 * An EVM address is also refused when it would lose what it receives (`refusedRecipient`, with the deployment's `known` ones).
 */
export function parseDestination(chain: ChainKind, text: string, known: readonly KnownAddress[] = []): ParsedDestination {
  const t = text.trim();
  if (!t) return { ok: false, chain, reason: "enter an address", code: "empty" };
  const r = PARSERS[chain](t);
  if (r.ok) {
    const refused = chain === "evm" ? refusedRecipient(r.normalized, known) : null;
    return refused ? { ok: false, chain, ...refused } : r;
  }
  const other = looksLikeChain(t);
  if (other && other !== chain) return { ok: false, chain, reason: `this looks like a ${CHAIN_NAMES[other]} address; the destination is ${CHAIN_NAMES[chain]}`, code: "other_chain", looksLike: other };
  return r;
}

/** ERC-3770 short names of the EVM chains the registry knows, with their EIP-155 ids (packages/config CHAINS). */
export const EVM_SHORT_NAMES: Readonly<Record<string, number>> = { eth: 1, base: 8453, arb1: 42161, oeth: 10, sep: 11155111 };

/**
 * V6 (Privacy Wallet Web spec v2.0 §7.4; doc §25): an EVM address that names its chain — ERC-3770 `base:0x…` or an EIP-681
 * URI `ethereum:0x…@8453` — so a pasted address of another chain is noticed and the network never changes silently. A
 * bare `0x…` names no chain (null); an unknown short name gives `chainId: null` with the name as written.
 */
export function evmChainHint(text: string): { address: string; chainId: number | null; name: string } | null {
  const t = text.trim();
  const uri = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:[/?].*)?$/i.exec(t);
  if (uri) return { address: uri[1], chainId: uri[2] ? Number(uri[2]) : 1, name: uri[2] ? `chain ${uri[2]}` : "eth" };
  const prefixed = /^([a-z][a-z0-9-]{0,15}):(0x[0-9a-fA-F]{40})$/i.exec(t);
  if (!prefixed) return null;
  const name = prefixed[1].toLowerCase();
  return { address: prefixed[2], chainId: EVM_SHORT_NAMES[name] ?? null, name };
}

/** The address grouped in fours for reading aloud (plan §58): "0x9858 EfFD 232B …", "bc1q cr8t e4kr …". */
export function groupAddress(address: string, size = 4): string {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  const groups = body.match(new RegExp(`.{1,${size}}`, "g")) ?? [];
  return (address.startsWith("0x") ? "0x" : "") + groups.join(" ");
}
