// The fee engine of the screens (Privacy Wallet Web spec v2.0 §3): a send's lines and its one number in both directions
// (the document's 2,500 USDC → 2,470.90), a withdrawal's "Maximum you pay", a swap's privacy fee on the input with the
// relayer/network cost and the executor's gas, the provider's cost and the market rate & impact that makes the lines
// add up, a protect's 1 % through ProtectRouter, and the relayer client's fee note from the terms.
import { describe, expect, it } from "vitest";
import { formatUnits } from "viem";
import { feeForWithdrawal, feeMeetsTerms } from "@privacy-wallet/protocol/wallet/fees";
import { protectFees, sendFees, swapFees } from "../src/features/fees/feeEngine";
import { feeInVault, type RelayerInfo } from "@privacy-wallet/sdk/relayer";
import { t } from "../src/app/i18n/messages";

const fmt = (units: bigint) => `${formatUnits(units, 6)} USDC`;
const fmtEth = (u: bigint) => `${formatUnits(u, 18)} ETH`;
const fmtBtc = (u: bigint) => `${formatUnits(u, 8)} BTC`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const terms = { minimum: 4_100_000n, feePercentBps: 100 }; // F = 4.10 USDC, 1.00 %
const lines = (v: { lines: { label: string; value: string }[] }) => v.lines.map((l) => [l.label, l.value]);

describe("a send (spec §3)", () => {
  it("exact input, the default: 2,500 USDC pays 25 + 4.10 in one fee note and 2,470.90 arrives", () => {
    const v = sendFees({ mode: "exact-input", amount: 2_500_000_000n, terms, format: fmt, t });
    expect(v.receive).toEqual({ label: "Recipient receives", value: "2470.9 USDC" });
    expect(v.pay).toEqual({ label: "You send", value: "2500 USDC" });
    expect(v.total).toBe("29.1 USDC");
    expect(lines(v)).toEqual([
      ["Privacy fee (1.00 %)", "25 USDC"],
      ["Relayer / network", "4.1 USDC"],
    ]);
    expect(v.split).toEqual({ total: 2_500_000_000n, delivered: 2_470_900_000n, fee: 29_100_000n });
    expect(v.tooSmall).toBe(false);
  });
  it("exact output: exactly 2,500 arrives from the least input, the fee its 1 % plus the relayer's", () => {
    const v = sendFees({ mode: "exact-output", amount: 2_500_000_000n, terms, format: fmt, t });
    expect(v.receive.value).toBe("2500 USDC");
    expect(v.pay).toEqual({ label: "You pay", value: "2529.39394 USDC" });
    expect(lines(v)).toEqual([
      ["Privacy fee (1.00 %)", "25.29394 USDC"],
      ["Relayer / network", "4.1 USDC"],
    ]);
    expect(v.split.total - v.split.fee).toBe(2_500_000_000n);
  });
  it("a withdrawal says Maximum you pay; without a percentage the relayer's line stands alone", () => {
    const v = sendFees({ mode: "exact-output", amount: 2_500_000_000n, terms: { ...terms, feePercentBps: 0 }, withdrawal: true, format: fmt, t });
    expect(v.pay).toEqual({ label: "Maximum you pay", value: "2504.1 USDC" });
    expect(lines(v)).toEqual([["Relayer / network", "4.1 USDC"]]);
  });
  it("an amount that does not cover the fees delivers nothing and says so", () => {
    const v = sendFees({ mode: "exact-input", amount: 4_100_000n, terms, format: fmt, t });
    expect(v.tooSmall).toBe(true);
    expect(v.receive.value).toBe("0 USDC");
  });
});

