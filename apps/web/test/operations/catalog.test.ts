// The error catalog (spec §13): every code the relayer, its executor and the swap service can produce has a row (a
// scan of their sources), every row has its words in the message catalog and its funds class, the classification of
// the wallet's own error classes and of EIP-1193 codes, the three first sentences, and the rule that no action is a
// re-send.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CATALOG, CODES, classify, hasCode, reasonKey, titleKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { fundsHeadline } from "../../src/features/operations/recovery";
import { en } from "../../src/app/i18n/en";
import { ko } from "../../src/app/i18n/ko";
import { t } from "../../src/app/i18n/messages";
import { TransportRefusal } from "@privacy-wallet/privacy-engine/transport/http";
import { RpcDisagreement } from "@privacy-wallet/sdk/chain";
import { GuestInstructionMismatch } from "@privacy-wallet/sdk/guestGuard";
import { MinimumMoved, ProviderCallMismatch } from "@privacy-wallet/sdk/providerCall";
import { RelayerRefusal } from "@privacy-wallet/sdk/relayer";
import { OrderMismatch } from "@privacy-wallet/sdk/swapGuard";
import { NoRelayer } from "@privacy-wallet/sdk/privateTx";
import { TreeNotProven, VerificationUnavailable } from "@privacy-wallet/sdk/verifiedReads";
import { ServiceMinimumMoved } from "@privacy-wallet/sdk/swapService";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) out.push(...sources(p)); else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p); }
  return out;
}
const ACTIONS = ["edit", "review", "new-quote", "wait", "resume-tracking", "continue-monitoring", "start-refund", "check-wallet", "check-settings", "housekeeping"];

