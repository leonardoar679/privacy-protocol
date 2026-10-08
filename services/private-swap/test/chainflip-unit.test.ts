// Offline checks of the Chainflip helpers against a calldata the public backend emitted on 2026-10-06
// for: 1 ETH -> BTC, dest bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq, refund 0x2b8D…1Cb65, retry 100 blocks,
// minPriceX128 1045449873187684626970181632 (0.03151078 BTC/ETH − 2.5 %).
import { describe, it, expect } from "vitest";
import { SEL_X_SWAP_NATIVE, SEL_X_SWAP_TOKEN, base58Decode, decodeVaultSwapCalldata, encodeDestination, minOutFromPrice, minPriceX128 } from "../src/adapters/chainflip";

const CALLDATA = "0xdd68734500000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000002a62633171617230737272723778666b7679356c3634336c79646e77397265353967747a7a7766356d647100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006001640000002b8dc27605bf11214247ae11a013fcadf2c1cb6500000000e022ce2f9fc6600300000000000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000";

describe("Chainflip helpers (offline)", () => {
  it("selectors match the Vault ABI", () => {
    expect(SEL_X_SWAP_NATIVE).toBe("0xdd687345");
    expect(SEL_X_SWAP_TOKEN).toBe("0x04fc7da0");
  });
  it("minPriceX128 reproduces the SDK's derivation", () => {
    // exact: 0.03072301 × 2^128 × 10^(8−18) = 1045449856173566162236989269 (the recorded calldata below was made with a float-rounded value 16 ppb higher)
    expect(minPriceX128("0.03151078", 250, 18, 8)).toBe(1045449856173566162236989269n);
    // a price with more digits than dest decimals is truncated to dest decimals first
    expect(minPriceX128("0.03152338380529267076", 250, 18, 8)).toBe(minPriceX128("0.03152338", 250, 18, 8));
  });
  it("decodes xSwapNative calldata and the v1 cfParameters", () => {
    const d = decodeVaultSwapCalldata(CALLDATA);
    expect(d.dstChain).toBe(3);
    expect(d.dstToken).toBe(5);
    expect(d.dstAddress.toString("utf8")).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(d.cf.version).toBe(1);
    expect(d.cf.retryDuration).toBe(100);
    expect(d.cf.refundAddress).toBe("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
    expect(d.cf.minPriceX128).toBe(1045449873187684626970181632n);
    expect(d.cf.dca).toBeNull();
    expect(d.cf.boostFee).toBe(0);
    expect(d.cf.brokerBps).toBe(0);
    expect(d.cf.affiliates).toBe(0);
    expect(minOutFromPrice(10n ** 18n, d.cf.minPriceX128)).toBe(3072301n); // sats
  });
  it("rejects tampered calldata (destination, refund, min price)", () => {
    const flip = (hex: string, at: number) => hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
    const d0 = decodeVaultSwapCalldata(CALLDATA);
    const tampered = flip(CALLDATA, CALLDATA.indexOf("2b8dc276") + 2);
    expect(decodeVaultSwapCalldata(tampered).cf.refundAddress).not.toBe(d0.cf.refundAddress);
  });
  it("decodes a DCA plan in the v1 cfParameters (whale spec §7, §12) and refuses nothing else about it", async () => {
    const { encodeCall } = await import("../src/abi");
    const le = (v: bigint, n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn)); return out; };
    const refund = Buffer.from("2b8dc27605bf11214247ae11a013fcadf2c1cb65", "hex");
    const cf = Buffer.from([1, ...le(100n, 4), ...refund, ...le(1045449873187684626970181632n, 32), 0, 0, 1, ...le(101n, 4), ...le(1n, 4), 0, ...new Array(32).fill(0), 0, 0, 0]);
    const dest = Buffer.from("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "utf8");
    const calldata = encodeCall("xSwapNative(uint32,bytes,uint32,bytes)", [{ t: "uint", v: 3 }, { t: "bytes", v: "0x" + dest.toString("hex") }, { t: "uint", v: 5 }, { t: "bytes", v: "0x" + cf.toString("hex") }]);
    expect(calldata.startsWith(SEL_X_SWAP_NATIVE)).toBe(true);
    const d = decodeVaultSwapCalldata(calldata);
    expect(d.cf.dca).toEqual({ chunks: 101, interval: 1 });
    expect(d.cf.refundAddress).toBe("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
    expect(d.cf.minPriceX128).toBe(1045449873187684626970181632n);
    expect(d.cf.brokerBps).toBe(0);
  });
  it("encodes destinations per chain", () => {
    expect(encodeDestination("Bitcoin", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").toString("utf8")).toBe("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(encodeDestination("Ethereum", "0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65").length).toBe(20);
    expect(base58Decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").length).toBe(32);
    expect(base58Decode("11111111111111111111111111111111").equals(Buffer.alloc(32))).toBe(true);
  });
});
