// Why an address must not receive a withdrawal, or null (the fourth review round, 2026-11-03) — the Privacy Wallet's rule
// (packages/protocol/src/wallet/destinations.ts), its twin here: rule 9 keeps the two source trees apart. The zero and the burn
// address lose what they receive — the pool's `withdraw` pays with a plain call, which succeeds at an address without code, so a
// zero recipient burns the denomination and spends the note; the pools, the router and the verifier keep what they receive with
// no way back (a plain call to them reverts, so nothing is lost there — refused all the same). Such an address is well formed and
// passes every other check, so it is asked before a withdrawal is proved.
import { DEPLOYMENT } from "./pools";

export type RefusedRecipient = "zero" | "burn" | "protocol";

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
  return protocolAddresses().includes(a) ? "protocol" : null;
}
