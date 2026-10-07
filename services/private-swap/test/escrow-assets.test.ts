// What an order's escrow can re-shield (src/escrowAssets.ts, spec §7, PP-S08): through refund() its own
// asset (an ETH order also unwraps WETH), through refundToken() a token the pool has a vault for. A
// route that can pay anything else back to the escrow is refused; the foreign token of a route that is
// accepted is what the executor re-shields through refundToken. Offline.
import { describe, it, expect } from "vitest";
import { escrowCanReshield, foreignRefundTokens, pooledTokens } from "../src/escrowAssets";
import type { AssetRef } from "../src/types";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ZERO = "0x0000000000000000000000000000000000000000";
const pooled = pooledTokens(`${USDT}:0x0000000000000000000000000000000000000a11`);

describe("what an escrow can re-shield (spec §7, PP-S08)", () => {
  it("through refund(): the order's asset; an ETH order also its native form and WETH", () => {
    expect([ZERO, WETH, WETH.toLowerCase()].map((t) => escrowCanReshield(ETH, t, new Set()))).toEqual([true, true, true]);
    expect(escrowCanReshield(USDC, USDC.asset.toLowerCase(), new Set())).toBe(true);
    expect(escrowCanReshield(USDC, WETH, new Set()), "a USDC order does not unwrap WETH").toBe(false);
  });
  it("through refundToken(): a token the pool has a vault for, and nothing else", () => {
    expect(escrowCanReshield(ETH, USDT, new Set())).toBe(false);
    expect(escrowCanReshield(ETH, USDT, pooled)).toBe(true);
    expect(escrowCanReshield(USDC, ZERO, pooled), "native value is never a token").toBe(false);
  });
  it("the foreign tokens of a route are those refund() does not take", () => {
    expect(foreignRefundTokens(ETH, [ZERO, WETH, USDT, USDT.toLowerCase()])).toEqual([USDT.toLowerCase()]);
    expect(foreignRefundTokens(USDC, [USDC.asset, WETH])).toEqual([WETH.toLowerCase()]);
  });
  it("ERC20_VAULTS entries that are not token:vault addresses are ignored", () => {
    expect([...pooledTokens(` ${USDT}:0xv , nonsense, :0x12, 0x123:0x456`)]).toEqual([USDT.toLowerCase()]);
    expect(pooledTokens("").size).toBe(0);
  });
});
