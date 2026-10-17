// The error catalog (spec §13): every code the relayer, its executor and the swap service can produce has a row (a
// scan of their sources), every row has its words in the message catalog and its funds class, the classification of
// the wallet's own error classes and of EIP-1193 codes, the three first sentences, and the rule that no action is a
// re-send.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, CODES, classify, hasCode, reasonKey, titleKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { fundsHeadline } from "../../src/features/operations/recovery";
import { en } from "../../src/app/i18n/en";
import { t } from "../../src/app/i18n/messages";
import { TransportRefusal } from "@privacy-wallet/privacy-engine/transport/http";
import { RpcDisagreement } from "@privacy-wallet/sdk/chain";
import { GuestInstructionMismatch } from "@privacy-wallet/sdk/guestGuard";
import { MinimumMoved, ProviderCallMismatch } from "@privacy-wallet/sdk/providerCall";
import { RelayerRefusal } from "@privacy-wallet/sdk/relayer";
import { OrderMismatch } from "@privacy-wallet/sdk/swapGuard";
import { NoRelayer } from "@privacy-wallet/sdk/privateTx";
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
