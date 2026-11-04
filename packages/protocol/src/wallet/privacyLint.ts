// The privacy lint (whale spec §18, plan V2 §10, §48, §76): a per-transaction checklist computed before
// commit and again before signing, from the order, the journal and the scorecard facts — one function for
// the wallet and anything that wants to agree with it. Each item is ok / warn / block with a plain
// sentence and the plan §10 category it belongs to (the six things an observer might learn); a block item
// at tier ≥ high-value must be acknowledged before the hold-to-confirm is enabled, below that tier it is a
// warning with the same text. The categories map onto the engine's privacy factors: Financial privacy —
// sourceIdentity; Destination linkage — destinationIdentity + addressReuse; Provider visibility —
// providerVisibility + bridgeVisibility; Timing risk — timingCorrelation; Amount fingerprint —
// amountCorrelation; Network privacy — mempoolVisibility. Nothing here says "anonymous".
// Every sentence carries its code and values (`words`) for the app's catalog, which says it in the reader's language
// (audit round 2, r55); `text` is the English.
import { atLeast, type Tier } from "./valuation";

export type LintLevel = "ok" | "warn" | "block";
export type LintCategory = "Financial privacy" | "Destination linkage" | "Provider visibility" | "Timing risk" | "Amount fingerprint" | "Network privacy";
export type LintId = "source-not-reused" | "destination-fresh" | "destination-not-public-wallet" | "no-public-linkage" | "private-wallet-used" | "provider-identity-detached" | "timing" | "amount-fingerprint" | "minimum-protected" | "network" | "large-piece" | "same-size-consecutive" | "tranche-link" | "exact-cadence" | "destination-cooling";

export interface LintItem { id: LintId; level: LintLevel; category: LintCategory; text: string; /** the sentence by its code and values, for the app's catalog (lint() always sets it) */ words?: LintWords; /** a block item the user acknowledged (tier ≥ high-value) */ acknowledged?: boolean }

/** The lint's sentences by their codes (the app's catalog words each one). */
export const LINT_CODES = [
  "source-escrow", "source-private", "source-public", "notes-spent", "notes-not-spent",
  "dest-privacy-address", "dest-fresh", "dest-entered", "dest-public-wallet", "dest-not-public-wallet",
  "link-unknown", "link-public", "link-private", "identity-unknown", "identity-detached", "identity-shared",
  "timing-transfer", "timing-delayed", "timing-short", "timing-none",
  "amount-private", "amount-bucket", "amount-exact", "amount-whole-note", "minimum-checked", "minimum-bound", "minimum-unbound",
  "network-gaps", "network-private", "piece-common", "piece-unknown", "piece-covered", "piece-rare",
  "steps-bucket", "steps-same-size", "steps-varied", "steps-fresh", "steps-same-destination", "cadence-fixed", "cadence-random",
  "dest-cooling", "dest-ready",
] as const;
export type LintCode = (typeof LINT_CODES)[number];
/** What the network item names as missing. */
export const NETWORK_GAPS = ["wallet-submits", "one-endpoint", "no-light-client"] as const;
export type NetworkGap = (typeof NETWORK_GAPS)[number];
/** A sentence by its code and its values: a delay in seconds, a count of holders, the network's gaps. */
export interface LintWords { code: LintCode; delaySeconds?: number; holders?: number; gaps?: NetworkGap[] }

export interface LintFacts {
  action: "swap" | "withdraw" | "transfer";
  tier: Tier;
  /** the source is the pool (through a one-time escrow for a swap): always true for a private action */
  sourceIsPool: boolean;
  destinationKind: "fresh" | "entered" | "privacy-address";
  /** the destination is the connected public wallet's own address */
  destinationIsPublicWallet: boolean;
  /** the provider publishes the escrow → destination link; null when no route is chosen yet or the action is not a swap */
  linkPublic: boolean | null;
  /** the quote requests carried placeholders and no identifier (spec §5); null when unknown or not a swap */
  providerIdentityDetached: boolean | null;
  /** the scheduled delay (the window's lower bound), seconds */
  delaySeconds: number;
  /** the PUBLIC amount — what leaves the pool, the fee taken off — is a common size (the sixth review round, 2026-11-03: judged on the typed amount before, which the chain never shows) */
  amountIsBucket: boolean;
  /** the amount is one of this wallet's whole notes: what leaves equals that deposit less its fee, which an observer can match to the deposit (the sixth review round) */
  amountIsWholeNote?: boolean;
  /** the hard quote's minimum is verified in the call and the approved minimum encoded; null before the hard quote */
  minOutVerified: boolean | null;
  privateSubmission: boolean;
  rpcEndpoints: number;
  lightClient: boolean;
  /** the public piece against the shipped bucket alphabet and the pool's deposit sizes; null when not applicable (a private transfer) */
  largePiece: { inAlphabet: boolean; holders: number | null } | null;
  /** a protected campaign (V3 spec §11): what its tranches reveal; absent for a single order */
  campaign?: {
    sizing: "bucket" | "varied";
    /** two consecutive pieces of the same size under `varied` */
    consecutiveSameSize: boolean;
    /** every tranche pays its own fresh destination (false: one entered address links them all) */
    destinationPerTranche: boolean;
    /** the releases follow a fixed interval (the wallet never produces one) */
    cadenceFixed: boolean;
    /** the entered destination is not yet usable: unverified or in its cooling-off (§12) */
    destinationCooling: boolean;
  };
  acknowledged?: LintId[];
}

