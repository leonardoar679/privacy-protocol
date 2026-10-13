// Campaign alerts (High-Value Protection spec §15; plan V3 §76): provider degraded, price changed, liquidity dropped,
// destination changed, route changed, execution delayed, chain congested, security incident, paused, step settled —
// journaled on the campaign (the local audit trail of §9) and delivered through wallet/notifications.ts. Pure here:
// the runner journals the campaign it gets back and calls notify itself.
import type { AlertKind, Campaign, CampaignAlert, PauseReason } from "@privacy-wallet/protocol/wallet/campaign";

export const ALERT_TITLES: Record<AlertKind, string> = {
  "provider-degraded": "Provider degraded",
  "price-changed": "Price changed",
  "liquidity-dropped": "Liquidity dropped",
  "destination-changed": "Destination changed",
  "route-changed": "Route changed",
  "execution-delayed": "Execution delayed",
  "chain-congested": "Network congested",
  "security-incident": "Security incident",
  paused: "Paused",
  resumed: "Resumed",
  "step-settled": "Step settled",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The alert a pause reason raises (§8 → §15). */
export function alertKindFor(reason: PauseReason, detail = ""): AlertKind {
  switch (reason) {
    case "price-deviation": return "price-changed";
    case "provider-error": return "provider-degraded";
    case "chain-congestion": return "chain-congested";
    case "route-degraded": return "liquidity-dropped";
    case "unexpected-destination": return "destination-changed";
    case "security-incident": return "security-incident";
    case "anomaly": return /longer than expected/i.test(detail) ? "execution-delayed" : "paused";
    default: return "paused";
  }
}

const MAX_ALERTS = 200;

/** The campaign with one more alert (newest last; the oldest beyond MAX_ALERTS are dropped). */
export function withAlert(c: Campaign, kind: AlertKind, text: string, at: number, trancheIndex?: number): Campaign {
  const alert: CampaignAlert = { kind, at, text, ...(trancheIndex !== undefined ? { trancheIndex } : {}) };
  return { ...c, alerts: [...(c.alerts ?? []), alert].slice(-MAX_ALERTS) };
}

/** The alerts since `since` (unix ms), newest last. */
export const alertsSince = (c: Campaign, since: number): CampaignAlert[] => (c.alerts ?? []).filter((a) => a.at > since);
