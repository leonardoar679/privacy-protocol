// Classic Privacy — the module boundary (spec §16; plan §32–§33): a legacy compatibility module with its own state,
// never mixed with PrivacyCore. The pool interface the screens are built on, the deposit record the journal keeps
// (optional field `classic?`), the status words. This pass ships the screens on a devnet mock pool; the contracts, the
// circuit port, the proving keys and the legal review are a later pass.
import type { ClassicNote } from "@privacy-wallet/protocol/classic/note";

export type { ClassicStatus, ClassicDepositRecord } from "@privacy-wallet/sdk/wallet/classicRecord";
import type { ClassicDepositRecord, ClassicStatus } from "@privacy-wallet/sdk/wallet/classicRecord";

export interface ClassicPoolStats { size: string; deposits: number; rootAge: number }
export interface ClassicWithdrawal { poolId: string; recipient: string; relayer: string; fee: string; proof: string | null; root: string; nullifierHash: string; status: "proof-pending" | "ready" }

export interface ClassicPool {
  id: string;
  currency: string;
  /** the fixed denomination, in the currency's units */
  denomination: string;
  netId: number;
  stats(): ClassicPoolStats;
  deposit(note: ClassicNote, now?: number): ClassicDepositRecord;
  prepareWithdrawal(note: ClassicNote, recipient: string, relayer: string): ClassicWithdrawal;
  status(ref: string): ClassicStatus;
  /** Advanced: the commitment, the Merkle root, the root age, the relayer, the relayer fee, the proof status */
  advanced(): { root: string; rootAge: number; relayer: string; relayerFeeBps: number; proofStatus: string };
}

/** The disclosures before every classic deposit (spec §16). */
export const CLASSIC_DISCLOSURE_KEYS = ["classic.disclosure.fixed", "classic.disclosure.note", "classic.disclosure.public", "classic.disclosure.fee", "classic.disclosure.separate"] as const;
