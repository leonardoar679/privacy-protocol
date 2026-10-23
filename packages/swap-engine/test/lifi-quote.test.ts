// A LI.FI quote its execution would be refused for is never offered (audit round 2, n08): the floor checks of the Across
// call (the bridged token the one delivered, the minimum backed by what is bridged) ran only when the execution was prepared,
// after the funding — a quote failing them was ranked, chosen and funded, and the escrow waited for its refund time. Offline:
// a quote LI.FI answered (2026-10-22, ETH → ETH on Base through AcrossV4, to this suite's escrow and destination).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LifiAdapter } from "../src/adapters/lifi";
import type { QuoteRequest } from "../src/types";
import { setWord } from "./helpers/tamper";

const raw = JSON.parse(readFileSync(new URL("./fixtures/lifi-across-eth-base.json", import.meta.url), "utf8"));
const req: QuoteRequest = {
  from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
  to: { chain: "base", asset: "native", decimals: 18, symbol: "ETH" },
  amount: 10n ** 18n,
  destination: "0x1111111111111111111111111111111111111111",
  source: "0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65",
  slippageBps: 50,
} as QuoteRequest;
const answering = (q: unknown) => {
  const a = new LifiAdapter();
  a.rawQuote = async () => structuredClone(q);
  return a;
};
// the calldata's BridgeData and AcrossV4Data offsets (as the live tamper suite reads them)
const bdOff = (data: string) => Number(BigInt("0x" + data.slice(10, 74)));
const facetOff = (data: string) => {
  const hasSwaps = BigInt("0x" + data.slice(10 + 2 * (bdOff(data) + 8 * 32), 10 + 2 * (bdOff(data) + 9 * 32))) === 1n;
  const idx = hasSwaps ? 2 : 1;
  return Number(BigInt("0x" + data.slice(10 + 64 * idx, 10 + 64 * (idx + 1))));
};

describe("a LI.FI quote its execution would refuse (audit round 2, n08)", () => {
  it("is refused at quote time, before anything is funded: a minimum the bridged amount does not back", async () => {
    const q = await answering(raw).quote(req);
    expect(q).toMatchObject({ provider: "lifi", minOutVerified: true });
    const tampered = structuredClone(raw);
    const data: string = tampered.transactionRequest.data;
    tampered.transactionRequest.data = setWord(data, 4 + facetOff(data) + 5 * 32, 1n); // outputAmountMultiplier: almost nothing reaches Across
    await expect(answering(tampered).quote(req)).rejects.toThrow(/outputAmountMultiplier|below the quoted minimum/);
  });
});
