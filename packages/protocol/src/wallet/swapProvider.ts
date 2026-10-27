// The swap provider facade (Privacy Wallet Web spec v3.0 §5; doc §7; V7 Stage 14): one interface, one name, shared by the
// engine (packages/swap-engine/src/provider.ts: a provider's id, its quote and its tracking over an adapter) and the wallet
// (packages/sdk/src/swapProvider.ts: all five calls over the service and the wallet's own checks). The types are generic:
// each side binds its own request, quote, prepared, validation and status shapes. The wallet validates — no provider validates
// itself —, and authorization is separate from submission: a status read never moves funds. Pure types, no dependencies
// beyond the frozen funds class.
import type { FundsClass } from "@privacy-wallet/protocol-types";

/** The owner's five recovery options (doc §7), each with the funds class it applies to. */
export const RECOVERY_OPTION_KINDS = ["accept-new-minimum", "return-funds", "continue-monitoring", "retry-hand-over", "view-progress"] as const;
export type RecoveryOptionKind = (typeof RECOVERY_OPTION_KINDS)[number];
export interface RecoveryOption {
  action: RecoveryOptionKind;
  /** what the option means for the funds: not moved, still protected (the escrow holds them and can return them), unknown (being
   *  checked, or with the provider); null once the swap was delivered */
  fundsClass: FundsClass | null;
}

/**
 * The facade's five calls (spec v3.0 §5). `Req` the quote request, `Q` the quote, `P` the prepared swap, `V` the validation,
 * `S` the status; `O` what a side needs beside the quote to prepare (the wallet's commit facts; the engine's side needs nothing).
 */
export interface SwapProvider<Req, Q, P, V, S, O = undefined> {
  readonly id: string;
  getQuote(request: Req): Promise<Q>;
  /** the two-phase commit: the order committed, then the provider call read — the prepared swap carries the order, the escrow and the call */
  prepare(quote: Q, options?: O): Promise<P>;
  /** the independent verification, where the wallet runs it; a provider never validates itself */
  validate(prepared: P): Promise<V>;
  /** a status read by the execution's id: never moves funds */
  getStatus(executionId: string): Promise<S>;
  /** the owner's options for the execution as it stands, each with the funds class it applies to */
  getRecoveryOptions(executionId: string): Promise<RecoveryOption[]>;
}
