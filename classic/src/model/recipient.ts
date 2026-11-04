// Why an address must not receive a withdrawal, or null (the fourth review round, 2026-11-03) — the Privacy Wallet's rule
// (packages/protocol/src/wallet/destinations.ts), its twin here: rule 9 keeps the two source trees apart. The zero and the burn
// address lose what they receive — the pool's `withdraw` pays with a plain call, which succeeds at an address without code, so a
// zero recipient burns the denomination and spends the note; the pools, the router and the verifier keep what they receive with
// no way back (a plain call to them reverts, so nothing is lost there — refused all the same). Such an address is well formed and
// passes every other check, so it is asked before a withdrawal is proved. And, as the wallet's rule does for its own tokens, the
// contracts of the tokens that take ETH (the tenth review round, C10-8): the pool pays with a plain call, WETH's and stETH's payable
// fallbacks credit the caller — the pool, which cannot move a token — and rETH keeps what it is sent; the note is spent and the value
// stays there for good.
import { DEPLOYMENT } from "./pools";

export type RefusedRecipient = "zero" | "burn" | "protocol" | "token";

/** The mainnet token contracts whose fallback takes ETH from a plain call, lower case → the token's name. */
export const ETH_TAKING_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "stETH",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
  "0xae78736cd615f374d3085123a210448e74fc6393": "rETH",
});

/** The token a refused "token" recipient is (its name), or null. */
export const tokenOfRecipient = (address: string): string | null => ETH_TAKING_TOKENS[address.trim().toLowerCase()] ?? null;

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = "0x000000000000000000000000000000000000dead";

/** The four pools, the router and the verifier, lower case. */
export const protocolAddresses = (): string[] =>
  [...Object.values(DEPLOYMENT.pools).map((p) => String(p.address)), DEPLOYMENT.router.address, DEPLOYMENT.verifier.address].map((a) => a.toLowerCase());

export function refusedRecipient(address: string): RefusedRecipient | null {
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null; // not an address at all: that is another check's word
  if (a === ZERO) return "zero";
  if (a === BURN) return "burn";
  if (protocolAddresses().includes(a)) return "protocol";
  return ETH_TAKING_TOKENS[a] ? "token" : null;
}
