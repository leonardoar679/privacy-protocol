// Across's exclusivity, read as the wallet bounds it at signing (the twelfth review round, F12-4; the eleventh's D11-10 —
// packages/sdk/src/providerCall.ts mustShortExclusivity): no exclusive relayer, or one whose window ends within
// ACROSS_MAX_EXCLUSIVITY_SECONDS. A relayer named exclusive that never fills holds the deposit for its window — until its fill deadline when the
// window outlasts it —, the escrow then refunded hours later after a bundle. The SpokePool reads a parameter up to a year as seconds from the
// deposit, a larger one as a timestamp. The adapters put the window on their quotes and the competition sets a longer one aside (engine
// quoteAll): a route the wallet refuses at signing is never ranked, chosen and funded. Never refused at a committed order's prepare or rebuild
// (ZE's critique): there the wallet's own check meets it — before a delayed one-confirm funding, which then stops the order unfunded, where a
// refusal here had read as an outage and funded it; an order funded at once, or on the Advanced screen's schedule, meets it at its signing.

export const ACROSS_MAX_EXCLUSIVITY_SECONDS = 600;
const ACROSS_EXCLUSIVITY_OFFSET_MAX = 31_536_000;

/** The exclusivity window in seconds from `now`, or null without an exclusive relayer (the zero address, or a zero word). */
export function exclusivityWindow(relayer: string | Uint8Array, parameter: number | bigint, now: number): number | null {
  const none = typeof relayer === "string" ? /^(0x)?0*$/i.test(relayer) : relayer.every((b) => b === 0);
  if (none) return null;
  const p = Number(parameter);
  return p <= ACROSS_EXCLUSIVITY_OFFSET_MAX ? p : p - now;
}
