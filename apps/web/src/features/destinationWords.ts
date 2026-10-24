// A refused destination in the user's language (a V6 follow-up of 2026-10-16): every code of the destination parsers has its
// words; before, the parser's English reason was dropped into each language's sentence. The detail stays in `reason`.
import type { DestinationCode } from "@privacy-wallet/protocol/wallet/destinations";
import type { DestinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import { CHAIN_NAMES } from "@privacy-wallet/protocol/wallet/destinations";
import type { ChainKind } from "@privacy-wallet/protocol/wallet/chainKeys";
import type { MessageKey } from "../app/i18n/messages";
import { JournalNotKept, JournalUnreadable } from "@privacy-wallet/sdk/wallet/session";
import type { useT } from "../app/i18n/useT";

const WORDS: Record<DestinationCode, MessageKey> = {
  empty: "dest.empty",
  evm_format: "dest.evm_format",
  evm_checksum: "dest.evm_checksum",
  btc_testnet: "dest.btc_testnet",
  btc_invalid: "dest.btc_invalid",
  sol_invalid: "dest.sol_invalid",
  sol_system: "dest.sol_system",
  other_chain: "dest.other_chain",
  zero_address: "dest.zero_address",
  burn_address: "dest.burn_address",
  protocol_contract: "dest.protocol_contract",
  token_contract: "dest.token_contract",
  privacy_invalid: "dest.privacy_invalid",
  unknown_format: "dest.unknown_format",
};

const STATUS: Record<Exclude<NonNullable<DestinationCheck["reason"]>, "cooling-off">, MessageKey> = {
  unknown: "dest.status.unknown",
  unverified: "dest.status.unverified",
  unapproved: "dest.status.unapproved",
  stale: "dest.status.stale",
  retired: "dest.status.retired",
};

/**
 * Where a destination stands in the address book, in the reader's words (audit round 2, r55): from the check's reason, the
 * entry's source and override and the cooling-off's end. The check's own `status` is the SDK's English, and a Korean reader
 * had read it under a typed destination, in Send's note and on the Review's destination line.
 */
export function destinationStatusWords(t: ReturnType<typeof useT>, check: DestinationCheck, now = Date.now()): string {
  const e = check.entry;
  if (!e) return t(check.ok ? "dest.status.entered" : "dest.status.unknown");
  if (check.ok) return t(e.source === "fresh" ? "dest.status.fresh" : e.override ? "dest.status.overridden" : "dest.status.verified");
  if (check.reason === "cooling-off") return t("dest.status.coolingOff", { hours: Math.max(1, Math.ceil(((check.until ?? now) - now) / 3_600_000)) });
  return t(STATUS[check.reason ?? "unknown"]);
}

/** What the user reads about a refused destination: its code's words, with the chain names and the token's symbol. */
export function destinationWords(t: ReturnType<typeof useT>, r: { code: DestinationCode; chain?: ChainKind; looksLike?: ChainKind; symbol?: string }): string {
  return t(WORDS[r.code], {
    chain: r.chain ? CHAIN_NAMES[r.chain] : "",
    other: r.looksLike ? CHAIN_NAMES[r.looksLike] : "",
    symbol: r.symbol ?? "",
  });
}

/** Why no fresh address was reserved: the journal cannot keep it (audit round 2, n48); null for any other error. */
export const unsavedAddressWords = (e: unknown): MessageKey | null =>
  e instanceof JournalNotKept ? "fresh.notKept" : e instanceof JournalUnreadable ? "fresh.unreadable" : null;
