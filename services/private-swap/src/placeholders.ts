// Placeholder destinations for phase-1 (indicative) quotes (whale spec §3, §5): a fixed, format-valid
// address of the destination chain that is nobody's, sent to every provider quoted at phase 1 so that the
// wallet's fresh destination reaches only the provider chosen at phase 3 (`/prepare`). THORChain's quote
// takes no destination at all; Chainflip's none either.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import type { Chain } from "./types";
import { isEvm } from "./types";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

/** EVM: a plain address nobody holds (1Click rejects the 0x…dEaD burn address). */
export const PLACEHOLDER_EVM = "0x1111111111111111111111111111111111111111";
/** Bitcoin: the BIP-173 example P2WPKH address (format-valid, a documented test vector nobody holds). */
export const PLACEHOLDER_BTC = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/** Solana: a wallet-shaped address nobody holds — the ed25519 public key of sha256("privacy-protocol/placeholder/solana"), on the curve as 1Click requires of a recipient (the system program id is refused). */
export const PLACEHOLDER_SOL = base58Encode(ed25519.getPublicKey(sha256(new TextEncoder().encode("privacy-protocol/placeholder/solana"))));

/** The placeholder for a destination chain, or null when the chain has none (the real destination is then used). */
export function placeholderDestination(chain: Chain): string | null {
  if (isEvm(chain)) return PLACEHOLDER_EVM;
  if (chain === "bitcoin") return PLACEHOLDER_BTC;
  if (chain === "solana") return PLACEHOLDER_SOL;
  return null;
}
