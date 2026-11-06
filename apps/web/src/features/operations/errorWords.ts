// A thrown error in the reader's words (the eleventh review round, 2026-11-04, E11-10). The Swap screens and the Activity detail had shown the
// thrown message itself — for the swap service's refusals its own English `error` ("no quote from thorchain"), for a provider's failure the
// adapter's text with the provider's body inside, for the order runner its English sentences — to every reader, and in English to a Korean one,
// though the catalog has every code's words in both languages. Now the catalog's reason whenever the classifier knows the code (as Settings →
// Connected wallet's revoke has done since V6), the caller's own words otherwise, and the raw text for Advanced only, after them.
import type { MessageKey } from "../../app/i18n/en";
import { classify, hasCode, reasonKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { RelayerRefusal } from "@privacy-wallet/sdk/relayer";
import { FundingAlreadySent } from "@privacy-wallet/sdk/swapFunding";
import type { T } from "./recovery";

/**
 * The codes whose catalog reason speaks of a step after the commit — a proof made and its transaction looked for, the operation's history, a
 * try the wallet makes on its own — and the code of a failure the catalog does not know. Where nothing was committed yet (a quote, the commit
 * itself) they read as the caller's own words, which claim nothing of the kind: a request that reached no service reads as
 * `relayer_unreachable` whichever service it was meant for. So do a service's own failure (`internal`: "the wallet checks where your funds
 * are"), a rate limit ("confirm again") and a route filtered at the commit ("another route is quoted") — the second critique of E11-10.
 */
const NOT_BEFORE_COMMIT: ReadonlySet<string> = new Set([
  "unknown",
  "relayer_unreachable",
  "provider_unavailable",
  "service_rejected",
  "internal",
  "rate_limited",
  "route_filtered",
]);

export interface ErrorWordsOptions {
  advanced: boolean;
  /** the caller's own words for a failure the catalog has no code for */
  fallback: MessageKey;
  /** nothing was committed yet: the codes of a later step read as `fallback` too */
  beforeCommit?: boolean;
}

/** The words of `e`: the catalog's reason, or `fallback`; under Advanced the raw text after them, in parentheses. */
export function errorWords(t: T, e: unknown, o: ErrorWordsOptions): string {
  const c = classify(e);
  const own = c.code === "unknown" || (o.beforeCommit === true && NOT_BEFORE_COMMIT.has(c.code));
  const words = t(own ? o.fallback : (reasonKey(c.code) as MessageKey));
  return o.advanced && c.detail && c.detail !== words ? `${words} (${c.detail})` : words;
}

/**
 * A return the relayer could not take now — no answer, its own failure, a rate limit, its capacity, any 5xx (a proxy's while it restarts) —:
 * nothing returned yet, try again. The catalog's rows speak of other steps ("a secured transaction looked for on chain", "the wallet checks
 * where your funds are", "confirm again"), and a return secures nothing and leaves nothing to check.
 */
const NOT_NOW: ReadonlySet<string> = new Set(["relayer_unreachable", "provider_unavailable", "internal", "rate_limited", "capacity"]);


/**
 * Return funds, Start refund and Cancel before it is funded — a funded order's lines, in the return's own words (the critique of E11-10, and
 * its second critique: the catalog's rows, written for a send or a commit, had told a funded order "Nothing left your protected balance",
 * "the details are in the operation's history", "confirm again or return them"). A funding already sent is said as such — the catalog's row
 * for its code is a funding that never landed, and this one may have landed or still be on its way —; a relayer that could not take the
 * return now as nothing returned yet; one that refused it as refused, its funds held for the swap, never "try again" (a retry resends the
 * same payload); one that runs no swaps with the way to a relayer that does (the order's refund asks the Settings relayer then — the third
 * critique: the catalog's row had named no path, and a handed-over order's return had never asked another); the wallet's own refusals by
 * their codes' words (RefundRefusal, a funding under way); a failure without a code in the caller's own words.
 */
export function returnFundsWords(t: T, e: unknown, advanced: boolean, fallback: MessageKey = "screen.swap.returnFailed"): string {
  if (e instanceof FundingAlreadySent) {
    const words = t("screen.swap.fundingAlreadySent");
    return advanced ? `${words} (${e.message})` : words;
  }
  const c = classify(e);
  const key: MessageKey =
    NOT_NOW.has(c.code) || (e instanceof RelayerRefusal && e.status >= 500 && !hasCode(e.code ?? ""))
      ? "screen.swap.returnNoAnswer"
      : c.code === "swap_unavailable"
        ? "screen.swap.returnNoSwaps"
        : e instanceof RelayerRefusal
          ? "screen.swap.returnRefused"
          : c.code === "unknown"
            ? fallback
            : (reasonKey(c.code) as MessageKey);
  const words = t(key);
  return advanced && c.detail && c.detail !== words ? `${words} (${c.detail})` : words;
}
