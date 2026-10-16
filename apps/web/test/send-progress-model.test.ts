// The pure models under the V6 Send and Progress screens (spec v2.0 §3, §7.4, §7.7; doc §24–§25, §58): what a typed
// destination is (a privacy address, an EVM address on the pool's chain, Bitcoin, another chain — named by ERC-3770 or
// EIP-681, or by its format —, or not an address, with the reason), the swap target a cross-chain destination continues
// to (never a silent fallback to another chain), the document's send — 2,500 USDC with a 4.10 USDC relayer charge:
// 25.00 privacy fee, 2,470.90 arrives, and exactly that from 2,500 in exact output —, the view-model's action, and the
// four progress lines that only move forward.
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { checksOf, crossTargetOf, destinationOf, sendModel, sendSplit, type Destination } from "../src/features/send/model";
import { furthestLine, PROGRESS_LINES, progressLineOf, progressModelOf } from "../src/features/progress/model";

const EVM = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const SOL = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const POOL = 31337;
const pp1 = privacyAddress(new Uint8Array(32).fill(7));
const USDC = { symbol: "USDC", decimals: 6 };
const usdc = (whole: string) => BigInt(Math.round(Number(whole) * 1e6));

describe("destinationOf (spec v2.0 §7.4)", () => {
  it("a public exit that would lose what it receives is refused with its code: the zero and the burn address, the deployment's contracts, a token's own (a V6 follow-up of 2026-10-16)", () => {
    const known = [
      { address: "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469", kind: "protocol" as const },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", kind: "token" as const, symbol: "USDT" },
    ];
    expect(destinationOf("0x0000000000000000000000000000000000000000", POOL)).toMatchObject({ kind: "invalid", code: "zero_address" });
    expect(destinationOf("0x000000000000000000000000000000000000dead", POOL)).toMatchObject({ kind: "invalid", code: "burn_address" });
    expect(destinationOf("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469", POOL, known)).toMatchObject({ kind: "invalid", code: "protocol_contract" });
    expect(destinationOf(`ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@${POOL}`, POOL, known), "named for the pool's chain").toMatchObject({
      kind: "invalid",
      code: "token_contract",
      symbol: "USDT",
    });
    expect(destinationOf("0x1234", POOL)).toMatchObject({ kind: "invalid", code: "evm_format" });
    expect(destinationOf("pp1nope", POOL)).toMatchObject({ kind: "invalid", code: "privacy_invalid" });
    expect(destinationOf("hello", POOL)).toMatchObject({ kind: "invalid", code: "unknown_format" });
  });
  it("names each kind; an EVM address is checksummed; the pool's own chain named explicitly is still a public exit", () => {
    expect(destinationOf("   ", POOL)).toEqual({ kind: "empty" });
    expect(destinationOf(pp1, POOL)).toEqual({ kind: "private", address: pp1 });
    expect(destinationOf(EVM, POOL)).toEqual({ kind: "public", address: getAddress(EVM) });
    expect(destinationOf(`ethereum:${EVM}@${POOL}`, POOL)).toEqual({ kind: "public", address: getAddress(EVM) });
    expect(destinationOf(BTC, POOL)).toEqual({ kind: "bitcoin", address: BTC });
  });
  it("another chain is named — ERC-3770 short names, EIP-681 chain ids, a Solana address — never taken for the pool's", () => {
    expect(destinationOf(`base:${EVM}`, POOL)).toEqual({ kind: "other-chain", chain: "Base", chainKey: "base", address: getAddress(EVM) });
    expect(destinationOf(`ethereum:${EVM}@42161`, POOL)).toEqual({ kind: "other-chain", chain: "Arbitrum", chainKey: "arbitrum", address: getAddress(EVM) });
    expect(destinationOf(`eth:${EVM}`, POOL), "mainnet seen from a devnet pool").toMatchObject({ kind: "other-chain", chainKey: "ethereum" });
    expect(destinationOf(`eth:${EVM}`, 1), "mainnet seen from a mainnet pool").toEqual({ kind: "public", address: getAddress(EVM) });
    expect(destinationOf(`ethereum:${EVM}@999999`, POOL)).toEqual({ kind: "other-chain", chain: "chain 999999", chainKey: null, address: getAddress(EVM) });
    expect(destinationOf(`zzz:${EVM}`, POOL)).toEqual({ kind: "other-chain", chain: "zzz", chainKey: null, address: getAddress(EVM) });
    expect(destinationOf(SOL, POOL)).toEqual({ kind: "other-chain", chain: "Solana", chainKey: "solana", address: SOL });
  });
  it("what is not an address is refused with the reason", () => {
    for (const t of ["0x1234", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv", "pp1notanaddress", "hello", `base:0x1234`]) {
      const d = destinationOf(t, POOL);
      expect(d.kind, t).toBe("invalid");
      expect((d as { reason: string }).reason.length, t).toBeGreaterThan(0);
    }
    expect(destinationOf("hello", POOL)).toEqual({ kind: "invalid", reason: "not an address this wallet sends to", code: "unknown_format" });
  });
  it("the checks: four for a privacy or EVM address, two for Bitcoin; another chain fails the network; an unsupported asset fails its line", () => {
    expect(checksOf({ kind: "empty" }, true).map((c) => c.state)).toEqual(["idle", "idle", "idle", "idle"]);
    expect(checksOf({ kind: "public", address: EVM }, true).map((c) => c.state)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(checksOf({ kind: "public", address: EVM }, false).map((c) => c.state)).toEqual(["ok", "ok", "fail", "ok"]);
    expect(checksOf({ kind: "bitcoin", address: BTC }, true)).toEqual([
      { kind: "btc-address", state: "ok" },
      { kind: "btc-network", state: "ok" },
    ]);
    expect(checksOf({ kind: "other-chain", chain: "Base", chainKey: "base", address: EVM }, true).map((c) => [c.kind, c.state])).toContainEqual([
      "network",
      "fail",
    ]);
    expect(checksOf({ kind: "invalid", reason: "x" }, true).map((c) => c.state)).toEqual(["fail", "idle", "ok", "fail"]);
  });
});

describe("crossTargetOf: where a cross-chain destination continues (spec v2.0 §7.4–§7.5)", () => {
  const other = (chainKey: string | null, chain = "x"): Destination => ({ kind: "other-chain", chain, chainKey, address: EVM });
  it("the same asset on that chain, else the chain's native asset; null when the chain is out of reach — never another chain", () => {
    expect(crossTargetOf({ kind: "bitcoin", address: BTC }, "USDC")?.id).toBe("BTC");
    expect(crossTargetOf(other("base"), "ETH")?.id).toBe("ETH on Base");
    expect(crossTargetOf(other("base"), "USDC")?.id).toBe("USDC on Base");
    expect(crossTargetOf(other("base"), "DAI")?.id, "no DAI on Base: its native asset, shown before anything is confirmed").toBe("ETH on Base");
    expect(crossTargetOf(other("solana"), "USDC")?.id).toBe("SOL");
    expect(crossTargetOf(other("arbitrum"), "ETH")).toBeNull();
    expect(crossTargetOf(other(null), "ETH")).toBeNull();
    expect(crossTargetOf({ kind: "public", address: EVM }, "ETH")).toBeNull();
    expect(crossTargetOf({ kind: "private", address: pp1 }, "ETH")).toBeNull();
  });
});

describe("sendSplit: the document's send (spec v2.0 §3; doc §24)", () => {
  const terms = { minimum: usdc("4.10"), feePercentBps: 100 };
  it("2,500 USDC exact input: 25.00 privacy fee, 4.10 relayer, 2,470.90 arrives; exact output of 2,470.90 costs exactly 2,500", () => {
    expect(sendSplit(usdc("2500"), terms, false)).toEqual({
      total: usdc("2500"),
      delivered: usdc("2470.90"),
      fee: usdc("29.10"),
      privacy: usdc("25"),
      network: usdc("4.10"),
      tooSmall: false,
    });
    expect(sendSplit(usdc("2470.90"), terms, true)).toEqual({
      total: usdc("2500"),
      delivered: usdc("2470.90"),
      fee: usdc("29.10"),
      privacy: usdc("25"),
      network: usdc("4.10"),
      tooSmall: false,
    });
  });
  it("nothing typed, or too little to cover the fees, is no split", () => {
    expect(sendSplit(0n, terms, false)).toBeNull();
    expect(sendSplit(usdc("4.10"), terms, false)).toBeNull();
    expect(sendSplit(0n, terms, true)).toBeNull();
  });
});

describe("sendModel: the view-model's quote and action", () => {
  const split = sendSplit(usdc("2500"), { minimum: usdc("4.10"), feePercentBps: 100 }, false);
  const base = { asset: USDC, amount: "2500", to: "", exact: false, split, otherChainConfirmed: false };
  it("a privacy or EVM destination quotes and reviews; exact output adds what leaves the balance; a self-submitted send says who pays the network", () => {
    const m = sendModel({ ...base, to: EVM, destination: { kind: "public", address: getAddress(EVM) } });
    expect(m).toMatchObject({ destination: "public", canReview: true, action: "review", otherChain: null });
    expect(m.quote?.receive.units).toBe(usdc("2470.90"));
    expect(m.quote?.privacyFee.units).toBe(usdc("25"));
    expect(m.quote?.relayerFee.units).toBe(usdc("4.10"));
    expect(m.quote?.total).toBeUndefined();
    const exact = sendModel({
      ...base,
      amount: "2470.90",
      exact: true,
      split: sendSplit(usdc("2470.90"), { minimum: usdc("4.10"), feePercentBps: 100 }, true),
      destination: { kind: "private", address: pp1 },
    });
    expect(exact).toMatchObject({ destination: "private", canReview: true });
    expect(exact.quote?.total?.units).toBe(usdc("2500"));
    const self = sendModel({
      ...base,
      selfSubmitted: true,
      split: { total: usdc("2500"), delivered: usdc("2500"), fee: 0n, privacy: 0n, network: 0n, tooSmall: false },
      destination: { kind: "private", address: pp1 },
    });
    expect(self.quote).toMatchObject({ relayerPaidByWallet: true });
    expect(self.quote?.receive.units).toBe(usdc("2500"));
  });
  it("no split, no review; Bitcoin continues without a quote; another chain waits for its confirmation, then continues", () => {
    expect(sendModel({ ...base, split: null, destination: { kind: "public", address: EVM } })).toMatchObject({ quote: null, canReview: false });
    expect(sendModel({ ...base, destination: { kind: "bitcoin", address: BTC } })).toMatchObject({
      destination: "bitcoin",
      quote: null,
      canReview: true,
      action: "continue",
    });
    expect(sendModel({ ...base, amount: "", destination: { kind: "bitcoin", address: BTC } }).canReview, "an amount first").toBe(false);
    const other: Destination = { kind: "other-chain", chain: "Base", chainKey: "base", address: EVM };
    expect(sendModel({ ...base, destination: other })).toMatchObject({ otherChain: { chain: "Base" }, canReview: false, action: "review", quote: null });
    expect(sendModel({ ...base, destination: other, otherChainConfirmed: true })).toMatchObject({ otherChain: null, canReview: true, action: "continue" });
    expect(sendModel({ ...base, destination: { kind: "invalid", reason: "x" } })).toMatchObject({ quote: null, canReview: false, destination: null });
  });
});

describe("the progress lines (spec v2.0 §7.7; doc §58)", () => {
  type Rec = Pick<OperationRecord, "kind" | "state" | "progress" | "reason" | "declined">;
  const rec = (state: OperationRecord["state"], step?: string, kind: OperationRecord["kind"] = "send", more: Partial<Rec> = {}): Rec => ({
    kind,
    state,
    ...(step ? { progress: { step } as OperationRecord["progress"] } : {}),
    ...more,
  });
  it("the line from the engine's step before the submission and from the state after it; a protect starts at securing", () => {
    expect(PROGRESS_LINES).toEqual(["balance", "fees", "securing", "confirmation"]);
    expect(progressLineOf(rec("AWAITING_SIGNATURE"))).toBe("balance");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", "fee-terms"))).toBe("fees");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", "syncing"))).toBe("balance");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", "proof"))).toBe("securing");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", "submitting"))).toBe("confirmation");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", "submitting", "protect"))).toBe("securing");
    expect(progressLineOf(rec("AWAITING_SIGNATURE", undefined, "protect"))).toBe("securing");
    for (const s of ["SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED"] as const) expect(progressLineOf(rec(s)), s).toBe("confirmation");
  });
  it("only moves forward: the relayer's terms are read before the notes sync, and a line passed is never waiting again", () => {
    let f = 0;
    for (const step of ["fee-terms", "syncing", "verifying", "proof"]) f = furthestLine(f, rec("AWAITING_SIGNATURE", step));
    expect(PROGRESS_LINES[f]).toBe("securing");
    f = furthestLine(f, rec("AWAITING_SIGNATURE", "syncing"));
    expect(PROGRESS_LINES[f]).toBe("securing");
  });
  it("the view-model: done before the line, active on it, waiting after; failed where it stopped; all done at the end", () => {
    expect(progressModelOf(rec("AWAITING_SIGNATURE", "proof"), 2)).toEqual({
      steps: [
        { kind: "balance", state: "done" },
        { kind: "fees", state: "done" },
        { kind: "securing", state: "active" },
        { kind: "confirmation", state: "waiting" },
      ],
      fraction: 2.5 / 4,
      large: null,
    });
    expect(
      progressModelOf(rec("RECOVERY_REQUIRED", undefined, "send", { reason: { code: "relayer_unreachable", fundsClass: "unknown" } }), 3).steps.map(
        (s) => s.state,
      ),
    ).toEqual(["done", "done", "done", "failed"]);
    expect(progressModelOf(rec("REVIEW", undefined, "send", { declined: { at: 1, code: "user_rejected" } }), 0).steps[0].state).toBe("failed");
    expect(progressModelOf(rec("COMPLETED"), 3)).toMatchObject({ fraction: 1, steps: PROGRESS_LINES.map((kind) => ({ kind, state: "done" })) });
  });
});
