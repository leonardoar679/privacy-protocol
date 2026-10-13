// The fee engine of the screens (spec §10, §3.4–§3.6): a send's lines and its one number in both directions, a
// withdrawal's "Maximum you pay", a swap's tip beside the provider's cost (never the tip twice), a protect's
// "none now", and the relayer client's percentage fee from the terms.
import { describe, expect, it } from "vitest";
import { formatUnits } from "viem";
import { protectFees, sendFees, swapFees } from "../src/features/fees/feeEngine";
import { feeInVault, type RelayerInfo } from "../src/sdk/relayer";
import { t } from "../src/app/i18n/messages";

const fmt = (units: bigint) => `${formatUnits(units, 6)} USDC`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const terms = { minimum: 4_100_000n, feePercentBps: 100 }; // F ≈ 4.10 USDC, 1.00 %

describe("the fee engine (spec §10)", () => {
  it("a send, exact-output (plan §15): Recipient receives is the typed amount; the privacy fee and the relayer are shown apart; the relayer is included when the percentage covers it", () => {
    const v = sendFees({ mode: "exact-output", amount: 2_500_000_000n, terms, format: fmt, t });
    expect(v.receive).toEqual({ label: "Recipient receives", value: "2500 USDC" });
    expect(v.pay).toEqual({ label: "You pay", value: "2525 USDC" });
    expect(v.total).toBe("25 USDC");
    expect(v.lines.map((l) => [l.label, l.value, l.hint ?? null])).toEqual([["Privacy fee (1.00 %)", "25 USDC", null], ["Relayer / network", "4.1 USDC", "included"]]);
    expect(v.split).toEqual({ total: 2_525_000_000n, delivered: 2_500_000_000n, fee: 25_000_000n });
  });
  it("a small send: the relayer's minimum is the fee and is not 'included'", () => {
    const v = sendFees({ mode: "exact-output", amount: 100_000_000n, terms, format: fmt, t });
    expect(v.total).toBe("4.1 USDC");
    expect(v.lines[1].hint).toBeUndefined();
  });
  it("a send, exact-input: the typed amount leaves the balance and the recipient gets the rest", () => {
    const v = sendFees({ mode: "exact-input", amount: 2_525_000_000n, terms, format: fmt, t });
    expect(v.receive.value).toBe("2500 USDC");
    expect(v.pay).toEqual({ label: "You send", value: "2525 USDC" });
  });
  it("a withdrawal says Maximum you pay; without a percentage there is no privacy line", () => {
    const v = sendFees({ mode: "exact-output", amount: 2_500_000_000n, terms: { ...terms, feePercentBps: 0 }, withdrawal: true, format: fmt, t });
    expect(v.pay?.label).toBe("Maximum you pay");
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0].label).toBe("Relayer / network");
  });
  it("a swap: the executor tip is the privacy fee, the provider's and network's costs beside it in USD when valued, the units line otherwise", () => {
    const fmtEth = (u: bigint) => `${formatUnits(u, 18)} ETH`;
    const fmtBtc = (u: bigint) => `${formatUnits(u, 8)} BTC`;
    const valued = swapFees({ amount: 3n * 10n ** 18n, tipBps: 25, toAmount: 18_000_000n, toAmountMin: 17_600_000n, providerUsd: 8.2, networkUsd: 5.8, formatFrom: fmtEth, formatTo: fmtBtc, formatUsd: usd, t });
    expect(valued.lines).toEqual([{ label: "Privacy fee (0.25 %)", value: "0.0075 ETH" }, { label: "Swap / provider", value: "$14.00" }]);
    expect(valued.receive).toEqual({ label: "You'll receive at least", value: "0.176 BTC" });
    expect(valued.pay).toEqual({ label: "Estimated receive", value: "0.18 BTC" });
    expect(valued.total).toBe("0.0075 ETH + $14.00");
    const unvalued = swapFees({ amount: 3n * 10n ** 18n, tipBps: 25, toAmount: 18_000_000n, toAmountMin: 17_600_000n, providerUsd: null, networkUsd: null, unvalued: "0.0012 BTC", formatFrom: fmtEth, formatTo: fmtBtc, formatUsd: usd, t });
    expect(unvalued.lines[1]).toEqual({ label: "Swap / provider", value: "0.0012 BTC" });
    expect(unvalued.total).toBe("0.0075 ETH");
  });
  it("a protect: no fee note — none now, the percentage later — and the network cost at the live price or 'read at confirmation'", () => {
    const fmtEth = (u: bigint) => `${formatUnits(u, 18)} ETH`;
    const v = protectFees({ amount: 84n * 10n ** 16n, feePercentBps: 100, networkUsd: 3.84, format: fmtEth, formatUsd: usd, t });
    expect(v.receive).toEqual({ label: "You will receive", value: "≈ 0.84 ETH" });
    expect(v.lines).toEqual([{ label: "Service fee", value: "none now · 1.00 % applies when you send or swap privately" }, { label: "Network / relayer", value: "≈ $3.84" }]);
    expect(v.total).toBe("≈ $3.84");
    expect(protectFees({ amount: 1n, feePercentBps: 100, networkUsd: null, format: fmtEth, formatUsd: usd, t }).total).toBe("read at confirmation");
  });
  it("the relayer client: the percentage of the delivered amount from the terms, never below the minimum; the minimum alone without a delivered amount or a percentage", () => {
    const info = { chainId: 1, core: "0x" + "01".repeat(20), feeVault: "0x" + "02".repeat(20), relayer: "0x" + "03".repeat(20), privacyAddress: "pp1x", minFeeWei: "1000000000000000", gasPriceWei: "1", gasEstimate: "1", feeMarginBps: 0, requireReadableFeePayload: true, inflight: 0, feePercentBps: 100, feeMinimumWei: "1000000000000000", feeVaults: [{ vault: "0x" + "04".repeat(20), symbol: "USDC", decimals: 6, minFee: "2000000" }] } as unknown as RelayerInfo;
    const eth = ("0x" + "02".repeat(20)) as `0x${string}`;
    const usdc = ("0x" + "04".repeat(20)) as `0x${string}`;
    expect(feeInVault(info, eth)).toBe(1_100_000_000_000_000n); // the minimum with the 10 % margin
    expect(feeInVault(info, eth, 1000, 10n ** 18n)).toBe(10_000_000_000_000_000n); // 1 % of 1 ETH beats the minimum
    expect(feeInVault(info, eth, 1000, 10n ** 16n)).toBe(1_100_000_000_000_000n); // 1 % of 0.01 ETH does not
    expect(feeInVault(info, usdc, 1000, 5_000_000_000n)).toBe(50_000_000n); // in the token's units
    expect(feeInVault({ ...info, feePercentBps: undefined }, eth, 1000, 10n ** 18n), "an older relayer states no percentage").toBe(1_100_000_000_000_000n);
    expect(feeInVault(info, ("0x" + "09".repeat(20)) as `0x${string}`, 1000, 10n ** 18n)).toBeNull();
  });
});
