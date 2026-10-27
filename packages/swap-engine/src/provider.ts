// The engine's side of the swap provider facade (Privacy Wallet Web spec v3.0 §5; V7 Stage 14): over one adapter, a
// provider's id, its quote and its tracking — the three calls the engine can answer. The two-phase commit, the validation
// and the recovery options are the wallet's (packages/sdk/src/swapProvider.ts): the independent verification layer stays
// wallet-side (v2.0 §13.1). The engine's competition over every adapter stays quoteAll / POST /v1/quotes, which the wallet's
// getQuote calls; THORChain is one adapter among six.
import type { SwapProvider } from "@privacy-wallet/protocol/wallet/swapProvider";
import type { ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "./types";

export { RECOVERY_OPTION_KINDS, type RecoveryOption, type RecoveryOptionKind, type SwapProvider } from "@privacy-wallet/protocol/wallet/swapProvider";

/** The engine's three: the id, the quote and the tracking. */
export type EngineSwapProvider = Pick<SwapProvider<QuoteRequest, Quote, never, never, TrackStatus>, "id" | "getQuote" | "getStatus">;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * A provider's facade over its adapter: the quote is the adapter's; a status reads by the source transaction hash (0x and
 * 64 hex digits) or, for anything else, by the provider's own reference. `decimals`: the order's output and input decimals,
 * for a provider that tracks in its own units.
 */
export function fromAdapter(adapter: ProviderAdapter, decimals?: { out?: number; in?: number }): EngineSwapProvider {
  return {
    id: adapter.id,
    getQuote: (request) => adapter.quote(request),
    getStatus: (executionId) =>
      adapter.track(
        TX_HASH.test(executionId)
          ? { sourceTxHash: executionId, ...(decimals ? { decimals } : {}) }
          : { providerRef: executionId, ...(decimals ? { decimals } : {}) },
      ),
  };
}
