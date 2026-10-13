// Walletless mode: the browser's own check of the deposit instruction the swap service hands a guest
// (packages/sdk/src/guestGuard.ts). Honest instructions are built with the swap service's OWN memo builder; a
// dishonest service that names another address, another destination or asset, a memo a UTXO chain
// cannot carry, or a lower minimum is caught before anything is shown. Offline: THORNode answers stubbed.
import { describe, it, expect } from "vitest";
import { checkGuestInstruction, type GuestInstruction } from "@privacy-wallet/sdk/guestGuard";
import { MinimumMoved, ProviderCallMismatch, thorAsset, thorAssetShort, thornodeInbound, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { buildMemo, thorAsset as engineThorAsset, thorAssetShort as engineThorAssetShort, UTXO_MEMO_BYTES } from "@privacy-wallet/swap-engine/adapters/thorchain";
import type { AssetRef } from "@privacy-wallet/sdk/swapService";

const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const VAULT = "bc1qvaultvaultvaultvaultvaultvaultvaultvau1t";
const DEST = "0x4E41cD3b4B0D4ec1B0c1dB5E1c9f0a7d0b5C1e2f";
const NOW = 1_790_000_000;
const AMOUNT = 1_000_000n; // 0.01 BTC
const LIMIT = 30_000_000n; // 0.3 ETH in 1e8 units
const inbound = (over: Record<string, unknown> = {}): InboundLookup => async (chain) => (chain === "BTC" ? { address: VAULT, halted: false, agreeing: ["g1", "g2", "g3"], ...over } : Promise.reject(new Error(`unexpected chain ${chain}`)));
const instruction = (o: { to?: string; memo?: string; amount?: string; expiresAt?: number; provider?: string } = {}): GuestInstruction => ({
  provider: o.provider ?? "thorchain",
  ingress: { to: o.to ?? VAULT, memo: o.memo ?? buildMemo(engineThorAsset(ETH as any), DEST, LIMIT), amount: o.amount ?? AMOUNT.toString(), expiresAt: o.expiresAt ?? NOW + 900 },
});
const expectation = (over: Record<string, unknown> = {}) => ({ from: BTC, to: ETH, destination: DEST, amount: AMOUNT, approvedMin: LIMIT * 10n ** 10n, inbound: inbound(), now: NOW, ...over });
const refused = async (p: Promise<unknown>, field: RegExp) => { await expect(p).rejects.toThrow(ProviderCallMismatch); await expect(p).rejects.toThrow(field); };

describe("the browser checks a guest's deposit instruction before showing it", () => {
  it("the service's honest instruction passes: the vault the gateways report, the typed destination, the quoted minimum", async () => {
    const c = await checkGuestInstruction(instruction(), expectation());
    expect(c).toMatchObject({ depositAddress: VAULT, minOut: LIMIT * 10n ** 10n, gateways: 3 });
  });
  it("a streamed memo (whale spec §12) is not for a guest: guests stay single-swap", async () => {
    await refused(checkGuestInstruction(instruction({ memo: buildMemo(engineThorAsset(ETH as any), DEST, LIMIT, undefined, { interval: 1, quantity: 5 }) }), expectation()), /memo/);
  });
  it("a token target uses THORChain's short asset form so the memo fits OP_RETURN, and still passes", async () => {
    const full = buildMemo(engineThorAsset(USDC as any), DEST, 83_299_108_167n);
    expect(Buffer.byteLength(full)).toBeGreaterThan(UTXO_MEMO_BYTES);
    const short = buildMemo(engineThorAssetShort(USDC as any), DEST, 83_299_108_167n);
    expect(short).toBe(`=:ETH.USDC:${DEST}:83299108167`); // exactly what THORNode's quote API writes for BTC → ETH.USDC
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(UTXO_MEMO_BYTES);
    expect(thorAssetShort(USDC)).toBe(engineThorAssetShort(USDC as any));
    expect(thorAsset(USDC)).toBe(engineThorAsset(USDC as any));
    await expect(checkGuestInstruction(instruction({ memo: short }), expectation({ to: USDC, approvedMin: 832_991_081n }))).resolves.toMatchObject({ minOut: 832_991_081n });
    await refused(checkGuestInstruction(instruction({ memo: full }), expectation({ to: USDC, approvedMin: 0n })), /80/);
  });
  it("refuses another address, another destination, another asset, a refund field, streaming or affiliates, a halted chain", async () => {
    await refused(checkGuestInstruction(instruction({ to: "bc1qattackerattackerattackerattackerattack" }), expectation()), /vault/);
    await refused(checkGuestInstruction(instruction({ memo: buildMemo("ETH.ETH", "0x000000000000000000000000000000000000bad1", LIMIT) }), expectation()), /receiver/);
    await refused(checkGuestInstruction(instruction({ memo: buildMemo("ETH.USDT", DEST, LIMIT) }), expectation()), /memo asset/);
    await refused(checkGuestInstruction(instruction({ memo: buildMemo("ETH.ETH", DEST, LIMIT, "bc1qrefund") }), expectation()), /memo/);
    await refused(checkGuestInstruction(instruction({ memo: `${buildMemo("ETH.ETH", DEST, LIMIT)}/3/0` }), expectation()), /memo/);
    await refused(checkGuestInstruction(instruction({ memo: `${buildMemo("ETH.ETH", DEST, LIMIT)}:aff:50` }), expectation()), /memo/);
    await refused(checkGuestInstruction(instruction(), expectation({ inbound: inbound({ halted: true }) })), /inbound/);
  });
  it("refuses another amount, an expired instruction, another provider, a source the guest flow does not serve", async () => {
    await refused(checkGuestInstruction(instruction({ amount: "999" }), expectation()), /amount/);
    await refused(checkGuestInstruction(instruction({ expiresAt: NOW - 1 }), expectation()), /expiry/);
    await refused(checkGuestInstruction(instruction({ provider: "near-intents" }), expectation()), /provider/);
    await refused(checkGuestInstruction(instruction(), expectation({ from: ETH })), /source/);
  });
  it("a lower minimum is reported against the quote the guest saw, for consent", async () => {
    const p = checkGuestInstruction(instruction({ memo: buildMemo("ETH.ETH", DEST, LIMIT - 1n) }), expectation());
    await expect(p).rejects.toBeInstanceOf(MinimumMoved);
    await expect(p).rejects.toMatchObject({ minOut: (LIMIT - 1n) * 10n ** 10n, approved: LIMIT * 10n ** 10n });
  });
});

describe("THORNode gateways for a UTXO chain: a vault address, no router; all that answer must agree", () => {
  const gateways = ["https://g1", "https://g2", "https://g3"];
  const fetchFrom = (answers: Record<string, unknown>) => (async (url: string) => {
    const base = url.slice(0, url.indexOf("/thorchain"));
    if (!(base in answers)) throw new TypeError("network error");
    return new Response(JSON.stringify(answers[base]), { status: 200 });
  }) as unknown as typeof fetch;
  const btc = (address: string) => [{ chain: "BTC", address, router: "", halted: false }, { chain: "ETH", address: "0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb", router: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146" }];
  it("three gateways reporting the same BTC vault confirm it; one naming another fails closed", async () => {
    await expect(thornodeInbound("BTC", { gateways, fetchFn: fetchFrom(Object.fromEntries(gateways.map((g) => [g, btc(VAULT)]))) })).resolves.toMatchObject({ address: VAULT, router: undefined, agreeing: gateways });
    await expect(thornodeInbound("BTC", { gateways, fetchFn: fetchFrom({ "https://g1": btc(VAULT), "https://g2": btc(VAULT), "https://g3": btc("bc1qattackerattackerattackerattackerattack") }) })).rejects.toThrow(/disagree/);
  });
});
