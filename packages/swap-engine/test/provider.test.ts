// The engine's side of the swap provider facade (spec v3.0 §5; V7 Stage 14): over an adapter, the id, the quote and the
// tracking — nothing else, by design: the commit, the validation and the recovery options are the wallet's.
import { describe, expect, it } from "vitest";
import { fromAdapter, RECOVERY_OPTION_KINDS } from "../src/provider";
import type { ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../src/types";

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" } as const;
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" } as const;

function stub(): ProviderAdapter & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    id: "thorchain",
    implemented: true,
    seen,
    capabilities: () => ({ routes: ["A"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin"] }) as never,
    quote: async (req: QuoteRequest) => {
      seen.push(req);
      return { provider: "thorchain", category: "A", toAmount: req.amount / 30n, toAmountMin: req.amount / 31n } as unknown as Quote;
    },
    prepareIngress: async () => {
      throw new Error("the engine's prepare is the two-phase commit of the API, not the facade's");
    },
    track: async (ref) => {
      seen.push(ref);
      return { state: "pending" } as TrackStatus;
    },
    health: async () => ({ provider: "thorchain", reachable: true, apiLatencyMs: 1, halted: false, haltedChains: [], checkedAt: 0 }) as never,
  };
}

describe("fromAdapter (spec v3.0 §5)", () => {
  it("the id, the quote and the tracking are the adapter's; a transaction hash tracks by the source hash, anything else by the provider's reference; the rest is the wallet's", async () => {
    const a = stub();
    const p = fromAdapter(a, { out: 8, in: 18 });
    expect(p.id).toBe("thorchain");
    const req = { from: ETH, to: BTC, amount: 10n ** 18n, destination: "", slippageBps: 50 } as unknown as QuoteRequest;
    expect((await p.getQuote(req)).toAmountMin).toBe(10n ** 18n / 31n);
    const tx = "0x" + "ab".repeat(32);
    expect((await p.getStatus(tx)).state).toBe("pending");
    expect((await p.getStatus("thor-ref-1")).state).toBe("pending");
    expect(a.seen).toEqual([req, { sourceTxHash: tx, decimals: { out: 8, in: 18 } }, { providerRef: "thor-ref-1", decimals: { out: 8, in: 18 } }]);
    expect((await fromAdapter(a).getStatus("ref")) && a.seen.at(-1), "no decimals named: none passed").toEqual({ providerRef: "ref" });
    expect("prepare" in p, "the two-phase commit, the validation and the recovery options are the wallet's").toBe(false);
    expect(RECOVERY_OPTION_KINDS).toEqual(["accept-new-minimum", "return-funds", "continue-monitoring", "retry-hand-over", "view-progress"]);
  });
});
