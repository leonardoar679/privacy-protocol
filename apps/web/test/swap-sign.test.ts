// The last gate before the one-time order key signs (packages/sdk/src/swapSign.ts), end to end through the swap
// service's real engine: the engine prepares a THORChain call from a stub adapter that uses the THORChain
// adapter's own encoders (memo, depositWithExpiry). The wallet's gate passes the honest call, refuses each
// way a dishonest service could bend the call between the escrow and the provider, refuses a call
// prepared for another order than the one journaled, and asks again when the minimum dropped. Offline:
// the gateways' answer is stubbed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { checkBeforeSigning, type JournaledOrder } from "@privacy-wallet/sdk/swapSign";
import { MinimumMoved, PINNED, ProviderCallMismatch, thorAsset, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { OrderMismatch } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";
import type { Prepared, ServiceOrder } from "@privacy-wallet/sdk/swapService";
import { PrivateSwapEngine } from "@privacy-wallet/swap-engine/engine";
import { buildMemo, encodeDepositWithExpiry } from "@privacy-wallet/swap-engine/adapters/thorchain";
import type { AssetRef, Ingress, ProviderAdapter, Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7";
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const ATTACKER = getAddress("0x000000000000000000000000000000000000bad1");
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const LIMIT = 3_000_000n; // sats; THORChain limits are 1e8-based, so for BTC the limit is the minimum
const engine = new PrivateSwapEngine({
  adapters: [], factory: FACTORY, escrowCreationCode: read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n,
  refundVaults: { native: ETH_VAULT }, tips: { tipFor: async (_from, amount) => amount / 400n } /* a fixed 0.25 %: the service prices the gas (swap-engine tips.ts) */, refundWindowSeconds: 7200,
});
const seed = utf8ToBytes("swap-sign-test-seed");
const now = () => Math.floor(Date.now() / 1000);
const inbound: InboundLookup = async () => ({ address: VAULT, router: PINNED.thorchainRouter, halted: false, agreeing: ["g1", "g2", "g3"] });
const wire = <T>(x: T): any => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); // what crosses HTTP / sits in the journal

interface Bend { vault?: string; dest?: string; refund?: string; limit?: bigint }
/** THORChain with the adapter's real encoders; `bend` plays the dishonest service. */
function thorchain(bend: Bend = {}): ProviderAdapter {
  const quote = (): Quote => ({ provider: "thorchain", category: "A", toAmount: LIMIT + 30_000n, toAmountMin: LIMIT, fees: [], etaSeconds: 600, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now() });
  return {
    id: "thorchain", implemented: true, capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "memo" }) as any,
    quote: async () => quote(),
    prepareIngress: async (req: QuoteRequest, q: Quote): Promise<Ingress> => {
      const memo = buildMemo(thorAsset(BTC), bend.dest ?? req.destination, bend.limit ?? LIMIT, bend.refund ?? req.source);
      return { kind: "contract-call", to: PINNED.thorchainRouter, calldata: encodeDepositWithExpiry(bend.vault ?? VAULT, "0x0000000000000000000000000000000000000000", req.amount, memo, BigInt(now() + 600)), value: req.amount, memo, expiresAt: q.expiresAt, minOutEncoded: true };
    },
    track: async () => ({ state: "unknown" }), health: async () => ({}) as any,
  };
}

async function commitAndPrepare(bend: Bend = {}) {
  const key = deriveOrderKey(seed, ("0x" + "cd".repeat(32)) as Hex);
  const refund = deriveRefundNote(seed, 3);
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST, slippageBps: 50 };
  const shown = await thorchain().quote(req);
  const order = engine.buildOrder(req, "best-privacy", { ...shown, executorTip: req.amount / 400n }, { orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment, refundNoteSecret: refund.noteSecret, refundNoteDataHash: refund.noteDataHash });
  const journaled: JournaledOrder = { request: wire(req), params: wire(order.params), policy: "best-privacy", approvedMin: shown.toAmountMin.toString() };
  const p = await engine.prepareExecution(order, thorchain(bend));
  const prepared: Prepared = wire({ digest: p.digest, provider: p.provider, value: p.value, calldata: p.calldata, deadline: p.deadline });
  return { order: wire(order) as ServiceOrder, journaled, prepared };
}
const gate = (x: Awaited<ReturnType<typeof commitAndPrepare>>, acceptMin?: bigint) => checkBeforeSigning({ ...x, factory: FACTORY, chainId: 1n, inbound, acceptMin });

describe("checkBeforeSigning: the engine's honest THORChain call passes; a bent one is not signed", () => {
  it("honest: the escrow is recomputed from the journal, the call pays the fresh address, refunds to the escrow, at the approved minimum", async () => {
    const x = await commitAndPrepare();
    const g = await gate(x);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.escrow.toLowerCase()).toBe(x.order.endpoint.toLowerCase());
    expect(g.call).toMatchObject({ provider: "thorchain", receiver: DEST, minOut: LIMIT, refundTo: "escrow" });
  });
  it("refuses a call paying another vault, another receiver, or refunding someone else", async () => {
    await expect(gate(await commitAndPrepare({ vault: ATTACKER }))).rejects.toThrow(ProviderCallMismatch);
    await expect(gate(await commitAndPrepare({ dest: "bc1qattacker" }))).rejects.toThrow(/receiver/);
    await expect(gate(await commitAndPrepare({ refund: ATTACKER }))).rejects.toThrow(/refund/);
  });
  it("a lower minimum is not signed without consent; consent to exactly that minimum lets it through", async () => {
    const x = await commitAndPrepare({ limit: LIMIT - 60_000n });
    const g = await gate(x);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.moved).toBeInstanceOf(MinimumMoved);
    expect(g.moved).toMatchObject({ minOut: LIMIT - 60_000n, approved: LIMIT });
    await expect(gate(x, g.moved.minOut)).resolves.toMatchObject({ ok: true });
    await expect(gate(x, g.moved.minOut + 1n)).resolves.toMatchObject({ ok: false }); // consent covers that minimum, not a lower one
  });
  it("a call the service prepared for another order than the one journaled is refused (another escrow, another digest)", async () => {
    const a = await commitAndPrepare(), b = await commitAndPrepare();
    await expect(gate({ ...a, prepared: b.prepared })).rejects.toThrow(OrderMismatch);
    await expect(gate({ ...a, prepared: b.prepared })).rejects.toThrow(/digest/);
  });
  it("a digest over another call than the one shown is refused before the call is even read", async () => {
    const x = await commitAndPrepare();
    const other = await commitAndPrepare({ dest: "bc1qattacker" });
    await expect(gate({ ...x, prepared: { ...x.prepared, calldata: other.prepared.calldata } })).rejects.toThrow(/digest/);
  });
});
