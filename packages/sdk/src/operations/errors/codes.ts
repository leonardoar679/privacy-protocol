// The error catalog's data (Privacy Wallet Web spec §13; plan §38, §61): every code the relayer, its swap executor, the
// swap service, the wallet's own checks, the settlement tracker and the campaign can produce, with the class that decides
// the first sentence ("Your funds were not moved." / "Your funds are still protected." / "We are checking where your
// funds are.") and the actions offered — a retry is a new quote or a tracked resume, never a re-send. Pure (no imports
// but types), so the journal's upgrade can read it; ./catalog.ts adds `classify` over the wallet's error classes.
import type { FundsClass, OperationReason } from "../../wallet/operationRecord";
import type { RecoveryAction } from "../types";

/** A message key of the catalog (the app types it against its own catalog: apps/web/src/features/operations/index.ts). */
export type OpErrorKey = `op.error.${string}.title` | `op.error.${string}.reason`;

export type ErrorSource = "relayer" | "executor" | "service" | "wallet" | "tracker" | "campaign";
export interface CatalogRow {
  source: ErrorSource;
  fundsClass: FundsClass;
  actions: RecoveryAction[];
}

export const CATALOG: Record<string, CatalogRow> = {
  bad_proof: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_public_inputs: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_payloads: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  wrong_domain: { source: "relayer", fundsClass: "not-moved", actions: ["check-settings", "new-quote"] },
  payload_hash_mismatch: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  bad_fee: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_vault_not_accepted: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote", "check-settings"] },
  fee_note_mismatch: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_payload_unreadable: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_too_low: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  fee_below_percent: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  nullifier_in_flight: { source: "relayer", fundsClass: "still-protected", actions: ["resume-tracking"] },
  // V6 Stage 15 (doc §75): the relayer has no job spending these notes — after a lost answer, the submission never reached it
  unknown_nullifier: { source: "relayer", fundsClass: "still-protected", actions: ["review"] },
  simulation_failed: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  gas_too_high: { source: "relayer", fundsClass: "not-moved", actions: ["edit"] },
  reverted_before: { source: "relayer", fundsClass: "not-moved", actions: ["check-settings"] },
  send_failed: { source: "relayer", fundsClass: "unknown", actions: ["resume-tracking"] },
  too_large: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  rate_limited: { source: "relayer", fundsClass: "not-moved", actions: ["wait"] },
  unsupported_media_type: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  // a V6 follow-up of 2026-10-15: a body the relayer could not read as JSON; a service's own error, which says nothing of
  // itself (its words could carry an RPC's key) — its outcome unknown until the chain is read
  bad_json: { source: "relayer", fundsClass: "not-moved", actions: ["new-quote"] },
  internal: { source: "service", fundsClass: "unknown", actions: ["continue-monitoring"] },
  capacity: { source: "relayer", fundsClass: "not-moved", actions: ["wait"] },
  admin_closed: { source: "relayer", fundsClass: "not-moved", actions: ["wait", "check-settings"] },
  admin_token: { source: "relayer", fundsClass: "not-moved", actions: ["check-settings"] },
  bad_request: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_deadlines: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  deadline_too_close: { source: "executor", fundsClass: "still-protected", actions: ["new-quote"] },
  bad_execution: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_floors: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_payload: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_refund_tokens: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_signature: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  refund_payload_mismatch: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  unsupported_asset: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  // V6 Stage 12 (spec v2.0 §11.2): the shield executor's refusals — at the hand-over, before the execution: the funds wait in the escrow
  unknown_factory: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_params: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_payload: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  payload_mismatch: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  bad_deadline: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  receipt_conflict: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  no_vault: { source: "executor", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  unknown_shield: { source: "executor", fundsClass: "still-protected", actions: ["resume-tracking"] },
  shield_unavailable: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  // a V6 follow-up of 2026-10-15: the swap executor serves one deployment's factory, and none without SWAP_FACTORY
  unknown_swap_factory: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  swap_unavailable: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_refund_vault: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  // a V6 follow-up of 2026-10-16 (audit gap 47): the relayer executes and refunds only what the API vouched for
  unvouched_order: { source: "executor", fundsClass: "still-protected", actions: ["check-settings", "start-refund"] },
  bad_shield_receipt: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  minimum_moved: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  price_guard: { source: "service", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  // the eighth review round (2026-11-03, H1): today's executor tip is above twice the one the Review showed — no order was made
  tip_moved: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  // the eighth review round (2026-11-03): the swap service's open orders at its limit (A-M2); a re-sign's prepare a later one overtook
  // (A-L2); the price guard's competition could not run, so the prepare waits (D-L3); an order no route can stage in so many steps (M3)
  service_capacity: { source: "service", fundsClass: "not-moved", actions: ["wait"] },
  prepare_superseded: { source: "service", fundsClass: "still-protected", actions: ["resume-tracking"] },
  guard_unavailable: { source: "service", fundsClass: "still-protected", actions: ["wait", "start-refund"] },
  too_many_steps: { source: "service", fundsClass: "not-moved", actions: ["edit"] },
  no_quote: { source: "service", fundsClass: "not-moved", actions: ["wait", "new-quote"] },
  route_filtered: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_provider: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown_order: { source: "service", fundsClass: "still-protected", actions: ["resume-tracking", "start-refund"] },
  order_not_prepared: { source: "service", fundsClass: "still-protected", actions: ["new-quote"] },
  restore_unsigned: { source: "service", fundsClass: "still-protected", actions: ["resume-tracking"] },
  service_rejected: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  invalid_request: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  destination_not_protectable: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  // the service has the order's asset under another symbol or decimals, or not at all (a V6 follow-up of 2026-10-16): no order exists
  asset_mismatch: { source: "service", fundsClass: "not-moved", actions: ["check-settings"] },
  // a note to spend that neither the spend key nor a deposited note's own key opens (the audit round of 2026-10-16, c18):
  // refused before anything is proved
  no_owner_key: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // after a restore no note is made before one complete scan of the pool (wallet/notes.ts CountersHeld; PP-P03)
  notes_loading: { source: "wallet", fundsClass: "not-moved", actions: ["wait"] },
  // no estimate of a swap's gas (no fee read, no agreed price of the past day): no order is committed with its tips
  // unchecked (audit round 2, critic gap 4); nothing was sent, the wallet tries again
  cost_unknown: { source: "wallet", fundsClass: "not-moved", actions: ["wait"] },
  // the API's 502: the provider failed or answered what the engine will not build on (whale spec §16); the wallet tries again
  provider_unavailable: { source: "service", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // Mayan, the order's provider, quotes none of the committed route type while it quotes the other, at a rebuild or a prepare (the twelfth review
  // round, F12-1): another provider's other route is its provider_unavailable
  refund_route_unavailable: { source: "service", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  user_rejected: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  wallet_disconnected: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  chain_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  // the connected wallet changed accounts since the allowance was read (audit round 2, n53): refused before anything was sent
  account_changed: { source: "wallet", fundsClass: "not-moved", actions: ["check-wallet"] },
  rpc_disagreement: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings", "wait"] },
  receipt_disputed: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking", "check-settings"] },
  transport_refused: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  order_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  provider_call_mismatch: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  guest_instruction_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  housekeeping_needed: { source: "wallet", fundsClass: "not-moved", actions: ["housekeeping"] },
  execution_unavailable: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  // spec v2.0 §14.1: an order to be funded from older notes that no longer cover it is stopped before anything is sent
  older_notes_unavailable: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // a V6 follow-up of 2026-10-16: the relayer that would execute the order does not run it, so it is stopped before funding
  relayer_not_ready: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings", "new-quote"] },
  // a protected execution's step the relayer cannot fund (the fourth critique of slice 4): earlier steps may have swapped
  step_relayer_not_ready: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  // a V6 follow-up of 2026-10-16: a withdrawal to the zero or a burn address, or to a contract of the deployment or a token
  recipient_refused: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
  // a V6 follow-up of 2026-10-16: the order was confirmed under a key the swap service no longer takes; stopped before funding
  service_key_changed: { source: "service", fundsClass: "not-moved", actions: ["new-quote"] },
  // an older build committed the order under the privacy address's owner commitment (the audit round of 2026-10-16, c18)
  order_outdated: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // the provider's call read before a delayed funding does not do what was asked (the eleventh review round, D11-7): stopped, nothing sent
  call_refused: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // the order's funding is being proved or sent in this tab (the ninth review round, C-04; its row: the tenth, A10-8): nothing was changed
  funding_under_way: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // a protected execution's step whose commit failed, whatever the swap service answered (the third and fourth critiques of slice 4): nothing
  // of it was sent, and Resume commits it again; the wallet's own refusals before it asks keep their rows (journal_not_kept, journal_unreadable)
  commit_failed: { source: "service", fundsClass: "not-moved", actions: ["wait"] },
  // the swap service's tip codes (packages/swap-engine tips.ts; the eleventh review round's third critique of slice 4: without a row a swap below
  // the tip floor read "try again in a moment"): an amount too small for its execution's gas, gas prices or fees that could not be read
  amount_too_small: { source: "service", fundsClass: "not-moved", actions: ["edit"] },
  tip_unpriced: { source: "service", fundsClass: "not-moved", actions: ["wait"] },
  fee_history_unavailable: { source: "service", fundsClass: "not-moved", actions: ["wait"] },
  // a return the wallet cannot make itself (the eleventh review round's critique of E11-10; swapExecute.ts RefundRefusal): words that say what
  // to do — a wallet set to send its own transactions, a relayer that closed the order's job, a record without the refund's payload
  refund_needs_relayer: { source: "wallet", fundsClass: "still-protected", actions: ["check-settings"] },
  refund_not_watched: { source: "relayer", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  // a protected execution's step its relayer dropped (its order reads DROPPED), and a step whose return that relayer refused after a Resume (the
  // twelfth review round, XI's critique): the campaign's own words — one step not swapped beside steps that may have settled, Resume once another
  // relayer is chosen — never the single swap's
  step_dropped: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings"] },
  step_refund_not_watched: { source: "relayer", fundsClass: "still-protected", actions: ["check-settings"] },
  refund_payload_missing: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // the order was closed while its funding was proved (C-04; A10-8): read again at the send, nothing was sent
  order_closed: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // its refund note or signer is not this seed's (the tenth review round, D-1): never funded
  order_not_ours: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  tip_stale: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  // the relayer's fee rose above the one the Review showed: stopped before anything was proved (the audit round of 2026-10-16, c46)
  fee_moved: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // the spend needs more merges first than its Review named (the eighth review round, B-2): stopped before any merge was paid
  merges_moved: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // the order runner: a funding sent and never confirmed before the order's window closed (the notes unspent, or refunded)
  funding_unconfirmed: { source: "wallet", fundsClass: "still-protected", actions: ["new-quote"] },
  // a record whose own flow is gone (operations/stale.ts): stopped before anything was sent, or its transaction dropped
  interrupted: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // the wallet locked between two steps of a flow (a phone's handoff, another tab's unlock, an explicit lock): nothing more
  // was sent — at most an approval already confirmed, never the funds (the review round of 2026-11-02; "interrupted" is the
  // page's closing, whose words say so)
  locked_mid_flow: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // the wallet locked after the send reached the chain, while its receipt was awaited (the sixth review round, 2026-11-03): the
  // transaction stands; the record waits for the chain's word — the stale mover completes it at the next scan (a Protect from its note or
  // the connected wallet's own provider, never the endpoints: the eleventh review round, F11-10).
  // Before, it carried locked_mid_flow, "nothing moved", and the record failed as "start again": a second send paid twice
  locked_after_send: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // the connected wallet gave no receipt for a sent deposit — another network, reads that fail (WalletConnect's under the policy), ten
  // minutes without one (the eleventh review round, F11-10): the privacy endpoints are never asked about a transaction whose `from` is the
  // public address; the scan records its note as soon as the pool shows it (the record awaits it), and the record completes from it
  deposit_unconfirmed: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // ... nor for an approval before the deposit (another network, no provider, ten minutes): nothing was deposited — WalletConnect's
  // approvals, whose receipt is read from the first endpoint (audit gap 100), stop so when that read fails or finds none in three minutes —
  // a speed-up the wallet app made of the approval as well: the read follows its own hash only
  approval_unconfirmed: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // an approval prompt its wallet app did not answer — WalletConnect's request expiry, or its session ended while the prompt was open (the
  // twelfth review round, W6 §2 and the critique of A12-2): nothing was deposited, an approval it still sends leaves at most this amount
  // open, and the words say to decline it there — never to wait for it, as approval_unconfirmed's
  approval_unanswered: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // a WalletConnect request its wallet app did not answer within the sign client's fifteen minutes (`Request expired`, code 6; the twelfth
  // review round, A12-2 and B12-5 — read as quote_expired, "a fresh quote is needed", for a Protect that has none): withdrawn here, but the
  // wallet app may still show it, and one confirmed late still reaches the chain — the record waits for the chain's word, never "nothing was
  // sent"
  wallet_request_expired: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // a WalletConnect request open when the wallet app ended its session (6000, the sign client's rejection at the wallet app's delete — the
  // critique of B12-5: read wallet_disconnected, "nothing was sent", a Send's hold dropped and a second Protect let through): the wallet app
  // may have sent it before, so the record waits for the chain's word, as an expired request's
  wallet_session_ended: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  // a Protect with no note in the pool a day after it read deposit_unconfirmed (the twelfth review round, A12-3), or after it last moved for a
  // record that never read so, and no word from the wallet that sent it: it never reached the chain
  // (the critique of F11-10: it had read "We are checking where your funds are" for good); a note found later still enters the balance
  deposit_never_landed: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // a Send whose answer was lost and whose notes another operation of this wallet then spent (the sixth review round, 2026-11-03): the
  // pool's spend event names a call with other public inputs — this one can never land, and nothing of it was sent
  spent_elsewhere: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  journal_unreadable: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  journal_not_kept: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  transaction_dropped: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // a Protect past the drop limit that the wallet which sent it no longer knows, with no note of it in the pool's view (the twelfth review
  // round, A12-1): nothing moved as far as the wallet can tell — its own words, never a Send's "Send it again": a deposit replaced in the
  // wallet app (sped up) lands under another hash, its note found once in the scan's view; one still pending at that scan reaches this
  // verdict too, its card saying "Your funds were not moved" beside its reason's "as far as this wallet can tell" (ZG's critique; stated)
  deposit_dropped: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  // a V6 follow-up of 2026-10-17 (audit c31/c42): the transaction a spend was handed back spends other notes
  not_this_spend: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking"] },
  // sent as far as the chain can tell (the notes spent), the transaction not known here yet (the review round of 2026-11-02)
  outcome_unknown: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
  payout_held: { source: "wallet", fundsClass: "unknown", actions: ["check-wallet"] },
  unsafe_contract_call: { source: "wallet", fundsClass: "still-protected", actions: ["start-refund"] },
  // the order runner: a funded order whose execution window closed before its hand-over — the escrow only refunds now
  execution_window_closed: { source: "wallet", fundsClass: "still-protected", actions: ["start-refund"] },
  // the ninth review round (2026-11-04, C-09): a hand-over whose answer was lost, past its window, the escrow not holding the order
  handover_unknown: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring", "start-refund"] },
  deployment_mismatch: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  // the chain does not say what this build requires (deploymentGuard.ts; the eleventh review round): forgetting the remembered deployment
  // changes nothing, so its words offer no More → Advanced
  deployment_refused: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  insufficient_balance: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
  wallet_insufficient_funds: { source: "wallet", fundsClass: "not-moved", actions: ["edit"] },
  relayer_unreachable: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking", "check-settings"] },
  // no relayer of Settings serves the asset (the audit's unverified m56, 2026-10-17): refused before anything was sent
  no_relayer: { source: "wallet", fundsClass: "not-moved", actions: ["check-settings"] },
  // the light client's check failed before anything was proved (audit round 2, n38): a beacon API's refusal, a proof that
  // does not verify, the endpoints' tree against the proven pool — it had read as unknown, "We are checking where your funds are"
  verification_failed: { source: "wallet", fundsClass: "not-moved", actions: ["wait", "check-settings"] },
  quote_expired: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  order_expired: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  receipt_reverted: { source: "wallet", fundsClass: "not-moved", actions: ["review"] },
  deposit_not_found: { source: "wallet", fundsClass: "unknown", actions: ["resume-tracking"] },
  network_delayed: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  tracker_unknown: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring"] },
  provider_timeout: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring", "start-refund"] },
  destination_failed: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring", "start-refund"] },
  execute_failed: { source: "tracker", fundsClass: "still-protected", actions: ["new-quote", "start-refund"] },
  refund_failed: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring", "start-refund"] },
  partial_delivery: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  needs_attention: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring", "start-refund"] },
  late_refund: { source: "tracker", fundsClass: "still-protected", actions: ["continue-monitoring", "start-refund"] },
  // the provider's last word is a failure (or a refund to the escrow that never arrived) and the executor's watch ended with nothing
  // above dust in the escrow (the sixth review round, 2026-11-03): nothing more comes back on its own
  provider_failed: { source: "tracker", fundsClass: "unknown", actions: ["continue-monitoring"] },
  price_deviation: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  provider_error: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  chain_congestion: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring"] },
  route_degraded: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  unexpected_destination: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  security_incident: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  anomaly: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  reconcile: { source: "campaign", fundsClass: "unknown", actions: ["continue-monitoring"] },
  bounds: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  user_pause: { source: "campaign", fundsClass: "still-protected", actions: ["review"] },
  wallet_pause: { source: "campaign", fundsClass: "still-protected", actions: ["review"] },
  velocity: { source: "campaign", fundsClass: "still-protected", actions: ["continue-monitoring", "review"] },
  quote_ttl_short: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  provider_unhealthy: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote", "wait"] },
  slippage_too_wide: { source: "wallet", fundsClass: "not-moved", actions: ["new-quote"] },
  unknown: { source: "wallet", fundsClass: "unknown", actions: ["continue-monitoring"] },
};

export const CODES: readonly string[] = Object.keys(CATALOG);
export const hasCode = (code: string): boolean => Object.prototype.hasOwnProperty.call(CATALOG, code);
export const titleKey = (code: string): OpErrorKey => (hasCode(code) ? `op.error.${code}.title` : "op.error.unknown.title");
export const reasonKey = (code: string): OpErrorKey => (hasCode(code) ? `op.error.${code}.reason` : "op.error.unknown.reason");

/**
 * I-O6 (spec v2.0 §12.3): FAILED is final, so it is only for funds that did not move or are still protected and a
 * failure that leaves nothing to track or return (no resume, monitoring or refund among the code's actions); anything
 * else needs recovery. An unknown code is `unknown`.
 */
export function failureTarget(r: Pick<OperationReason, "code" | "fundsClass">): "FAILED" | "RECOVERY_REQUIRED" {
  if (r.fundsClass === "unknown" || !hasCode(r.code)) return "RECOVERY_REQUIRED";
  return CATALOG[r.code].actions.some((a) => a === "resume-tracking" || a === "continue-monitoring" || a === "start-refund") ? "RECOVERY_REQUIRED" : "FAILED";
}
