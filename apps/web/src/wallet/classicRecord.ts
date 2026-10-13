// The classic deposit the journal keeps (Privacy Wallet Web spec §16): the optional `classic` field of the journal —
// never written by emptyJournal(), so every earlier journal and the pinned at-rest vectors stay valid. The module's
// own state; it never touches the notes of the protected balance.
export type ClassicStatus = "ready" | "pending" | "withdrawing" | "withdrawn" | "unavailable";

export interface ClassicDepositRecord {
  id: string;
  poolId: string;
  currency: string;
  /** the pool's fixed denomination, in the currency's units */
  amount: string;
  commitment: string;
  leafIndex: number;
  txHash: string;
  at: number;
  status: ClassicStatus;
  withdrawnTx?: string;
}
