// LIVE: the wallet's own check (frontend/src/sdk/providerCall.ts) of the calls this engine prepares from
// real provider quotes. Two independent decoders must agree: every call the engine would hand the order
// key passes the wallet's check, pays the fresh destination, refunds where the engine says, and the
// minimum the wallet reads is the one the engine quoted (at least it, for LI.FI's Across facet, whose
// floor is minAmount × multiplier). THORChain's vault is confirmed by the WALLET's own gateway quorum,
// queried here exactly as the browser does. Read-only: quotes and calldata only, no funds, no keys.
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { defaultEngine } from "../src/config";
import { orderSignerAddress } from "../src/endpoints";
import type { AssetRef, Quote, QuoteRequest } from "../src/types";
import { checkProviderCall, ProviderCallMismatch, type CheckedCall } from "../../../frontend/src/sdk/providerCall";

const KEYS = { orderSigner: orderSignerAddress(sha256(new TextEncoder().encode("wallet-check order key"))), refundOwnerCommitment: 0x1234n, refundNoteSecret: 0x5678n, refundNoteDataHash: ("0x" + "ab".repeat(32)) as `0x${string}` };
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_ETH: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
process.env.ERC20_VAULTS = `${USDC_ETH.asset}:0x00000000000000000000000000000000000ca5de`;
const DEST_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DEST_EVM = "0x1111111111111111111111111111111111111111";
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

interface Checked { route: string; provider: string; quote: Quote; checked: CheckedCall; call: { provider: `0x${string}`; value: bigint; calldata: `0x${string}` }; expectation: Parameters<typeof checkProviderCall>[1] }

async function prepareAndCheck(route: string, req: QuoteRequest): Promise<{ checked: Checked[]; skipped: Record<string, string> }> {
  const engine = defaultEngine();
  const set = await engine.quoteAll(req, "fastest");
  const checked: Checked[] = [];
  const skipped: Record<string, string> = { ...(set.errors as Record<string, string>) };
  for (const q of set.quotes) {
    const adapter = engine.cfg.adapters.find((a) => a.id === q.provider)!;
    if (adapter.capabilities().contractSender === false) { skipped[q.provider] = "ingress withheld (contract-sender deposits unconfirmed)"; continue; }
    const order = engine.buildOrder(req, "fastest", q, KEYS);
    let p;
    try { p = await engine.prepareExecution(order, adapter); } catch (e) { skipped[q.provider] = `engine: ${(e as Error).message}`; continue; }
    const call = { provider: p.provider as `0x${string}`, value: p.value, calldata: p.calldata };
    // the wallet's configured ERC-20 assets mirror the pool's vaults (ERC20_VAULTS above)
    const expectation = { escrow: order.endpoint as `0x${string}`, from: req.from, to: req.to, destination: req.destination, net: order.params.amount - order.params.executorTip, policy: "fastest" as const, pooled: [USDC_ETH.asset] };
    // the wallet's check, with its own live THORNode quorum (no stub)
    const c = await checkProviderCall(call, expectation);
    checked.push({ route, provider: q.provider, quote: p.quote, checked: c, call, expectation });
  }
  console.log(`${route}: wallet-checked ${checked.map((c) => `${c.provider} (min ${c.checked.minOut ?? "n/a"}, refund to ${c.checked.refundTo})`).join(", ") || "none"}; skipped ${JSON.stringify(skipped)}`);
  return { checked, skipped };
}

