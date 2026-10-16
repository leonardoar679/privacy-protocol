// A refused destination in the user's language (a V6 follow-up of 2026-10-16): every code of the destination parsers has its
// words; before, the parser's English reason was dropped into each language's sentence. The detail stays in `reason`.
import type { DestinationCode } from "@privacy-wallet/protocol/wallet/destinations";
import { CHAIN_NAMES } from "@privacy-wallet/protocol/wallet/destinations";
import type { ChainKind } from "@privacy-wallet/protocol/wallet/chainKeys";
import type { MessageKey } from "../app/i18n/messages";
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

/** What the user reads about a refused destination: its code's words, with the chain names and the token's symbol. */
export function destinationWords(t: ReturnType<typeof useT>, r: { code: DestinationCode; chain?: ChainKind; looksLike?: ChainKind; symbol?: string }): string {
  return t(WORDS[r.code], {
    chain: r.chain ? CHAIN_NAMES[r.chain] : "",
    other: r.looksLike ? CHAIN_NAMES[r.looksLike] : "",
    symbol: r.symbol ?? "",
  });
}
