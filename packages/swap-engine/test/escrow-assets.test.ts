// What an order's escrow can re-shield (src/escrowAssets.ts, spec §7, PP-S08): through refund() its own
// asset (an ETH order also unwraps WETH), through refundToken() for an ERC-20 order ETH and WETH as ETH,
// and a token the pool has a vault for. A route that can pay anything else back to the escrow is
// refused; the foreign asset of a route that is accepted is what the executor re-shields through
// refundToken. Offline.
import { describe, it, expect } from "vitest";
import { covers, escrowCanReshield, foreignRefundTokens, pooledTokens, reshieldableAsset, sameAsset } from "../src/escrowAssets";
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
  });
  it("through refundToken(): for an ERC-20 order ETH and WETH, as ETH with no WETH vault; otherwise a token the pool has a vault for, and nothing else", () => {
    expect([ZERO, WETH, WETH.toLowerCase()].map((t) => escrowCanReshield(USDC, t, new Set())), "a USDC order re-shields ETH, and WETH unwrapped, into the native vault").toEqual([true, true, true]);
    expect(escrowCanReshield(ETH, USDT, new Set())).toBe(false);
    expect(escrowCanReshield(ETH, USDT, pooled)).toBe(true);
    expect(escrowCanReshield(USDC, USDT, new Set())).toBe(false);
    expect(escrowCanReshield(USDC, USDT, pooled)).toBe(true);
  });
  it("the foreign assets of a route are those refund() does not take; address(0), the escrow's ETH, is listed for an ERC-20 order", () => {
    expect(foreignRefundTokens(ETH, [ZERO, WETH, USDT, USDT.toLowerCase()])).toEqual([USDT.toLowerCase()]);
    expect(foreignRefundTokens(USDC, [USDC.asset, WETH])).toEqual([WETH.toLowerCase()]);
    expect(foreignRefundTokens(USDC, [ZERO, USDC.asset])).toEqual([ZERO]);
  });
  it("what a re-shieldable token is, for the floor of a swap before a bridge: ETH and WETH as ETH, the order's own asset, a pooled token this engine knows (audit 2026-10-16)", () => {
    expect([ZERO, WETH].map((t) => reshieldableAsset(ETH, t, pooled))).toEqual([{ symbol: "ETH", decimals: 18 }, { symbol: "ETH", decimals: 18 }]);
    expect(reshieldableAsset(USDC, WETH, new Set()), "a USDC order re-shields WETH as ETH").toEqual({ symbol: "ETH", decimals: 18 });
    expect(reshieldableAsset(USDC, USDC.asset, new Set())).toEqual({ symbol: "USDC", decimals: 6 });
    expect(reshieldableAsset(ETH, USDT, pooled)).toEqual({ symbol: "USDT", decimals: 6 });
    expect(reshieldableAsset(ETH, USDT, new Set()), "not pooled: it does not re-shield").toBeUndefined();
    const other = "0x00000000000000000000000000000000000000aa";
    expect(reshieldableAsset(ETH, other, pooledTokens(`${other}:0x0000000000000000000000000000000000000a11`)), "pooled, but not a token this engine knows").toBeUndefined();
    // ETH and WETH are one asset, and so are the dollar stablecoins (LI.FI routes USDC on Base through a USDT deposit); nothing else mixes
    expect([sameAsset("WETH", "ETH"), sameAsset("eth", "ETH"), sameAsset("usdc", "USDC"), sameAsset("USDT", "USDC"), sameAsset("USDC", "ETH"), sameAsset("WETH", "USDT"), sameAsset("WBTC", "BTC"), sameAsset("DAI", "USDC")]).toEqual([true, true, true, true, false, false, false, false]);
  });
  it("a floor covers an output of the same asset in their own decimals, exactly (audit 2026-10-16)", () => {
    expect(covers(2_593_233_999n, 6, 2_573_849_471n, 6)).toBe(true);
    expect(covers(2_573_849_471n, 6, 2_573_849_471n, 6)).toBe(true);
    expect(covers(1n, 6, 2_573_849_471n, 6)).toBe(false);
    expect(covers(10n ** 6n, 6, 10n ** 18n, 18), "one USDC (6 decimals) covers one USDC counted in 18").toBe(true);
    expect(covers(10n ** 6n - 1n, 6, 10n ** 18n, 18)).toBe(false);
    expect(covers(10n ** 18n, 18, 10n ** 6n, 6)).toBe(true);
    expect(covers(10n ** 18n, 18, 10n ** 6n + 1n, 6)).toBe(false);
  });
  it("ERC20_VAULTS entries that are not token:vault addresses are ignored", () => {
    expect([...pooledTokens(` ${USDT}:0xv , nonsense, :0x12, 0x123:0x456`)]).toEqual([USDT.toLowerCase()]);
    expect(pooledTokens("").size).toBe(0);
  });
});
