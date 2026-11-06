// A connection's failure in the wallet's words (the eleventh review round, slice 6c's critiques): the connector picker and the pairing sheet
// had shown the wallet's or WalletConnect's own text — English in both languages, protocol words like "Proposal expired".
import type { MessageKey } from "../../app/i18n/en";

type T = (key: MessageKey) => string;

/**
 * A failure on this device before any wallet was asked: WalletConnect's library not loaded, no network, its relay unreachable (the fourth
 * critique: these had read as the wallet app's, sending the user to look for a request never sent).
 */
const NOT_STARTED = /failed to fetch|dynamically imported module|no internet connection|networkerror|load failed|websocket/i;

/**
 * The wallet's refusal; a request the wallet is already showing (EIP-1193 -32002: "Already processing eth_requestAccounts", "… already
 * pending …" — trying again fails the same way until it is answered); a connection that could not start on this device; a pairing the
 * wallet app did not answer in time; anything else. The wallet's own text, often English, comes after the words under Advanced only.
 * `pairing`: the pairing's own sheet, whose one action is Try again — no list to choose from again, no other wallet (the third critique).
 * `others`: the picker lists another connector to choose (a phone's picker may list WalletConnect alone: the fourth critique).
 */
export function connectErrorWords(t: T, error: string, advanced: boolean, where: "picker" | "pairing" = "picker", others = true): string {
  const key: MessageKey = /already (pending|processing)/i.test(error)
    ? "wallet.sheet.error.pending"
    : /reject|denied|declined/i.test(error)
      ? "wallet.sheet.error.refused"
      : NOT_STARTED.test(error)
        ? "wallet.sheet.error.network"
        : /expired/i.test(error)
          ? where === "pairing"
            ? "wallet.pairing.error.expired"
            : "wallet.sheet.error.expired"
          : where === "pairing"
            ? "wallet.pairing.error.other"
            : others
              ? "wallet.sheet.error.other"
              : "wallet.sheet.error.otherOnly";
  const words = t(key);
  return advanced ? `${words} (${error})` : words;
}
