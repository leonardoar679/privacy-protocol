// The flow screens' states for the screenshot fixtures (spec v2.0 §7.3–§7.9, §19; doc §86–§87): Protect 5,000 USDC →
// 4,950; Send 2,500 USDC → 2,470.90 to an EVM address, to Bitcoin, to an address of another chain; Swap 8,000 USDC →
// ≈ 2.31 ETH into the protected balance, $12,000 of ETH → BTC, an expired quote; the Reviews of a $10,000 USDC → ETH
// swap (doc §86), a cross-chain swap, an $80,000 protected execution (doc §87), a Protect, a Send and a blocker; the
// progress of a standard and of a large operation. Static data only: the figures are the spec's.
import type { ProtectModel } from "./protect/View";
import type { SendModel } from "./send/View";
import type { SwapModel } from "./swap/View";
import type { ReviewModel } from "./review/View";
import type { ProgressModel } from "./progress/View";
import { BTC, ETH, USDC, usd } from "./fixtureAmounts";
import { t } from "../app/i18n/messages";

const ACCOUNT = "0x7A3b5d0E91c4F2a6B8d1E3f5A7c9B2d4E6f891F2";
const EVM_TO = "0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1";
const BTC_TO = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx82c1";

export const PROTECT_FIXTURES = {
  filled: {
    source: { account: ACCOUNT, balance: USDC("5210") },
    asset: { symbol: "USDC", decimals: 6 },
    amount: "5000",
    quote: { receive: USDC("4950"), privacyFee: USDC("50"), networkUsdCents: usd("4.30") },
    error: null,
  },
  insufficient: {
    source: { account: ACCOUNT, balance: USDC("5210") },
    asset: { symbol: "USDC", decimals: 6 },
    amount: "6000",
    quote: null,
    error: "insufficient",
  },
} satisfies Record<string, ProtectModel>;

const okChecks = (kinds: SendModel["checks"][number]["kind"][]): SendModel["checks"] => kinds.map((kind) => ({ kind, state: "ok" as const }));
export const SEND_FIXTURES = {
  evm: {
    asset: { symbol: "USDC", decimals: 6 },
    amount: "2500",
    to: EVM_TO,
    checks: okChecks(["valid", "network", "asset", "format"]),
    destination: "public",
    exact: false,
    quote: { receive: USDC("2470.90"), privacyFee: USDC("25"), relayerFee: USDC("4.10") },
  },
  bitcoin: {
    asset: { symbol: "USDC", decimals: 6 },
    amount: "2500",
    to: BTC_TO,
    checks: okChecks(["btc-address", "btc-network"]),
    destination: "bitcoin",
    exact: false,
    // V6 Stage 10: a Bitcoin destination continues as a cross-chain send — the swap quotes it, this page does not
    quote: null,
    canReview: true,
    action: "continue",
  },
  "other-chain": {
    asset: { symbol: "USDC", decimals: 6 },
    amount: "2500",
    to: EVM_TO,
    checks: [
      { kind: "valid", state: "ok" },
      { kind: "network", state: "fail" },
      { kind: "asset", state: "ok" },
      { kind: "format", state: "ok" },
    ],
    destination: null,
    exact: false,
    quote: null, // nothing is quoted before the network is confirmed
    canReview: false,
    otherChain: { chain: "Base" },
  },
} satisfies Record<string, SendModel>;

export const SWAP_FIXTURES = {
  "same-chain": {
    pay: { symbol: "USDC", decimals: 6, amount: "8000", balance: USDC("12400") },
    receive: { symbol: "ETH", chain: "Ethereum" },
    quote: { kind: "same-chain", expected: ETH("2.31"), minimum: ETH("2.28"), protection: "high", feesUsdCents: usd("91.80"), eta: [90, 150] },
  },
  "cross-chain": {
    pay: { symbol: "ETH", decimals: 18, amount: "3.55", balance: ETH("4.82") },
    receive: { symbol: "BTC", chain: "Bitcoin" },
    quote: {
      kind: "cross-chain",
      expected: BTC("0.178"),
      minimum: BTC("0.176"),
      protection: "high",
      fees: { privacyUsdCents: usd("120"), relayerUsdCents: usd("18.40"), providerUsdCents: usd("24.10") },
      eta: [120, 300],
    },
    destination: { value: BTC_TO, fresh: false, checks: { valid: "ok", network: "ok", compatible: "ok" } },
    expiresIn: 45,
  },
  // V6 Stage 16 (doc §29, §54): the Advanced experience's route details — folded in the quote on a phone, beside the
  // swap card from 1024 px
  advanced: {
    pay: { symbol: "ETH", decimals: 18, amount: "3.55", balance: ETH("4.82") },
    receive: { symbol: "BTC", chain: "Bitcoin" },
    quote: {
      kind: "cross-chain",
      expected: BTC("0.178"),
      minimum: BTC("0.176"),
      protection: "high",
      fees: { privacyUsdCents: usd("120"), relayerUsdCents: usd("18.40"), providerUsdCents: usd("24.10") },
      eta: [120, 300],
    },
    destination: { value: BTC_TO, fresh: false, checks: { valid: "ok", network: "ok", compatible: "ok" } },
    expiresIn: 45,
    details: { provider: "THORChain", route: "ETH → BTC", expected: BTC("0.178"), fee: "$162.50", time: "2–5 min", risk: "Low", privacy: "High" },
  },
  expired: {
    pay: { symbol: "USDC", decimals: 6, amount: "8000", balance: USDC("12400") },
    receive: { symbol: "ETH", chain: "Ethereum" },
    quote: null,
    expired: true,
  },
} satisfies Record<string, SwapModel>;