describe("a swap (spec §3)", () => {
  const ethTerms = { minimum: 1_100_000_000_000_000n, feePercentBps: 100 }; // F = 0.0011 ETH
  const base = {
    amount: 3n * 10n ** 18n,
    terms: ethTerms,
    executorTip: 2_000_000_000_000_000n,
    toAmount: 11_850_000n,
    toAmountMin: 11_700_000n,
    formatFrom: fmtEth,
    formatTo: fmtBtc,
    formatUsd: usd,
    t,
  };
  it("the privacy fee on what goes in, the relayer/network with the executor's gas, the provider's cost, the market rate & impact", () => {
    const v = swapFees({ ...base, providerUsd: 8.2, networkUsd: 5.8, usdPerUnit: { from: 4_000 / 1e18, to: 100_000 / 1e8 } });
    expect(lines(v)).toEqual([
      ["Privacy fee (1.00 %)", "0.03 ETH"],
      ["Relayer / network", "0.0031 ETH"], // F 0.0011 + the execution's gas 0.002
      ["Swap / provider", "$14.00"],
      ["Market rate & impact", "$3.60"], // (W − T) at $4,000 − $14 − 0.1185 BTC at $100,000
    ]);
    expect(v.receive).toEqual({ label: "You'll receive at least", value: "0.117 BTC" });
    expect(v.pay).toEqual({ label: "Estimated receive", value: "0.1185 BTC" });
    expect(v.total).toBe("0.0331 ETH + $14.00");
    expect(v.split).toEqual({ total: 3n * 10n ** 18n, delivered: 2_968_900_000_000_000_000n, fee: 33_100_000_000_000_000n });
  });
  it("unvalued: the provider's line in units, no market line, the total in the input's asset", () => {
    const v = swapFees({ ...base, providerUsd: null, networkUsd: null, unvalued: "0.0012 BTC" });
    expect(lines(v)).toEqual([
      ["Privacy fee (1.00 %)", "0.03 ETH"],
      ["Relayer / network", "0.0031 ETH"],
      ["Swap / provider", "0.0012 BTC"],
    ]);
    expect(v.total).toBe("0.0331 ETH");
  });
  it("an input whose escrow could not even pay the executor is too small", () => {
    expect(swapFees({ ...base, amount: 2_000_000_000_000_000n, providerUsd: null, networkUsd: null }).tooSmall).toBe(true);
  });
});

describe("a protect (spec §3, §11.1)", () => {
  it("1 % through ProtectRouter: the note holds the rest; the user's own network cost at the live price", () => {
    const v = protectFees({ amount: 84n * 10n ** 16n, fee: 84n * 10n ** 14n, feePercentBps: 100, networkUsd: 3.84, format: fmtEth, formatUsd: usd, t });
    expect(v.receive).toEqual({ label: "You receive", value: "0.8316 ETH" });
    expect(lines(v)).toEqual([
      ["Privacy fee (1.00 %)", "0.0084 ETH"],
      ["Relayer / network", "≈ $3.84"],
    ]);
    expect(v.total).toBe("0.0084 ETH + ≈ $3.84");
  });
  it("a deployment without a router: no fee line; the network cost read at confirmation when unpriced", () => {
    const v = protectFees({ amount: 84n * 10n ** 16n, fee: 0n, feePercentBps: 100, networkUsd: null, format: fmtEth, formatUsd: usd, t });
    expect(lines(v)).toEqual([["Relayer / network", "read at confirmation"]]);
    expect(v.total).toBe("read at confirmation");
  });
});

describe("the relayer client's fee note (spec §3)", () => {
  const info = {
    chainId: 1,
    core: "0x" + "01".repeat(20),
    feeVault: "0x" + "02".repeat(20),
    relayer: "0x" + "03".repeat(20),
    privacyAddress: "pp1x",
    minFeeWei: "1000000000000000",
    gasPriceWei: "1",
    gasEstimate: "1",
    feeMarginBps: 0,
    requireReadableFeePayload: true,
    inflight: 0,
    feePercentBps: 100,
    feeMinimumWei: "1000000000000000",
    feeVaults: [{ vault: "0x" + "04".repeat(20), symbol: "USDC", decimals: 6, minFee: "2000000" }],
  } as unknown as RelayerInfo;
  const eth = ("0x" + "02".repeat(20)) as `0x${string}`;
  const usdc = ("0x" + "04".repeat(20)) as `0x${string}`;
  it("the minimum with the wallet's 10 % margin without a public amount; with one, the percentage of what leaves on top", () => {
    expect(feeInVault(info, eth)).toBe(1_100_000_000_000_000n);
    const f = feeInVault(info, eth, 1000, 10n ** 18n)!;
    expect(f).toBe(feeForWithdrawal(10n ** 18n, { minimum: 1_100_000_000_000_000n, feePercentBps: 100 }));
    expect(feeMeetsTerms(10n ** 18n, f, 100, 10n ** 15n).ok, "the relayer accepts it").toBe(true);
    expect(feeInVault(info, usdc, 1000, 5_000_000_000n), "in the token's units").toBe(52_727_273n);
  });
  it("an older relayer states no percentage: the minimum alone; a vault it takes no fees in: none", () => {
    expect(feeInVault({ ...info, feePercentBps: undefined }, eth, 1000, 10n ** 18n)).toBe(1_100_000_000_000_000n);
    expect(feeInVault(info, ("0x" + "09".repeat(20)) as `0x${string}`, 1000, 10n ** 18n)).toBeNull();
  });
});