export const HOLDERS_FLOOR = 16;
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const GAP_TEXT: Record<NetworkGap, string> = { "wallet-submits": "your connected wallet submits (its address is tied to the transaction)", "one-endpoint": "one RPC endpoint serves every read", "no-light-client": "no light client checks the pool" };
type Said = [text: string, words: LintWords];
const say = (code: LintCode, text: string, more: Omit<LintWords, "code"> = {}): Said => [text, { code, ...more }];

export function lint(f: LintFacts): LintItem[] {
  const items: LintItem[] = [];
  const blockLevel: LintLevel = atLeast(f.tier, "high-value") ? "block" : "warn";
  const add = (id: LintId, level: LintLevel, category: LintCategory, [text, words]: Said) => items.push({ id, level: level === "block" ? blockLevel : level, category, text, words, ...(level === "block" && f.acknowledged?.includes(id) ? { acknowledged: true } : {}) });

  add("source-not-reused", f.sourceIsPool ? "ok" : "block", "Financial privacy", f.sourceIsPool
    ? (f.action === "swap" ? say("source-escrow", "The source is a one-time escrow funded from your private balance; your permanent address appears nowhere.") : say("source-private", "The source is your private balance; your permanent address appears nowhere."))
    : say("source-public", "The source is a public address: whoever watches it sees this payment."));
  add("private-wallet-used", f.sourceIsPool ? "ok" : "block", "Financial privacy", f.sourceIsPool ? say("notes-spent", "Spends private notes, proven in this wallet.") : say("notes-not-spent", "Does not spend private notes."));

  if (f.destinationKind === "privacy-address") add("destination-fresh", "ok", "Destination linkage", say("dest-privacy-address", "Pays a privacy address inside the pool: nothing about the recipient is public."));
  else if (f.destinationKind === "fresh") add("destination-fresh", "ok", "Destination linkage", say("dest-fresh", "Pays a fresh address of this wallet, used once."));
  else add("destination-fresh", "warn", "Destination linkage", say("dest-entered", "The destination was entered by hand; whoever knows it knows this payment."));
  add("destination-not-public-wallet", f.destinationIsPublicWallet ? "block" : "ok", "Destination linkage", f.destinationIsPublicWallet
    ? say("dest-public-wallet", "The destination is your connected public wallet: this payment and your public history become one.")
    : say("dest-not-public-wallet", "The destination is not your connected public wallet."));

  if (f.action === "swap") {
    if (f.linkPublic === null) add("no-public-linkage", "ok", "Provider visibility", say("link-unknown", "What the route publishes is known once a route is chosen."));
    else if (f.linkPublic) add("no-public-linkage", "warn", "Provider visibility", say("link-public", "This route settles publicly: the destination amount will be visible. Your private source stays protected, but timing and amount may be correlated."));
    else add("no-public-linkage", "ok", "Provider visibility", say("link-private", "The route keeps the escrow → destination link off public chains."));
    if (f.providerIdentityDetached === null) add("provider-identity-detached", "ok", "Provider visibility", say("identity-unknown", "Quote requests carry no identity; the chosen provider learns the destination only at execution."));
    else if (f.providerIdentityDetached) add("provider-identity-detached", "ok", "Provider visibility", say("identity-detached", "Indicative quotes carried placeholders; only the chosen provider sees your fresh address."));
    else add("provider-identity-detached", "warn", "Provider visibility", say("identity-shared", "The quotes carried your destination to every provider asked."));
  }

  if (f.action === "transfer") add("timing", "ok", "Timing risk", say("timing-transfer", "A private transfer has no public side to time."));
  else if (f.delaySeconds >= 6 * 3600) add("timing", "ok", "Timing risk", say("timing-delayed", `Funded at a random time at least ${hours(f.delaySeconds)} after commit.`, { delaySeconds: f.delaySeconds }));
  else if (f.delaySeconds >= 3600) add("timing", "warn", "Timing risk", say("timing-short", `Funded within ${hours(f.delaySeconds)} or more of commit: timing may correlate with your other activity.`, { delaySeconds: f.delaySeconds }));
  else add("timing", "warn", "Timing risk", say("timing-none", "Acting without a delay links funding and action by time; a longer window widens the set."));

  if (f.action === "transfer") add("amount-fingerprint", "ok", "Amount fingerprint", say("amount-private", "Private amounts show nothing."));
  else if (f.amountIsWholeNote) add("amount-fingerprint", "warn", "Amount fingerprint", say("amount-whole-note", "The amount is a whole note: what leaves equals one of your deposits less its fee, which an observer can match to that deposit. Spend another amount, or keep a remainder."));
  else if (f.amountIsBucket) add("amount-fingerprint", "ok", "Amount fingerprint", say("amount-bucket", "The public amount is a common size."));
  else add("amount-fingerprint", "warn", "Amount fingerprint", say("amount-exact", "An exact public amount is a fingerprint; a bucket size hides in the crowd."));

  if (f.action === "swap") {
    if (f.minOutVerified === null) add("minimum-protected", "ok", "Financial privacy", say("minimum-checked", "The minimum you approve is checked in the provider call before this wallet signs."));
    else if (f.minOutVerified) add("minimum-protected", "ok", "Financial privacy", say("minimum-bound", "The provider call guarantees at least the minimum you approved."));
    else add("minimum-protected", "block", "Financial privacy", say("minimum-unbound", "The provider call does not bind the minimum you approved."));
  }

  const gaps: NetworkGap[] = [...(f.privateSubmission ? [] : ["wallet-submits" as const]), ...(f.rpcEndpoints >= 2 ? [] : ["one-endpoint" as const]), ...(f.lightClient ? [] : ["no-light-client" as const])];
  add("network", gaps.length ? "warn" : "ok", "Network privacy", gaps.length ? say("network-gaps", `Network: ${gaps.map((g) => GAP_TEXT[g]).join("; ")}.`, { gaps }) : say("network-private", "A relayer submits, two or more endpoints must agree, the light client checks the pool."));

  if (f.largePiece) {
    if (f.largePiece.inAlphabet) add("large-piece", "ok", "Amount fingerprint", say("piece-common", "The piece is within the common sizes."));
    else if (f.largePiece.holders === null) add("large-piece", "warn", "Amount fingerprint", say("piece-unknown", "A piece above the common sizes: how many holders could pay it is not known until the pool's deposits are read."));
    else if (f.largePiece.holders >= HOLDERS_FLOOR) add("large-piece", "ok", "Amount fingerprint", say("piece-covered", `A large piece, but at least ${f.largePiece.holders} holders could pay it.`, { holders: f.largePiece.holders }));
    else add("large-piece", "warn", "Amount fingerprint", say("piece-rare", `A whale among whales: only ${f.largePiece.holders} holder${f.largePiece.holders === 1 ? "" : "s"} could pay this piece; pieces over time widen the set (private balance maintenance).`, { holders: f.largePiece.holders }));
  }

  if (f.campaign) {
    const c = f.campaign;
    if (c.sizing === "bucket") add("same-size-consecutive", "ok", "Amount fingerprint", say("steps-bucket", "Every step is a common size; equal consecutive steps are the design of this mode."));
    else if (c.consecutiveSameSize) add("same-size-consecutive", "warn", "Amount fingerprint", say("steps-same-size", "Two consecutive steps have the same size: a repeated size on a cadence is a pattern."));
    else add("same-size-consecutive", "ok", "Amount fingerprint", say("steps-varied", "No two consecutive steps have the same size."));
    add("tranche-link", c.destinationPerTranche ? "ok" : "warn", "Destination linkage", c.destinationPerTranche
      ? say("steps-fresh", "Each step pays its own fresh address: the steps are not linked by their destination.")
      : say("steps-same-destination", "Every step pays the same entered address: the destination links the steps publicly."));
    add("exact-cadence", c.cadenceFixed ? "block" : "ok", "Timing risk", c.cadenceFixed
      ? say("cadence-fixed", "The steps would follow a fixed interval: a clock is a fingerprint.")
      : say("cadence-random", "Each step is released after a random delay inside the mode's window."));
    add("destination-cooling", c.destinationCooling ? "block" : "ok", "Destination linkage", c.destinationCooling
      ? say("dest-cooling", "The entered destination is not usable for a large payment yet: verify it and let its cooling-off pass, or confirm an immediate use.")
      : say("dest-ready", "The destination is verified and out of its cooling-off, or it is this wallet's own."));
  }
  return items;
}

/** Block items not yet acknowledged: while any remain, the confirmation stays disabled at tier ≥ high-value. */
export const unacknowledgedBlocks = (items: LintItem[]): LintItem[] => items.filter((i) => i.level === "block" && !i.acknowledged);
export const lintSummary = (items: LintItem[]): { ok: number; warn: number; block: number } => ({ ok: items.filter((i) => i.level === "ok").length, warn: items.filter((i) => i.level === "warn").length, block: items.filter((i) => i.level === "block").length });
