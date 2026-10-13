// The fee line of a quote (whale spec §2, §23): USD when every fee carries it; otherwise each fee in its own asset,
// formatted by the unit the adapter stated. A fee whose unit is unknown is never shown as a base-unit figure (the
// local-stack browser run showed "2047477191 Ethereum.USDC" for a 2,047.48 USDC network fee before this was fixed).
import { describe, it, expect } from "vitest";
import { feeSummary, type ServiceQuote } from "@privacy-wallet/sdk/swapService";

const quote = (fees: ServiceQuote["fees"]): ServiceQuote => ({ provider: "chainflip", category: "A", toAmount: "1", toAmountMin: "1", fees, etaSeconds: 60, expiresAt: 0, nativeAssets: true, minOutEncoded: true } as ServiceQuote);

describe("feeSummary", () => {
  it("no fees: included in the rate", () => {
    expect(feeSummary(quote([]))).toBe("included in the rate");
    expect(feeSummary(quote(undefined))).toBe("included in the rate");
  });
  it("USD on every fee: the total in USD", () => {
    expect(feeSummary(quote([{ kind: "network", amount: "1", asset: "ETH", decimals: 18, usd: 1.25 }, { kind: "protocol", amount: "2", asset: "USDC", decimals: 6, usd: 2 }]))).toBe("$3.25");
  });
  it("units with a stated decimals: each fee in its asset, zero fees dropped", () => {
    expect(feeSummary(quote([
      { kind: "gas", amount: "0", asset: "ETH", decimals: 18 },
      { kind: "protocol", amount: "2047477191", asset: "USDC", decimals: 6 },
      { kind: "network", amount: "524", asset: "BTC", decimals: 8 },
    ]))).toBe("2047.477191 USDC + 0.00000524 BTC");
    expect(feeSummary(quote([{ kind: "gas", amount: "0", asset: "ETH", decimals: 18 }]))).toBe("included in the rate");
  });
  it("a fee without a unit is never shown raw", () => {
    expect(feeSummary(quote([{ kind: "protocol", amount: "2047477191", asset: "Ethereum.USDC" }]))).toBe("n/a");
    expect(feeSummary(quote([{ kind: "protocol", amount: "2047477191", asset: "Ethereum.USDC" }, { kind: "network", amount: "524", asset: "BTC", decimals: 8 }]))).toBe("n/a");
  });
});