function agree(c: Checked) {
  expect(c.checked.receiver.toLowerCase(), `${c.route}/${c.provider}: receiver`).toBe(c.expectation.destination.toLowerCase());
  if (c.quote.minOutVerified === false) {
    expect(c.checked.minOut, `${c.route}/${c.provider}: the engine could not verify a minimum, the wallet must not claim one`).toBeNull();
    return;
  }
  expect(c.checked.minOut, `${c.route}/${c.provider}: minimum`).not.toBeNull();
  if (c.provider === "lifi") expect(c.checked.minOut! >= c.quote.toAmountMin, `${c.route}/lifi: the facet floor ${c.checked.minOut} is below the quoted ${c.quote.toAmountMin}`).toBe(true);
  else expect(c.checked.minOut, `${c.route}/${c.provider}: the wallet reads another minimum than the engine quoted`).toBe(c.quote.toAmountMin);
  const refund = c.provider === "mayan" ? "destination" : "escrow";
  expect(c.checked.refundTo, `${c.route}/${c.provider}: refund target`).toBe(refund);
  expect(c.quote.refundTarget ?? "escrow", `${c.route}/${c.provider}: the engine and the wallet disagree on where a refund lands`).toBe(refund);
}

describe("the wallet's provider-call check agrees with the engine on live provider calls", () => {
  it("ETH → BTC: THORChain (vault from the wallet's own gateway quorum, refund to the escrow) and Chainflip", async () => {
    const { checked, skipped } = await prepareAndCheck("ETH->BTC", { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 });
    for (const c of checked) agree(c);
    const got = checked.map((c) => c.provider);
    expect(got.length, `none checked; skipped ${JSON.stringify(skipped)}`).toBeGreaterThan(0);
    for (const p of ["thorchain", "chainflip"]) if (!got.includes(p)) console.warn(`ETH->BTC: ${p} not checked this run: ${skipped[p]}`);
  }, 240_000);

  it("ETH → ETH (Base): Across direct, LI.FI's Across facet, Mayan", async () => {
    const { checked } = await prepareAndCheck("ETH->ETH(Base)", { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, slippageBps: 50 });
    for (const c of checked) agree(c);
    expect(checked.map((c) => c.provider)).toContain("uniswap-across");
  }, 240_000);

  it("ETH → USDC (Base): the Uniswap-Across leg (swap on Ethereum, bridge, the pinned handler drains to the fresh address); both decoders name USDC as the token to watch", async () => {
    const { checked, skipped } = await prepareAndCheck("ETH->USDC(Base)", { from: ETH, to: USDC_BASE, amount: 10n ** 18n, destination: DEST_EVM, slippageBps: 50 });
    for (const c of checked) agree(c);
    const leg = checked.find((c) => c.provider === "uniswap-across");
    expect(leg, `the swap leg was not checked: ${skipped["uniswap-across"]}`).toBeTruthy();
    expect(leg!.checked.refundTokens?.map((t) => t.toLowerCase()), "an unfilled deposit comes back in USDC: the executor must watch it").toEqual([USDC_ETH.asset.toLowerCase()]);
  }, 240_000);

  it("ETH → SOL: Mayan direct and LI.FI → Mayan; the wallet refuses an unreadable minimum unless the policy is Fastest", async () => {
    const { checked } = await prepareAndCheck("ETH->SOL", { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, slippageBps: 100 });
    for (const c of checked) agree(c);
    expect(checked.length).toBeGreaterThan(0);
    for (const c of checked.filter((x) => x.checked.minOut === null)) {
      await expect(checkProviderCall(c.call, { ...c.expectation, policy: "best-privacy" })).rejects.toThrow(ProviderCallMismatch);
    }
  }, 240_000);

  it("USDC → BTC and → USDC (Base): ERC-20 calls forward no ETH and spend exactly the net amount", async () => {
    for (const [route, req] of [
      ["USDC->BTC", { from: USDC_ETH, to: BTC, amount: 1_000_000_000n, destination: DEST_BTC, slippageBps: 100 }],
      ["USDC->USDC(Base)", { from: USDC_ETH, to: USDC_BASE, amount: 1_000_000_000n, destination: DEST_EVM, slippageBps: 50 }],
    ] as [string, QuoteRequest][]) {
      const { checked } = await prepareAndCheck(route, req);
      for (const c of checked) { agree(c); expect(c.call.value, `${route}/${c.provider}`).toBe(0n); }
      expect(checked.length, `${route}: none checked`).toBeGreaterThan(0);
    }
  }, 300_000);
});
