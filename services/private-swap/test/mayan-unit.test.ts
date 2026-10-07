// Offline checks of the Mayan helpers against the SDK's conventions.
import { describe, it, expect } from "vitest";
import { SEL_CREATE_ORDER, SEL_FORWARD_ERC20, SEL_SWAP_AND_FORWARD_ETH, addressHex32, encodeCreateOrder, fractionalToUnits, minOutBaseUnits, orderPayloadFromQuote } from "../src/adapters/mayan";
import { decodeParams, encodeParams, hexBuf } from "../src/abi";

describe("Mayan helpers (offline)", () => {
  it("selectors", () => {
    // keccak of the exact ABI signatures used by MayanForwarder / FastMCTP (SDK 15.2.2 artifacts)
    expect(SEL_SWAP_AND_FORWARD_ETH.length).toBe(10);
    expect(SEL_FORWARD_ERC20.length).toBe(10);
    expect(SEL_CREATE_ORDER.length).toBe(10);
  });
  it("fractionalToUnits matches getAmountOfFractionalAmount (max 8 fractional digits, truncation)", () => {
    expect(fractionalToUnits(22.334448494, 8)).toBe(2233444849n);
    expect(fractionalToUnits("22.334448494", 9)).toBe(22334448490n);
    expect(fractionalToUnits(0.7, 6)).toBe(700000n);
    expect(fractionalToUnits(0, 6)).toBe(0n);
  });
  it("addressHex32 pads EVM addresses and decodes Solana pubkeys", () => {
    expect(addressHex32("ethereum", "0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65").toString("hex")).toBe("0000000000000000000000002b8dc27605bf11214247ae11a013fcadf2c1cb65");
    expect(addressHex32("solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").length).toBe(32);
  });
  it("builds a createOrder payload from a quote and encodes it statically", () => {
    const q: any = { type: "FAST_MCTP", toChain: "solana", toToken: { contract: "0x0000000000000000000000000000000000000000", decimals: 9 }, minAmountOut: 22.334448494, gasDrop: 0, redeemRelayerFee: 0.21, refundRelayerFee64: "150000", circleMaxFee64: "1000", deadline64: "1791288580", fastMctpMinFinality: "1000", fastMctpMayanContract: "0x1111111111111111111111111111111111111111", fastMctpInputContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
    const { payload, destDomain, minFinality, circleMaxFee, tokenIn } = orderPayloadFromQuote(q, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(destDomain).toBe(5);
    expect(minFinality).toBe(1000);
    expect(payload.amountOutMin).toBe(2233444849n);
    expect(payload.redeemFee).toBe(210000n);
    expect(payload.refundFee).toBe(150000n);
    expect(minOutBaseUnits(q)).toBe(22334448490n);
    const cd = encodeCreateOrder(tokenIn, 10n ** 18n, circleMaxFee, destDomain, minFinality, payload);
    expect(hexBuf(cd).length).toBe(4 + 15 * 32); // fully static
    const f = decodeParams(hexBuf(cd).subarray(4), ["address", "uint", "uint", "uint", "uint", "uint", "bytes32", "bytes32", "uint", "uint", "uint", "uint", "uint", "bytes32", "uint"]);
    expect(f[0]).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(f[5]).toBe(3n); // payloadType ORDER
    expect(f[8]).toBe(2233444849n);
    expect(f[12]).toBe(1791288580n);
  });
  it("rejects non-FAST_MCTP quotes", () => {
    expect(() => orderPayloadFromQuote({ type: "SWIFT" } as any, "x")).toThrow(/FAST_MCTP only/);
  });
  it("dynamic bytes encoding is head/tail correct", () => {
    const enc = encodeParams([{ t: "uint", v: 1 }, { t: "bytes", v: "0xabcd" }, { t: "uint", v: 2 }]);
    expect(enc.length).toBe(3 * 32 + 64);
    const d = decodeParams(enc, ["uint", "bytes", "uint"]);
    expect(d[0]).toBe(1n); expect((d[1] as Buffer).toString("hex")).toBe("abcd"); expect(d[2]).toBe(2n);
  });
});
