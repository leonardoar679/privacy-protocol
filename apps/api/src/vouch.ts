// The API's vouches (a V6 follow-up of 2026-10-16; audit gap 47; spec v2.0 §15). With API_VOUCH_KEY, the API signs the
// escrow of each order it commits and, at the finalize, the provider call it prepared for that order — the latter only when
// the wallet shows the vouch it got at the commit, so an order rebuilt from anyone's params gets none. A relayer configured
// with this key's address (API_VOUCHER) executes and refunds only what it signed. The key signs nothing else and is never
// logged; unset, the API vouches for nothing, and a relayer that requires vouches executes none of its orders.
import { executionVouchDigest, orderSignerAddress, orderVouchDigest, signExecution, vouchedBy } from "@privacy-wallet/swap-engine/endpoints";

type Hex = `0x${string}`;
export interface Voucher {
  /** what a relayer is configured with (API_VOUCHER) */
  readonly address: Hex;
  /** the order's vouch: over its escrow, which commits to the factory and every parameter */
  order(chainId: bigint, escrow: string): Hex;
  /** the call's vouch: over the escrow and the provider call the API prepared */
  execution(chainId: bigint, escrow: string, x: { provider: string; value: bigint; providerCalldata: string; deadline: number }): Hex;
  /** whether `vouch` is this API's for the order's escrow */
  vouched(chainId: bigint, escrow: string, vouch: unknown): boolean;
}

export function makeVoucher(key: Hex): Voucher {
  const priv = Uint8Array.from(Buffer.from(key.slice(2), "hex"));
  const address = orderSignerAddress(priv); // refuses a key outside the curve's range
  return {
    address,
    order: (chainId, escrow) => signExecution(priv, orderVouchDigest(chainId, escrow)),
    execution: (chainId, escrow, x) => signExecution(priv, executionVouchDigest(chainId, escrow, x.provider, x.value, x.providerCalldata, x.deadline)),
    vouched: (chainId, escrow, vouch) => vouchedBy(address, orderVouchDigest(chainId, escrow), vouch),
  };
}

/** API_VOUCH_KEY: 32 bytes of hex; unset or empty, no voucher. A malformed key stops the start, and its value is never echoed. */
export function voucherFrom(raw: string | undefined): Voucher | null {
  const key = raw?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("API_VOUCH_KEY must be 32 bytes of hex (0x followed by 64 hex digits)");
  try {
    return makeVoucher(key as Hex);
  } catch {
    throw new Error("API_VOUCH_KEY is not a usable secp256k1 key");
  }
}
