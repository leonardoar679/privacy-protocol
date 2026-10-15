// What the wallet's services keep (spec v2.0 §7.10, §15; V6 Stage 14): the API's record of a swap — the columns of its
// `operations` table, pinned against the schema by apps/api/test/schema.test.ts — grouped by what they say, and what the
// API never keeps. The Privacy Center's "Data sent to services" is generated from these lists and the transport's
// purpose registry (packages/privacy-engine/src/transport/http.ts PURPOSES), never written by hand.

/** The API's `operations` columns (a swap or a cross-chain swap only; nothing for a protect or a send), by group. */
export const API_OPERATION_FIELDS = {
  /** what is being swapped: the pair's network and asset, the amount, the tier */
  trade: ["network", "asset", "amount", "tier", "kind"],
  /** the order on chain: its id, its one-time escrow, its executor tip, its deadlines */
  order: ["order_id", "escrow", "executor_tip", "execute_deadline", "refund_after"],
  /** how it is going: the provider, the state, the settlement, the quote it came from */
  progress: ["provider", "state", "settlement", "quote_id"],
  /** the destination and the refund material — only until the order is signed, then nulled */
  untilSigned: ["order_blob"],
  /** bookkeeping */
  record: ["id", "created_at", "updated_at", "checked_at", "terminal_at"],
} as const;

/**
 * The API's record of a swap's execution once it is handed over: the columns of its `executions` and `relayer_jobs`
 * tables beside the operation's id (pinned against the schema like the operation's). A V6 follow-up of 2026-10-14: the
 * Privacy Center had listed the `operations` columns only, not the execution's transaction or the relayer's report.
 */
export const API_EXECUTION_FIELDS = {
  /** the execution: its transaction, the provider's reference for it, when it was handed over and its planned time */
  execution: ["execution_tx", "provider_ref", "finalized_at", "expected_seconds"],
  /** what the relayer last reported of it: the job's state, its transaction, its network cost and when it was read */
  job: ["state", "execution_tx", "actual_wei", "read_at"],
} as const;

export type ApiFieldGroup = keyof typeof API_OPERATION_FIELDS | keyof typeof API_EXECUTION_FIELDS;
/** Every group the Privacy Center words, in order: the operation's, then its execution's. */
export const API_FIELD_GROUPS = [...Object.keys(API_OPERATION_FIELDS), ...Object.keys(API_EXECUTION_FIELDS)] as ApiFieldGroup[];

/** Every column of the API's `operations` table, in no particular order. */
export const apiOperationColumns = (): string[] => Object.values(API_OPERATION_FIELDS).flat();

/** What the API never keeps (spec v2.0 §15; the schema test refuses a column for any of them). The relayer keeps its jobs
 *  and their transactions (one of them funds a swap); the Privacy Center's relayer row says so. */
export const NEVER_STORED = ["notes", "keys", "phrase", "witnesses", "balances", "address", "ip", "user-agent", "funding-transaction"] as const;
export type NeverStored = (typeof NEVER_STORED)[number];
