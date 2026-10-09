// What each value tier adds to a confirmation (whale spec §13, §24; plan V2 §4–§5, §11–§13, §66): the
// Review with the lint from enhanced, the simulation and the hold-to-confirm from high-value, the second
// factor from high-value-secondary, the review hold and the export at institutional. The words for an
// execution plan, the issuer line (plan §71) and the route kind (plan §72) live here too.
import { atLeast, type Tier } from "@ref/wallet/valuation";
import type { AssetRef, CompetitionEntry, ExecutionPlan } from "./swapService";
import type { StoredSwap } from "../wallet/journal";
import type { LintItem } from "@ref/wallet/privacyLint";
import type { Simulation } from "./simulate";

// Vite's env in the browser; under vitest the VITE_ keys live on process.env only (looked up through globalThis: no `process` in a browser, no node types here)
const nodeEnv = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}) as Record<string, string | undefined>;
const env: Record<string, string | undefined> = { ...nodeEnv, ...((import.meta as any).env ?? {}) };

export interface Controls {
  review: boolean; lint: boolean; simulation: boolean; hold: boolean; secondFactor: boolean; reviewHold: boolean; export: boolean; twoQuotes: boolean;
  /** V5 (Privacy Wallet Web spec §11), from `large-protected` ($50K): an entered destination confirmed group by group or taken from the book */
  destinationConfirm: boolean;
  /** V5: the §23 interstitial, the strict quote, the one-at-a-time limit, the recovery tracking */
  protectedExecution: boolean;
  /** V5: the provider's breaker closed, its security ≥ 60 and no incident within a day, else the next route */
  providerHealth: boolean;
  /** V5: the hard quote with at least PROTECTED_EXECUTION.MIN_QUOTE_TTL_S left and slippage capped at MAX_SLIPPAGE_BPS */
  strictQuote: boolean;
  /** V5: the operation polled while open; delayed and needs-attention states named */
  recoveryTracking: boolean;
  /** High-Value Protection spec §14: a protected execution (tranches under the in-flight cap) from high-value; at enhanced only when the service says `staged` */
  campaign: boolean;
  /** the destination lock, the address book and its cooling-off from high-value (§12) */
  destinationLock: boolean; coolingOff: boolean;
  /** institutional: the second factor on a separate device (a cross-platform WebAuthn credential, no password fallback) */
  secondDevice: boolean;
}

export const controlsFor = (tier: Tier): Controls => ({
  review: atLeast(tier, "large"),
  lint: atLeast(tier, "large"),
  simulation: atLeast(tier, "large-protected"),
  hold: atLeast(tier, "large-protected"),
  destinationConfirm: atLeast(tier, "large-protected"),
  protectedExecution: atLeast(tier, "large-protected"),
  providerHealth: atLeast(tier, "large-protected"),
  strictQuote: atLeast(tier, "large-protected"),
  recoveryTracking: atLeast(tier, "large-protected"),
  secondFactor: atLeast(tier, "high-value-secondary"),
  reviewHold: tier === "institutional",
  export: tier === "institutional",
  twoQuotes: atLeast(tier, "high-value"),
  campaign: atLeast(tier, "high-value"),
  destinationLock: atLeast(tier, "high-value"),
  coolingOff: atLeast(tier, "high-value"),
  secondDevice: tier === "institutional",
});

/** V5 (spec §11): what protected execution requires of an order at the $50K band and above. */
export const PROTECTED_EXECUTION = { MIN_QUOTE_TTL_S: 60, MAX_SLIPPAGE_BPS: 50, MAX_EXECUTE_WINDOW_S: 1800, MAX_IN_FLIGHT: 1, STEP_BPS: 2500, MAX_STEPS: 4, DELAYED_AT_ETA_MULTIPLE: 3, POLL_MS: 15_000 } as const;

/** The impact cap of spec §4 (lab-calibrated, Stage 1): a single-shot plan above it is refused by the engine when a stream exists; the Review repeats the figure. */
export const IMPACT_CAP_BPS = 50;
/** The pointer hold a high-value confirmation takes (plan §12: a tap is never enough); tests shorten it through VITE_HOLD_MS. */
export const HOLD_MS = Math.max(20, Number(env.VITE_HOLD_MS ?? 1500));
/** The institutional review hold: funding is scheduled no earlier than this cancel window (spec §24). */
export const REVIEW_HOLD_MINUTES = Math.max(1, Number(env.VITE_REVIEW_HOLD_MINUTES ?? 30));

/** The execution in the user's words (spec §24, item 4): never the provider's vocabulary. */
export function planWords(plan: ExecutionPlan | undefined): string {
  if (!plan || plan.mode === "single") return "Private route";
  if (plan.mode === "streaming" || plan.mode === "dca") return "Private streaming route";
  if (plan.mode === "auction") return "Private auction";
  return "Private intent route";
}

/** Issuer-controlled tokens (plan §71): the issuer line names the fact, the isolated vault the protection. */
const ISSUER_TOKENS: Record<string, string> = { USDC: "Circle", USDT: "Tether" };
export const issuerLine = (symbol: string): string | null => (ISSUER_TOKENS[symbol.toUpperCase()] ? "Issuer: centralized · Freeze risk: present · Vault: isolated" : null);

/** Plan §72: a route is native-to-native when neither side is an issuer-controlled token and no leg is wrapped. */
export const routeKind = (from: AssetRef, to: AssetRef, nativeAssets: boolean | undefined): "Native-to-native" | "Issuer-dependent" =>
  !ISSUER_TOKENS[from.symbol.toUpperCase()] && !ISSUER_TOKENS[to.symbol.toUpperCase()] && nativeAssets !== false ? "Native-to-native" : "Issuer-dependent";

/** The institutional export (spec §24): the order, its quotes and competition, the simulation and the lint, for an outside reviewer. Nothing secret: the refund payload and the attempt id stay out. */
export function exportOrderReview(stored: StoredSwap, extra: { competition?: CompetitionEntry[] | null; simulation?: Simulation | null; lint?: LintItem[] | null; exportedAt?: number } = {}): string {
  const { refundNoteData: _r, attemptId: _a, refundCounter: _c, ...order } = stored;
  const doc = {
    format: "privacy-protocol/order-review/v1",
    exportedAt: new Date(extra.exportedAt ?? Date.now()).toISOString(),
    order,
    competition: extra.competition ?? (stored as { competition?: unknown }).competition ?? null,
    simulation: extra.simulation ?? stored.simulation ?? null,
    lint: extra.lint ?? stored.lint?.items ?? null,
  };
  return JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