describe("coverage (spec §13: a test scans the sources and fails on a code without a row)", () => {
  it("every RelayerError, SwapJobError and `code:` of the relayer's sources, and every `code:` of the API's and the swap engine's, has a row", () => {
    const found = new Set<string>();
    for (const dir of ["apps/relayer/src", "packages/swap-engine/src", "apps/api/src", "packages/server-kit/src"]) for (const f of sources(join(ROOT, dir))) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/(?:RelayerError|SwapJobError|ShieldJobError)\("([a-z_]+)"/g)) found.add(m[1]);
      for (const m of s.matchAll(/readonly code = "([a-z_]+)"/g)) found.add(m[1]);
      for (const m of s.matchAll(/code: "([a-z_]+)"/g)) found.add(m[1]);
      // the swap engine's tip codes, thrown as TipError (the eleventh review round's third critique of slice 4: three had no row)
      for (const m of s.matchAll(/TipError\("([a-z_]+)"/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThanOrEqual(30);
    const missing = [...found].filter((c) => !hasCode(c));
    expect(missing, `codes without a catalog row: ${missing.join(", ")}`).toEqual([]);
    for (const c of ["fee_below_percent", "nullifier_in_flight", "minimum_moved", "price_guard", "rate_limited", "capacity", "bad_signature", "payload_mismatch", "no_vault", "destination_not_protectable"]) expect(found).toContain(c);
  });
  it("every row has a title and a reason in the message catalog, a funds class, known actions, and never a re-send", () => {
    expect(CODES.length).toBeGreaterThan(60);
    for (const code of CODES) {
      expect(en, `${code} title`).toHaveProperty(`op.error.${code}.title`);
      expect(en, `${code} reason`).toHaveProperty(`op.error.${code}.reason`);
      expect(t(titleKey(code)).length).toBeGreaterThan(3);
      expect(t(reasonKey(code)).length).toBeGreaterThan(10);
      expect(["not-moved", "still-protected", "unknown"]).toContain(CATALOG[code].fundsClass);
      expect(CATALOG[code].actions.length).toBeGreaterThan(0);
      for (const a of CATALOG[code].actions) expect(ACTIONS, `${code}: ${a}`).toContain(a);
      expect(/retry|resend|re-send/i.test(CATALOG[code].actions.join(" ")), `${code} offers no re-send`).toBe(false);
      expect(/anonymous|mixer|untraceable|undetectable/i.test(t(titleKey(code)) + t(reasonKey(code))), `${code} wording`).toBe(false);
    }
    expect(titleKey("never_seen")).toBe("op.error.unknown.title");
    expect(CATALOG.fee_too_low).toEqual({ source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] });
    expect(CATALOG.execute_failed).toMatchObject({ source: "tracker", fundsClass: "still-protected" });
    expect(CATALOG.send_failed.fundsClass, "a relayer that signed but could not broadcast: the chain decides").toBe("unknown");
    // V6 Stage 9 (the local run's second protect): the injected wallet refusing for lack of funds sent nothing
    for (const m of ["insufficient funds for gas * price + value: have 491693580581255900000 want 500000000000000000000", "Sender doesn't have enough funds to send tx", "transfer amount exceeds balance"])
      expect(classify(new Error(m)), m).toMatchObject({ code: "wallet_insufficient_funds", fundsClass: "not-moved", actions: ["edit"] });
    expect(classify(new Error("insufficient shielded balance: 3 ETH")).code, "the protected balance keeps its own code").toBe("insufficient_balance");
  });
});

describe("classify", () => {
  const addr = ("0x" + "11".repeat(20)) as `0x${string}`;
  it("the wallet's classes by instance, the relayer by its code or status, EIP-1193 by number, the services by message", () => {
    expect(classify(new RelayerRefusal("fee 1 is below the current minimum 2", "fee_too_low", 400)).code).toBe("fee_too_low");
    expect(classify(new RelayerRefusal("too many requests", "something_new", 429)).code).toBe("rate_limited");
    expect(classify(new RelayerRefusal("full", undefined, 503)).code).toBe("capacity");
    expect(classify(new RelayerRefusal("nope", undefined, 400)).code).toBe("service_rejected");
    expect(classify(new ServiceMinimumMoved(100n, 90n)).code).toBe("minimum_moved");
    expect(classify(new MinimumMoved(90n, 100n)).code).toBe("minimum_moved");
    expect(classify(new RpcDisagreement("the root", ["1", "2"])).code).toBe("rpc_disagreement");
    expect(classify(new TransportRefusal("evil.example")).code).toBe("transport_refused");
    expect(classify(new OrderMismatch("amount", "1 vs 2")).code).toBe("order_mismatch");
    expect(classify(new GuestInstructionMismatch("memo", "x")).code).toBe("guest_instruction_mismatch");
    expect(classify(new ProviderCallMismatch("thorchain", "value", "x")).code).toBe("provider_call_mismatch");
    expect(classify({ code: 4001, message: "User rejected the request." })).toMatchObject({ code: "user_rejected", fundsClass: "not-moved", actions: ["review"] });
    expect(classify({ code: 4900 }).code).toBe("wallet_disconnected");
    expect(classify({ code: 4902 }).code).toBe("chain_mismatch");
    expect(classify({ code: "nullifier_in_flight" }).code).toBe("nullifier_in_flight");
    expect(classify(new Error("no quote from any provider")).code).toBe("no_quote");
    expect(classify(new Error("route filtered: breaker open")).code).toBe("route_filtered");
    expect(classify(new Error("unknown order")).code).toBe("unknown_order");
    expect(classify(new Error("insufficient shielded balance for the amount plus the relayer fees of the merges it needs")).code).toBe("insufficient_balance");
    expect(classify(new Error("Your ETH balance is spread over 12 notes; this spend needs more than 8 merges")).code).toBe("housekeeping_needed");
    // nothing was sent: the notes need a merge first, never "We are checking where your funds are" (the audit's unverified m55)
    expect(classify(new Error("this amount needs a private merge of smaller notes first (ensureSpendable)"))).toMatchObject({ code: "housekeeping_needed", fundsClass: "not-moved" });
    expect(classify(new Error("the deposit was mined but its commitment was not found in the receipt")).code).toBe("deposit_not_found");
    expect(classify(new TypeError("fetch failed"))).toMatchObject({ code: "relayer_unreachable", fundsClass: "unknown" });
    // no relayer serves the asset: nothing was sent, whatever words its answers carry (the audit's unverified m56)
    expect(classify(new NoRelayer(["http://relayer.example: unreachable or another chain / core"]))).toMatchObject({ code: "no_relayer", fundsClass: "not-moved", actions: ["check-settings"] });
    // the light client's check failed before anything was proved: nothing moved, whatever its words (audit round 2, n38)
    expect(classify(new TreeNotProven("the RPC endpoints show 3 leaves; the chain had 5 at finalized block 9 — they are hiding notes"))).toMatchObject({ code: "verification_failed", fundsClass: "not-moved" });
    expect(classify(new VerificationUnavailable("beacon API https://beacon.example: HTTP 429 for /eth/v1/beacon/light_client/updates"))).toMatchObject({ code: "verification_failed", fundsClass: "not-moved", actions: ["wait", "check-settings"] });
    expect(classify(new VerificationUnavailable("fetch failed")).code, "not an unreachable relayer").toBe("verification_failed");
    expect(classify(new Error("the quote expired")).code).toBe("quote_expired");
    expect(classify(new Error("something else entirely"))).toMatchObject({ code: "unknown", fundsClass: "unknown", detail: "something else entirely" });
    expect(classify("a string").code).toBe("unknown");
    expect(classify(undefined).code).toBe("unknown");
    expect(addr.length).toBe(42);
  });
  it("the three first sentences", () => {
    expect(fundsHeadline("not-moved", t)).toBe("Your funds were not moved.");
    expect(fundsHeadline("still-protected", t)).toBe("Your funds are still protected.");
    expect(fundsHeadline("unknown", t)).toBe("We are checking where your funds are.");
  });
});

describe("the wallet's own messages (the review round of 2026-11-03)", () => {
  it("a Protect confirmed with no wallet to submit with is wallet_disconnected — not moved — never unknown (W4)", () => {
    expect(classify(new Error("no injected wallet to submit with"))).toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
  });
  it("a WalletConnect session the wallet app ended asks nothing — its provider's words are wallet_disconnected, not moved, never unknown (the eleventh review round, slice 6c)", () => {
    // the installed provider's own text (packages/wallet-engine/test/review11-wc-connect.test.ts pins it after a session_delete)
    expect(classify(new Error("Please call connect() before request()"))).toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
  });
});

describe("the twelfth review round (B12-5, A12-2; W6 §2): a wallet app's own answers and WalletConnect's", () => {
  /** WalletConnect's own utilities, the installed copy (no direct dependency of this app: resolved from @walletconnect/core's directory) */
  const walletConnectUtils = () => {
    const req = createRequire(import.meta.url);
    return req(req.resolve("@walletconnect/utils", { paths: [dirname(req.resolve("@walletconnect/core"))] })) as {
      getSdkError: (key: string) => { message: string; code: number };
      getInternalError: (key: string, context?: string) => { message: string; code: number };
      createDelayedPromise: (ttl: number, message: string) => { done: () => Promise<unknown> };
    };
  };

  it("WalletConnect's own refusals by their codes (getSdkError): the user's refusal, the network — never unknown", () => {
    const { getSdkError } = walletConnectUtils();
    expect(classify(getSdkError("USER_REJECTED")), "a plain {message, code: 5000}").toMatchObject({ code: "user_rejected", fundsClass: "not-moved" });
    // every refusal the installed library names, each by its code (5000–5003, 5100, 5101–5104)
    const rows: [string, string][] = [
      ["USER_REJECTED", "user_rejected"],
      ["USER_REJECTED_CHAINS", "user_rejected"],
      ["USER_REJECTED_METHODS", "user_rejected"],
      ["USER_REJECTED_EVENTS", "user_rejected"],
      ["UNSUPPORTED_CHAINS", "chain_mismatch"],
      ["UNSUPPORTED_METHODS", "user_rejected"],
      ["UNSUPPORTED_EVENTS", "user_rejected"],
      ["UNSUPPORTED_ACCOUNTS", "user_rejected"],
      ["UNSUPPORTED_NAMESPACE_KEY", "user_rejected"],
    ];
    for (const [key, code] of rows) {
      expect(classify(getSdkError(key)), `${key} (${getSdkError(key).code})`).toMatchObject({ code, fundsClass: "not-moved" });
      // and by its code alone: in words no row reads (its own "User rejected …" also reads as a refusal)
      expect(classify({ code: getSdkError(key).code, message: "abgelehnt" }), `${key}'s code alone`).toMatchObject({ code });
    }
    expect(classify(getSdkError("USER_REJECTED")).detail, "its message read").toBe("User rejected.");
    expect(classify({ code: 5000, message: "Anfrage abgelehnt" }), "by its code, a wallet app's own words aside").toMatchObject({ code: "user_rejected" });
  });

  it("the session's end with a request open (6000, the sign client's rejection at a session delete): its own row, its funds unknown — never 'nothing was sent'", () => {
    const { getSdkError } = walletConnectUtils();
    const ended = getSdkError("USER_DISCONNECTED");
    expect(ended).toEqual({ message: "User disconnected.", code: 6000 });
    expect(classify(ended)).toMatchObject({ code: "wallet_session_ended", fundsClass: "unknown", actions: ["continue-monitoring"] });
    expect(classify({ code: 6000, message: "Session deleted" }), "by its code, its words aside").toMatchObject({ code: "wallet_session_ended" });
    expect(t(titleKey("wallet_session_ended") as never)).toBe(en["op.error.wallet_session_ended.title"]);
    expect(en["op.error.wallet_session_ended.reason"], "the wallet app may have sent it").not.toMatch(/nothing was sent|not moved/i);
    expect(classify({ code: 4900, message: "Disconnected" }), "EIP-1193's own: before anything was sent").toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
  });

  it("the sign client's texts for a session it no longer serves, thrown before the request is published: disconnected, not moved", () => {
    const { getInternalError } = walletConnectUtils();
    const gone = (key: string, context: string) => new Error(getInternalError(key, context).message); // its code dropped, as the sign client throws it
    expect(gone("EXPIRED", "session topic: 0xabc").message).toBe("Expired. session topic: 0xabc");
    expect(classify(gone("EXPIRED", "session topic: 0xabc")), "past its expiry, its expirer not yet run").toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
    expect(classify(gone("MISSING_OR_INVALID", "Record was recently deleted - session: 0xabc")), "deleted a moment ago").toMatchObject({ code: "wallet_disconnected" });
    expect(classify(gone("NO_MATCHING_KEY", "session topic doesn't exist: 0xabc"))).toMatchObject({ code: "wallet_disconnected" });
    expect(classify(gone("MISSING_OR_INVALID", "session topic does not exist in keychain: 0xabc"))).toMatchObject({ code: "wallet_disconnected" });
    // read by "no matching key" alone: the keychain's (crypto.encode, before the publish) and the session store's (just after isValidRequest)
    expect(classify(gone("NO_MATCHING_KEY", "keychain: 0xabc")), "the keychain's").toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
    expect(classify(gone("NO_MATCHING_KEY", "session: 0xabc")), "the session store's").toMatchObject({ code: "wallet_disconnected", fundsClass: "not-moved" });
    expect(classify(new Error("the wallet app said: Expired. session topic")), "the sign client's text only, at its start").toMatchObject({ code: "unknown" });
  });

  it("the sign client's request expiry: its own row — its funds unknown, never a quote's — with its code, and a copy that lost it", async () => {
    const { createDelayedPromise } = walletConnectUtils();
    const expired = await createDelayedPromise(1, "Request expired. Please try again.").done().then(
      () => null,
      (e: unknown) => e,
    );
    expect(classify(expired)).toMatchObject({ code: "wallet_request_expired", fundsClass: "unknown", actions: ["continue-monitoring"] });
    expect(classify({ message: "Request expired. Please try again." }), "a copy without its code").toMatchObject({ code: "wallet_request_expired" });
    expect(classify(Object.assign(new Error("Request expired"), { code: 6 })), "its code and its words, another wording").toMatchObject({ code: "wallet_request_expired" });
    expect(classify({ code: 6, message: "something else" }), "code 6 alone is no expiry").toMatchObject({ code: "unknown" });
    expect(t(titleKey("wallet_request_expired") as never)).toBe(en["op.error.wallet_request_expired.title"]);
    expect(en["op.error.wallet_request_expired.reason"], "never 'nothing was sent': the wallet app may still send it").not.toMatch(/nothing was sent|not moved/i);
    // the words' fifteen minutes are the installed sign client's own request lifetime (its seconds)
    const signClient = createRequire(import.meta.url)("@walletconnect/sign-client") as { ENGINE_RPC_OPTS: { wc_sessionRequest: { req: { ttl: number } } } };
    expect(signClient.ENGINE_RPC_OPTS.wc_sessionRequest.req.ttl, "15 minutes").toBe(15 * 60);
    expect(en["op.error.wallet_request_expired.reason"]).toContain("15 minutes");
    expect(ko["op.error.wallet_request_expired.reason"]).toContain("15분");
  });

  it("an approval its wallet app did not answer says to decline it there, never to wait for it; an unreported one no longer says an earlier approval stays as it was", () => {
    expect(en["op.error.approval_unanswered.reason"]).toContain("decline it there");
    expect(en["op.error.approval_unanswered.reason"], "an approval that may never come").not.toMatch(/once it has gone through/);
    expect(en["op.error.approval_unanswered.reason"], "a connection that ended").toContain("connect it again first");
    expect(ko["op.error.approval_unanswered.reason"]).toContain("그곳에서 거절하세요");
    expect(ko["op.error.approval_unanswered.reason"]).not.toContain("처리된 뒤");
    expect(ko["op.error.approval_unanswered.reason"]).toContain("다시 연결하세요");
    // false once a clearing step was mined: the earlier approval is none by then
    expect(en["op.error.approval_unconfirmed.reason"]).not.toMatch(/already given stays as it was/);
    expect(ko["op.error.approval_unconfirmed.reason"]).not.toContain("이미 해 둔 승인이 그대로");
  });

  it("a request its wallet app never confirmed in the hour reads so — never a page closed before its send; the held Review's why carries its time", () => {
    expect(CATALOG.wallet_request_unanswered).toMatchObject({ fundsClass: "not-moved", actions: ["review"] });
    expect(en["op.error.wallet_request_unanswered.title"]).toContain("never confirmed");
    expect(en["op.error.wallet_request_unanswered.reason"], "the page stayed open").not.toMatch(/closed|reloaded/i);
    expect(en["op.error.interrupted.reason"], "the end it had read instead").not.toBe(en["op.error.wallet_request_unanswered.reason"]);
    expect(ko["op.error.wallet_request_unanswered.title"]).toContain("확인하지 않았습니다");
    for (const words of [en, ko]) for (const k of ["screen.review.blocker.walletAppProtect", "screen.review.blocker.walletAppSend"] as const) expect(words[k], k).toContain("{time}");
    for (const k of ["screen.review.blocker.walletAppProtect", "screen.review.blocker.walletAppSend"] as const) expect(en[k], k).toContain("decline it there");
    // a Protect's hold ends at its time by the clock; a Send's at the wallet's verdict (the critique of 12d1b)
    expect(en["screen.review.blocker.walletAppProtect"]).toContain("from {time}");
    expect(en["screen.review.blocker.walletAppSend"]).toContain("once the wallet has seen how that one ended");
    expect(ko["op.error.wallet_request_unanswered.reason"], "an Activity entry: 항목").toContain("이 항목은 그대로 남습니다");
  });

  it("a wallet app's plain answers read from their message — the refusal, the funds — and never as the wallet's own reverts, fetches or quotes", () => {
    expect(classify({ code: -32000, message: "User rejected the transaction" })).toMatchObject({ code: "user_rejected" });
    expect(classify({ code: -32603, message: "User denied transaction signature." })).toMatchObject({ code: "user_rejected" });
    // each of the refusal's words, on a generic code — each message read by one of them alone
    for (const message of ["User rejected.", "rejected the request", "Request rejected", "User denied account access", "Denied the transaction", "Request declined", "User cancelled", "User canceled"])
      expect(classify({ code: -32000, message }), message).toMatchObject({ code: "user_rejected", fundsClass: "not-moved" });
    expect(classify({ code: -32000, message: "insufficient funds for gas * price + value" })).toMatchObject({ code: "wallet_insufficient_funds" });
    expect(classify(new Error("rejected: insufficient funds")), "the funds before the refusal: its remedy").toMatchObject({ code: "wallet_insufficient_funds" });
    expect(classify({ code: -32000, message: "Transaction declined: insufficient funds" }), "both words: the funds, its remedy").toMatchObject({ code: "wallet_insufficient_funds" });
    expect(classify({ code: -32000, message: "execution reverted" }), "its own simulation: nothing mined, no fee").toMatchObject({ code: "unknown" });
    expect(classify({ code: -32603, message: "Failed to fetch" }), "its own node, not a relayer").toMatchObject({ code: "unknown" });
    expect(classify({ code: -32000, message: "Transaction expired" }), "its own, no quote").toMatchObject({ code: "unknown" });
    expect(classify(new Error("Failed to publish payload, please try again.")), "the request may have reached the relay").toMatchObject({ code: "unknown" });
  });

  it("the wallet's own errors keep their rows: a revert it read, a transport that failed, a quote that expired; a session gone is disconnected", () => {
    expect(classify(new Error(`the approval 0x${"ab".repeat(32)} reverted`))).toMatchObject({ code: "receipt_reverted" });
    expect(classify(new Error("HTTP request failed. Details: fetch failed"))).toMatchObject({ code: "relayer_unreachable" });
    expect(classify(new Error("the signed quote has expired"))).toMatchObject({ code: "quote_expired" });
    expect(classify(new Error("Quote expired"))).toMatchObject({ code: "quote_expired" });
    expect(classify(new Error("the order expired before it was funded")), "no quote named: the catch-all /expired/ is gone").toMatchObject({ code: "unknown" });
    expect(classify(new Error("Missing or invalid. session topic does not exist in keychain"))).toMatchObject({ code: "wallet_disconnected" });
    expect(classify(new Error("No matching key. session topic doesn't exist: 0xabc"))).toMatchObject({ code: "wallet_disconnected" });
    expect(classify({ code: 4001, message: "User rejected the request." })).toMatchObject({ code: "user_rejected" });
  });
});
