// Actual against estimated (Privacy Wallet Web spec v2.0 §3; doc §43): an operation's network cost as estimated before
// signing, as charged by the relayer (its F, in the fee's asset) and as really spent (gasUsed × effectiveGasPrice from
// this wallet's own receipt read). Two deviations are worth a note on the record: a real cost above 1.5 × the estimate
// (the estimate was too low — for a relayed operation, the relayer lost), and a charge of at least 3 × the real cost
// (the relayer over-charged). Comparable only in the same unit: a charge in a token is compared when it is ETH. Pure.
import type { OperationCosts } from "../wallet/operationRecord";

/** The notes a record's costs deserve (none when they cannot be compared). */
export function costNotes(c: OperationCosts): string[] {
  const notes: string[] = [];
  const estimated = c.estimatedWei !== undefined ? BigInt(c.estimatedWei) : null;
  const actual = c.actualWei !== undefined ? BigInt(c.actualWei) : null;
  if (estimated !== null && actual !== null && estimated > 0n && actual * 2n > estimated * 3n) notes.push("the network cost was more than 1.5 × the estimate");
  const chargedWei = c.charged && c.charged.asset === "ETH" && c.charged.decimals === 18 ? BigInt(c.charged.amount) : null;
  if (chargedWei !== null && actual !== null && actual > 0n && chargedWei >= actual * 3n) notes.push("the relayer charged at least 3 × the network cost");
  return notes;
}

/** Estimated − actual in wei (negative: it cost more than estimated); null without both. */
export function costDifference(c: OperationCosts): bigint | null {
  return c.estimatedWei !== undefined && c.actualWei !== undefined ? BigInt(c.estimatedWei) - BigInt(c.actualWei) : null;
}
