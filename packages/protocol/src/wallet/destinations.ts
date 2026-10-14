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

export type ParsedDestination =
  | { ok: true; chain: ChainKind; /** the address as typed, trimmed */ address: string; /** the canonical form (EIP-55, lowercase bech32) */ normalized: string; format: Format }
  | { ok: false; chain: ChainKind; reason: string; /** the chain whose format the text does match */ looksLike?: ChainKind };

const b58check = base58check(sha256);

export function parseEvm(text: string): ParsedDestination {
  const chain: ChainKind = "evm";
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return { ok: false, chain, reason: "an Ethereum address is 0x followed by 40 hex characters" };
  const hex = text.slice(2);
  const checksummed = eip55(hexToBytes(hex.toLowerCase()));
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && text !== checksummed) return { ok: false, chain, reason: "the checksum does not match: a character was mistyped" };
  return { ok: true, chain, address: text, normalized: checksummed, format: "evm" };
}

export function parseBitcoin(text: string): ParsedDestination {
  const chain: ChainKind = "bitcoin";
  const lower = text.toLowerCase();
  if (lower.startsWith("tb1") || /^[mn2]/.test(text)) return { ok: false, chain, reason: "a Bitcoin testnet address; the destination is Bitcoin mainnet" };
  if (lower.startsWith("bc1")) {
    if (text !== lower && text !== text.toUpperCase()) return { ok: false, chain, reason: "a bech32 address is all lowercase or all uppercase" };
    let words: number[];
    let encoding: "bech32" | "bech32m";
    try { words = [...bech32.decode(lower as `${string}1${string}`, 90).words]; encoding = "bech32"; }
    catch { try { words = [...bech32m.decode(lower as `${string}1${string}`, 90).words]; encoding = "bech32m"; } catch { return { ok: false, chain, reason: "not a valid bech32 address (checksum)" }; } }
    const version = words[0];
    const program = bech32.fromWords(words.slice(1));
    if (version === 0) {
      if (encoding !== "bech32") return { ok: false, chain, reason: "a witness v0 address uses bech32, not bech32m" };
      if (program.length === 20) return { ok: true, chain, address: text, normalized: lower, format: "p2wpkh" };
      if (program.length === 32) return { ok: true, chain, address: text, normalized: lower, format: "p2wsh" };
      return { ok: false, chain, reason: `a witness v0 program is 20 or 32 bytes, not ${program.length}` };
    }
    if (version === 1) {
      if (encoding !== "bech32m") return { ok: false, chain, reason: "a taproot address uses bech32m, not bech32" };
      if (program.length === 32) return { ok: true, chain, address: text, normalized: lower, format: "p2tr" };
      return { ok: false, chain, reason: `a taproot program is 32 bytes, not ${program.length}` };
    }
    return { ok: false, chain, reason: `witness version ${version} is not one this wallet pays to` };
  }
  let payload: Uint8Array;
  try { payload = b58check.decode(text); } catch { return { ok: false, chain, reason: "not a valid Bitcoin address (base58check)" }; }
  if (payload.length !== 21) return { ok: false, chain, reason: "not a valid Bitcoin address (length)" };
  if (payload[0] === 0x00) return { ok: true, chain, address: text, normalized: text, format: "p2pkh" };
  if (payload[0] === 0x05) return { ok: true, chain, address: text, normalized: text, format: "p2sh" };
  if (payload[0] === 0x6f || payload[0] === 0xc4) return { ok: false, chain, reason: "a Bitcoin testnet address; the destination is Bitcoin mainnet" };
  return { ok: false, chain, reason: `version byte ${payload[0]} is not a Bitcoin address this wallet pays to` };
}

export function parseSolana(text: string): ParsedDestination {
  const chain: ChainKind = "solana";
  let bytes: Uint8Array;
  try { bytes = base58.decode(text); } catch { return { ok: false, chain, reason: "not a valid Solana address (base58)" }; }
  if (bytes.length !== 32) return { ok: false, chain, reason: `a Solana address is 32 bytes, not ${bytes.length}` };
  if (bytes.every((b) => b === 0)) return { ok: false, chain, reason: "the system program, not a wallet" };
  return { ok: true, chain, address: text, normalized: text, format: "ed25519" };
}

const PARSERS: Record<ChainKind, (text: string) => ParsedDestination> = { evm: parseEvm, bitcoin: parseBitcoin, solana: parseSolana };

/** The chain whose address format the text matches, if any (a text matches at most one: hex, base58check / bech32, 32-byte base58). */
export function looksLikeChain(text: string): ChainKind | null {
  for (const chain of ["evm", "bitcoin", "solana"] as ChainKind[]) if (PARSERS[chain](text.trim()).ok) return chain;
  return null;
}

/** Parse a typed destination for `chain`; a text that is another chain's address is refused with that chain's name (plan §59). */
export function parseDestination(chain: ChainKind, text: string): ParsedDestination {
  const t = text.trim();
  if (!t) return { ok: false, chain, reason: "enter an address" };
  const r = PARSERS[chain](t);
  if (r.ok) return r;
  const other = looksLikeChain(t);
  if (other && other !== chain) return { ok: false, chain, reason: `this looks like a ${CHAIN_NAMES[other]} address; the destination is ${CHAIN_NAMES[chain]}`, looksLike: other };
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
