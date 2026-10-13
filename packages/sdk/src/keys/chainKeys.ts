// Fresh per-chain addresses for the wallet (plan §27–§28, §45–§46): the Chain Key Abstraction of the
// reference, driven by the per-chain counters kept in the encrypted journal so an index is never
// handed out twice. Every EVM network shares one account space (an address is valid on all of them);
// Bitcoin and Solana have their own. Keys are re-derived on demand and never persisted.
import { accountFor, bip39Seed, dappAccount as deriveDappAccount, type ChainAccount, type ChainKind } from "@privacy-wallet/protocol/wallet/chainKeys";
import { seedToPhrase } from "../wallet/keystore";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { recordFreshAddress } from "../wallet/addressBook";

const seeds = new WeakMap<Uint8Array, { of: Uint8Array; seed64: Uint8Array }>();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The 64-byte BIP-39 seed of the master seed's phrase (PBKDF2 once per unlock). Cached on the seed object and re-checked against its bytes, so a zeroed or reused buffer never yields a stale value. */
export function chainSeed(masterSeed: Uint8Array): Uint8Array {
  const hit = seeds.get(masterSeed);
  if (hit && same(hit.of, masterSeed)) return hit.seed64;
  const seed64 = bip39Seed(seedToPhrase(masterSeed));
  seeds.set(masterSeed, { of: masterSeed.slice(), seed64 });
  return seed64;
}

/** The key space a swap target / receive asset lives in. */
export const chainKindOf = (chain: string): ChainKind => (chain === "bitcoin" ? "bitcoin" : chain === "solana" ? "solana" : "evm");

const nextIndex = (chain: ChainKind, s: WalletSession): number => s.journal().chainIndexes[chain] ?? 0;

/** The address the next consume() will hand out (display only; nothing is reserved). */
export function peekFreshAddress(masterSeed: Uint8Array, chain: ChainKind, s: WalletSession = defaultSession): ChainAccount {
  return accountFor(chain, chainSeed(masterSeed), nextIndex(chain, s));
}

/** Reserve and return a fresh address: the journal's counter advances, so it is never handed out again. */
export function consumeFreshAddress(masterSeed: Uint8Array, chain: ChainKind, s: WalletSession = defaultSession): ChainAccount {
  const index = nextIndex(chain, s);
  s.update((j) => { j.chainIndexes[chain] = index + 1; });
  const acct = accountFor(chain, chainSeed(masterSeed), index);
  recordFreshAddress(chain, acct.address, index, s); // High-Value Protection spec §12: verified by derivation, retired after one use
  return acct;
}

/** The most recently reserved address of a chain, if any (what the Receive screen shows). */
export function lastFreshAddress(masterSeed: Uint8Array, chain: ChainKind, s: WalletSession = defaultSession): ChainAccount | null {
  const n = nextIndex(chain, s);
  return n > 0 ? accountFor(chain, chainSeed(masterSeed), n - 1) : null;
}

/** The fresh EVM account a dApp origin gets (plan §37): stable per origin, distinct between origins, never the first account. */
export const dappAccount = (masterSeed: Uint8Array, origin: string) => deriveDappAccount(chainSeed(masterSeed), origin);
