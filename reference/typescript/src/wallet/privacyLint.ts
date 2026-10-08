// The privacy lint (whale spec §18, plan V2 §10, §48, §76): a per-transaction checklist computed before
// commit and again before signing, from the order, the journal and the scorecard facts — one function for
// the wallet and anything that wants to agree with it. Each item is ok / warn / block with a plain
// sentence and the plan §10 category it belongs to (the six things an observer might learn); a block item
// at tier ≥ high-value must be acknowledged before the hold-to-confirm is enabled, below that tier it is a
// warning with the same text. The categories map onto the engine's privacy factors: Financial privacy —
// sourceIdentity; Destination linkage — destinationIdentity + addressReuse; Provider visibility —
// providerVisibility + bridgeVisibility; Timing risk — timingCorrelation; Amount fingerprint —
// amountCorrelation; Network privacy — mempoolVisibility. Nothing here says "anonymous".
import { atLeast, type Tier } from "./valuation";

export type LintLevel = "ok" | "warn" | "block";
export type LintCategory = "Financial privacy" | "Destination linkage" | "Provider visibility" | "Timing risk" | "Amount fingerprint" | "Network privacy";
export type LintId = "source-not-reused" | "destination-fresh" | "destination-not-public-wallet" | "no-public-linkage" | "private-wallet-used" | "provider-identity-detached" | "timing" | "amount-fingerprint" | "minimum-protected" | "network" | "large-piece";

export interface LintItem { id: LintId; level: LintLevel; category: LintCategory; text: string; /** a block item the user acknowledged (tier ≥ high-value) */ acknowledged?: boolean }

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
  amountIsBucket: boolean;
  /** the hard quote's minimum is verified in the call and the approved minimum encoded; null before the hard quote */
  minOutVerified: boolean | null;
  privateSubmission: boolean;
  rpcEndpoints: number;
  lightClient: boolean;
  /** the public piece against the shipped bucket alphabet and the pool's deposit sizes; null when not applicable (a private transfer) */
  largePiece: { inAlphabet: boolean; holders: number | null } | null;
  acknowledged?: LintId[];
}

