// Home's states for the screenshot fixtures (spec v2.0 §7.1, §19): connected with nothing protected; has assets (the
// spec's own figures); an operation executing; action needed with the funds safe; action needed while the wallet is
// still checking on the funds; the Advanced experience's lines. Static data only.
import type { Amount } from "../viewKit";
import type { HomeModel } from "./View";

const a = (units: bigint, symbol: string, decimals: number, displayDecimals: number): Amount => ({ units, symbol, decimals, displayDecimals });
const ETH = (x: bigint) => a(x, "ETH", 18, 6);
const USDC = (x: bigint) => a(x, "USDC", 6, 2);
const USDT = (x: bigint) => a(x, "USDT", 6, 2);

const funded: HomeModel = {
  protection: "high",
  balance: { usdCents: 2_438_241n, state: "valued" },
  assets: [
    { amount: ETH(4_820_000_000_000_000_000n), name: "Ethereum", usdCents: 988_241n },
    { amount: USDC(12_400_000_000n), name: "USD Coin", usdCents: 1_240_000n },
    { amount: USDT(2_100_000_000n), name: "Tether USD", usdCents: 210_000n },
  ],
  operations: [],
  recent: [
    { id: "r1", title: "USDC → ETH", amount: USDC(8_200_000_000n), usdCents: 820_000n, status: "completed" },
    { id: "r2", title: "Private Send", amount: USDC(1_200_000_000n), usdCents: 120_000n, status: "completed" },
    { id: "r3", title: "Protected USDC", amount: USDC(5_000_000_000n), usdCents: 500_000n, status: "completed" },
  ],
  returning: null,
  advanced: null,
};

export const HOME_FIXTURES = {
  empty: {
    protection: "high",
    balance: { usdCents: 0n, state: "valued" },
    assets: [],
    operations: [],
    recent: [],
    returning: null,
    advanced: null,
  } satisfies HomeModel,
  funded,
  executing: {
    ...funded,
    operations: [{ id: "op-1", title: "ETH → BTC", amount: ETH(3_550_000_000_000_000_000n), usdCents: 1_240_000n, status: "executing", fundsSafe: true }],
    returning: "Your ETH → BTC swap is still executing.",
  } satisfies HomeModel,
  "action-needed": {
    ...funded,
    operations: [{ id: "op-2", title: "ETH → BTC", amount: ETH(3_550_000_000_000_000_000n), usdCents: 1_240_000n, status: "action-needed", fundsSafe: true }],
  } satisfies HomeModel,
  checking: {
    ...funded,
    protection: "medium",
    operations: [{ id: "op-3", title: "USDC → BTC", amount: USDC(12_000_000_000n), usdCents: 1_200_000n, status: "action-needed", fundsSafe: false }],
  } satisfies HomeModel,
  advanced: {
    ...funded,
    advanced: ["Protected balance maintenance: 2 merges planned.", "Core 0x5F…0aa3 · 1,204 notes in the pool"],
  } satisfies HomeModel,
} as const;