export const REVIEW_FIXTURES = {
  // doc §86: a $10,000 USDC → ETH swap — every amount, every fee, the destination, the protection, the confirmation
  swap: {
    kind: "swap",
    pay: { usdCents: usd("10000"), amount: USDC("10000") },
    receive: { amount: ETH("2.886"), approx: true },
    minimum: ETH("2.857"),
    fees: [
      { kind: "privacy", usdCents: usd("100.00") },
      { kind: "relayer", usdCents: usd("4.10") },
      { kind: "provider", usdCents: usd("9.90") },
    ],
    totalFeesUsdCents: usd("114.00"),
    destination: {
      get label() {
        return t("screen.swap.protectedBalance");
      },
      verified: false,
    },
    protection: "high",
    large: false,
  },
  "cross-chain": {
    kind: "cross-chain",
    pay: { usdCents: usd("12000"), amount: ETH("3.55") },
    receive: { amount: BTC("0.178"), approx: true },
    minimum: BTC("0.176"),
    fees: [
      { kind: "privacy", usdCents: usd("120") },
      { kind: "relayer", usdCents: usd("18.40") },
      { kind: "provider", usdCents: usd("24.10") },
    ],
    totalFeesUsdCents: usd("162.50"),
    destination: { label: "bc1q…82c1", verified: true },
    protection: "high",
    large: false,
  },
  // doc §87: $80,000 — the protection is automatic, the four checks, Hold to Confirm, no mode to choose
  large: {
    kind: "cross-chain",
    pay: { usdCents: usd("80000"), amount: ETH("23.66") },
    receive: { amount: BTC("1.186"), approx: true },
    minimum: BTC("1.172"),
    fees: [
      { kind: "privacy", usdCents: usd("800") },
      { kind: "relayer", usdCents: usd("73.60") },
      { kind: "provider", usdCents: usd("96.40") },
    ],
    totalFeesUsdCents: usd("970.00"),
    destination: { label: "bc1q…82c1", verified: true },
    protection: "high",
    large: true,
    routeHealthy: true, // the eleventh review round (2026-11-04, E11-12): the card ticks the route only on its health read
  },
  protect: {
    kind: "protect",
    pay: { usdCents: usd("5000"), amount: USDC("5000") },
    receive: { amount: USDC("4950"), approx: false },
    fees: [
      { kind: "privacy", usdCents: null, amount: USDC("50") },
      { kind: "relayer", usdCents: usd("4.30") },
    ],
    totalFeesUsdCents: usd("54.30"),
    destination: {
      get label() {
        return t("screen.swap.protectedBalance");
      },
      verified: false,
    },
    protection: "high",
    large: false,
  },
  send: {
    kind: "send",
    pay: { usdCents: usd("2500"), amount: USDC("2500") },
    receive: { amount: USDC("2470.90"), approx: false },
    fees: [
      { kind: "privacy", usdCents: null, amount: USDC("25") },
      { kind: "relayer", usdCents: null, amount: USDC("4.10") },
    ],
    totalFeesUsdCents: usd("29.10"),
    destination: { label: "0x43…82C1", verified: true },
    protection: "high",
    large: false,
  },
  blocked: {
    kind: "swap",
    pay: { usdCents: usd("10000"), amount: USDC("10000") },
    receive: { amount: ETH("2.886"), approx: true },
    fees: [],
    totalFeesUsdCents: null,
    destination: {
      get label() {
        return t("screen.swap.protectedBalance");
      },
      verified: false,
    },
    protection: "high",
    large: false,
    blocked: "parameters_changed",
  },
} satisfies Record<string, ReviewModel>;

export const PROGRESS_FIXTURES = {
  standard: {
    steps: [
      { kind: "balance", state: "done" },
      { kind: "fees", state: "done" },
      { kind: "securing", state: "active" },
      { kind: "confirmation", state: "waiting" },
    ],
    fraction: 0.62,
  },
  large: {
    steps: [
      { kind: "balance", state: "done" },
      { kind: "fees", state: "done" },
      { kind: "securing", state: "done" },
      { kind: "confirmation", state: "active" },
    ],
    fraction: 0.5,
    large: {
      title: "ETH → BTC",
      totalUsdCents: usd("80000"),
      completedUsdCents: usd("20000"),
      executingUsdCents: usd("20000"),
      remainingUsdCents: usd("40000"),
    },
  },
} satisfies Record<string, ProgressModel>;
