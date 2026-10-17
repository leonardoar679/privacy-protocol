// A note's owner key (the audit round of 2026-10-16, c18). A note made out to the privacy address's owner commitment is
// spent with the spend key; a deposited note is made out to its own (keys.ts deriveOwnerKey, from its secret). The key is
// chosen by owner-commitment equality, never by the note's kind or counter: change, merged and split notes, transfers
// received and every note made before deposits had their own keys carry the privacy address's. A note neither key opens
// is not this wallet's to spend: it is left out of a plan or a scan rather than failing the whole of it.
import { deriveOwnerKey, type WalletKeys } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import type { NotePlaintext } from "@privacy-wallet/protocol/envelope";

/** Thrown before anything is proved when a note to spend is made out to an owner commitment this wallet does not hold. */
export class NoOwnerKey extends Error {
  readonly code = "no_owner_key";
  constructor(leafIndex: number) {
    super(`the note at leaf ${leafIndex} is made out to an owner commitment this wallet does not hold`);
    this.name = "NoOwnerKey";
  }
}

/** The privacy address's owner commitment (inside pp1): transfers received and the wallet's private outputs. */
export const mainOwnerCommitment = (keys: Pick<WalletKeys, "spendKey">): bigint => ownerCommitmentOf(keys.spendKey);

/** A deposited note's own owner commitment, from its secret. */
export const depositOwnerCommitment = (keys: Pick<WalletKeys, "spendKey">, noteSecret: bigint): bigint =>
  ownerCommitmentOf(deriveOwnerKey(keys.spendKey, noteSecret));

/** The key that spends `note` — the spend key, or a deposited note's own key — or null when neither opens it. `main` spares recomputing the privacy address's commitment for every note. */
export function ownerKeyOf(keys: Pick<WalletKeys, "spendKey">, note: Note, main: bigint = mainOwnerCommitment(keys)): bigint | null {
  if (note.ownerCommitment === main) return keys.spendKey;
  let key: bigint;
  try {
    key = deriveOwnerKey(keys.spendKey, note.noteSecret);
  } catch {
    return null; // not a field element: no note of this wallet's
  }
  return ownerCommitmentOf(key) === note.ownerCommitment ? key : null;
}

/** An opened payload (core.ts openNotePayloads): its leaf, what it holds, and whether the privacy address's owner commitment reproduces the leaf. */
export interface Opening {
  leafIndex: number;
  plain: NotePlaintext;
  reproduces: boolean;
}

/**
 * The note an opened payload holds for this wallet: made out to the privacy address (the opening reproduced its leaf with
 * that), or a deposited note made out to its own owner commitment, derived here from the opened secret — kept only when it
 * reproduces `leaf`. Null otherwise: a payload encrypted to this wallet that lies about its leaf.
 */
export function ownedOpening(keys: Pick<WalletKeys, "spendKey">, o: Opening, leaf: bigint, main: bigint = mainOwnerCommitment(keys)): Note | null {
  if (o.reproduces) return { vaultId: o.plain.vaultId, amount: o.plain.amount, ownerCommitment: main, noteSecret: o.plain.noteSecret };
  let own: bigint;
  try {
    own = depositOwnerCommitment(keys, o.plain.noteSecret);
  } catch {
    return null;
  }
  const note: Note = { vaultId: o.plain.vaultId, amount: o.plain.amount, ownerCommitment: own, noteSecret: o.plain.noteSecret };
  return noteCommitment(noteBody(note), BigInt(o.leafIndex)) === leaf ? note : null;
}
