// A connection's failure in the wallet's words (the eleventh review round, slice 6c's critiques): the connector picker and the pairing sheet
// had shown the wallet's or WalletConnect's own text — English in both languages, protocol words like "Proposal expired".
import type { MessageKey } from "../../app/i18n/en";

type T = (key: MessageKey) => string;

/**
 * A failure on this device before any wallet was asked: WalletConnect's library not loaded, no network (the fourth critique: these had read
 * as the wallet app's, sending the user to look for a request never sent).
 */
const NOT_STARTED = /failed to fetch|dynamically imported module|no internet connection|networkerror|load failed|websocket/i;
/**
 * WalletConnect's relay out of this network's reach — the library's own transport texts, its proposal never published, the code never shown
 * (the twelfth review round, B12-4: "Failed to publish custom payload…" had read "The wallet app did not connect"). The browser is online
 * then (the sign client checks that first: "No internet connection detected"): its own words, this network's, never the device's — and in
 * the picker another wallet, which needs no relay (the critique of 12d3b).
 */
const RELAY_UNREACHABLE = /failed to publish|couldn't establish socket|socket stalled|subscribing to .* failed|connection interrupted/i;
/** An earlier WalletConnect end still under way, acknowledged but unfinished (WalletConnectEndUnfinished): every tap refused until it settles. */
const UNFINISHED_END = /walletconnect has not finished ending a session/i;
/** A session an earlier WalletConnect end left, its delete failed again (WalletConnectSessionLeft): a later tap deletes it again once online. */
const SESSION_LEFT = /walletconnect could not delete the session an earlier end left/i;
/**
 * The failures whose words name a reload: their sheets offer Reload — an installed copy has no browser reload control (the critique of 12d3c,
 * YP and YQ). "only": an end still under way — the failure a reload clears for sure: that end may never settle (an answer lost with a socket
 * that dropped); once it settles the next tap pairs, and until then Try again is refused at once —, Reload in its place in the pairing's
 * sheet. "beside": a failed delete's, Try again kept (a later tap deletes it again once online).
 */
export const reloadOffered = (error: string): "only" | "beside" | null =>
  UNFINISHED_END.test(error) ? "only" : SESSION_LEFT.test(error) ? "beside" : null;

/**
 * The wallet's refusal; a request the wallet is already showing (EIP-1193 -32002: "Already processing eth_requestAccounts", "… already
 * pending …" — trying again fails the same way until it is answered); a connection that could not start on this device; a pairing the
 * wallet app did not answer in time; anything else. The wallet's own text, often English, comes after the words under Advanced only.
 * `pairing`: the pairing's own sheet, whose one action is Try again — no list to choose from again, no other wallet (the third critique);
 * Reload beside it, or in its place, where the words name a reload (reloadOffered).
 * `others`: the picker lists another connector to choose (a phone's picker may list WalletConnect alone: the fourth critique).
 */
export function connectErrorWords(t: T, error: string, advanced: boolean, where: "picker" | "pairing" = "picker", others = true): string {
  // a session an earlier WalletConnect end in this page left (the twelfth review round, B12-3 and 12d3c): its delete failed again — a later
  // tap deletes it again once online, a reload starts afresh; its cause under Advanced —, or that end is still under way, acknowledged but
  // unfinished — every tap refused until it settles, which may never come: a reload starts afresh
  const key: MessageKey = UNFINISHED_END.test(error)
    ? "wallet.sheet.error.unfinished"
    : SESSION_LEFT.test(error)
    ? "wallet.sheet.error.leftover"
    : /already (pending|processing)/i.test(error)
    ? "wallet.sheet.error.pending"
    : /reject|denied|declined/i.test(error)
      ? "wallet.sheet.error.refused"
      : RELAY_UNREACHABLE.test(error)
        ? where === "picker" && others
          ? "wallet.sheet.error.relayOthers"
          : "wallet.sheet.error.relay"
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