export const HOLDERS_FLOOR = 16;
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function lint(f: LintFacts): LintItem[] {
  const items: LintItem[] = [];
  const blockLevel: LintLevel = atLeast(f.tier, "high-value") ? "block" : "warn";
  const add = (id: LintId, level: LintLevel, category: LintCategory, text: string) => items.push({ id, level: level === "block" ? blockLevel : level, category, text, ...(level === "block" && f.acknowledged?.includes(id) ? { acknowledged: true } : {}) });

  add("source-not-reused", f.sourceIsPool ? "ok" : "block", "Financial privacy", f.sourceIsPool
    ? (f.action === "swap" ? "The source is a one-time escrow funded from your private balance; your permanent address appears nowhere." : "The source is your private balance; your permanent address appears nowhere.")
    : "The source is a public address: whoever watches it sees this payment.");
  add("private-wallet-used", f.sourceIsPool ? "ok" : "block", "Financial privacy", f.sourceIsPool ? "Spends private notes, proven in this wallet." : "Does not spend private notes.");

  if (f.destinationKind === "privacy-address") add("destination-fresh", "ok", "Destination linkage", "Pays a privacy address inside the pool: nothing about the recipient is public.");
  else if (f.destinationKind === "fresh") add("destination-fresh", "ok", "Destination linkage", "Pays a fresh address of this wallet, used once.");
  else add("destination-fresh", "warn", "Destination linkage", "The destination was entered by hand; whoever knows it knows this payment.");
  add("destination-not-public-wallet", f.destinationIsPublicWallet ? "block" : "ok", "Destination linkage", f.destinationIsPublicWallet
    ? "The destination is your connected public wallet: this payment and your public history become one."
    : "The destination is not your connected public wallet.");

  if (f.action === "swap") {
    if (f.linkPublic === null) add("no-public-linkage", "ok", "Provider visibility", "What the route publishes is known once a route is chosen.");
    else if (f.linkPublic) add("no-public-linkage", "warn", "Provider visibility", "This route settles publicly: the destination amount will be visible. Your private source stays protected, but timing and amount may be correlated.");
    else add("no-public-linkage", "ok", "Provider visibility", "The route keeps the escrow → destination link off public chains.");
    if (f.providerIdentityDetached === null) add("provider-identity-detached", "ok", "Provider visibility", "Quote requests carry no identity; the chosen provider learns the destination only at execution.");
    else if (f.providerIdentityDetached) add("provider-identity-detached", "ok", "Provider visibility", "Indicative quotes carried placeholders; only the chosen provider sees your fresh address.");
    else add("provider-identity-detached", "warn", "Provider visibility", "The quotes carried your destination to every provider asked.");
  }

  if (f.action === "transfer") add("timing", "ok", "Timing risk", "A private transfer has no public side to time.");
  else if (f.delaySeconds >= 6 * 3600) add("timing", "ok", "Timing risk", `Funded at a random time at least ${hours(f.delaySeconds)} after commit.`);
  else if (f.delaySeconds >= 3600) add("timing", "warn", "Timing risk", `Funded within ${hours(f.delaySeconds)} or more of commit: timing may correlate with your other activity.`);
  else add("timing", "warn", "Timing risk", "Acting without a delay links funding and action by time; a longer window widens the set.");

  if (f.action === "transfer") add("amount-fingerprint", "ok", "Amount fingerprint", "Private amounts show nothing.");
  else if (f.amountIsBucket) add("amount-fingerprint", "ok", "Amount fingerprint", "The public amount is a common size.");
  else add("amount-fingerprint", "warn", "Amount fingerprint", "An exact public amount is a fingerprint; a bucket size hides in the crowd.");

  if (f.action === "swap") {
    if (f.minOutVerified === null) add("minimum-protected", "ok", "Financial privacy", "The minimum you approve is checked in the provider call before this wallet signs.");
    else if (f.minOutVerified) add("minimum-protected", "ok", "Financial privacy", "The provider call guarantees at least the minimum you approved.");
    else add("minimum-protected", "block", "Financial privacy", "The provider call does not bind the minimum you approved.");
  }

  const missing = [...(f.privateSubmission ? [] : ["your connected wallet submits (its address is tied to the transaction)"]), ...(f.rpcEndpoints >= 2 ? [] : ["one RPC endpoint serves every read"]), ...(f.lightClient ? [] : ["no light client checks the pool"])];
  add("network", missing.length ? "warn" : "ok", "Network privacy", missing.length ? `Network: ${missing.join("; ")}.` : "A relayer submits, two or more endpoints must agree, the light client checks the pool.");

  if (f.largePiece) {
    if (f.largePiece.inAlphabet) add("large-piece", "ok", "Amount fingerprint", "The piece is within the common sizes.");
    else if (f.largePiece.holders === null) add("large-piece", "warn", "Amount fingerprint", "A piece above the common sizes: how many holders could pay it is not known until the pool's deposits are read.");
    else if (f.largePiece.holders >= HOLDERS_FLOOR) add("large-piece", "ok", "Amount fingerprint", `A large piece, but at least ${f.largePiece.holders} holders could pay it.`);
    else add("large-piece", "warn", "Amount fingerprint", `A whale among whales: only ${f.largePiece.holders} holder${f.largePiece.holders === 1 ? "" : "s"} could pay this piece; pieces over time widen the set (private balance maintenance).`);
  }
  return items;
}

/** Block items not yet acknowledged: while any remain, the confirmation stays disabled at tier ≥ high-value. */
export const unacknowledgedBlocks = (items: LintItem[]): LintItem[] => items.filter((i) => i.level === "block" && !i.acknowledged);
export const lintSummary = (items: LintItem[]): { ok: number; warn: number; block: number } => ({ ok: items.filter((i) => i.level === "ok").length, warn: items.filter((i) => i.level === "warn").length, block: items.filter((i) => i.level === "block").length });
