// Security scoring with separate fields (High-Value Protection spec §10, plan V3 §114): "audited" is never a binary.
// The breakdown starts from the provider's baseline (which encodes its custody and bridge model, health.ts), subtracts
// the decaying incident penalties (V2 §16), and adjusts for what the risk database states — an audit that is recent or
// stale, a recent code change, a bug bounty, TVL, upgradeability. A field the database does not state adjusts nothing
// and is reported as unknown: missing data is never a hidden penalty, nor a hidden credit.
import { BASELINE_SECURITY } from "../health";
import type { ProviderId } from "../types";
import { riskDb, type Incident, type ProviderRiskRecord, type RiskDb } from "./riskDb";

export interface SecurityBreakdown {
  provider: string;
  baseline: number;
  /** the decaying penalties of the incidents on record (≤ 0) */
  incidents: number;
  audit: number;
  codeChange: number;
  bugBounty: number;
  tvl: number;
  upgradeability: number;
  total: number;
  fields: {
    custody?: string; bridgeModel?: string; validatorModel?: string; upgradeability?: string;
    audits: number; lastAudit: string | null; lastCodeChange: string | null; tvlUsd: number | null; volume30dUsd: number | null; bugBountyUsd: number | null; lastReviewed: string | null;
  };
  incidentList: Incident[];
}

export const INCIDENT_PENALTY: Record<string, number> = { "key-compromise": 25, bridge: 20, solver: 10, api: 10, liquidity: 10, other: 10 };
const DAY = 86_400_000;

/** The penalty of one incident at `now`: the class penalty decaying linearly to zero at halfLifeDays (V2 §16). */
export function incidentPenalty(inc: Incident, now: number): number {
  const ageDays = (now - Date.parse(inc.date)) / DAY;
  if (!(ageDays >= 0)) return 0;
  // an unknown class costs the most, never NaN (the ninth review round, A9-2: the loaders keep such a record, and it is charged this)
  return (Object.hasOwn(INCIDENT_PENALTY, inc.class) ? INCIDENT_PENALTY[inc.class] : INCIDENT_PENALTY["key-compromise"]) * Math.max(0, 1 - ageDays / inc.halfLifeDays);
}

export function securityBreakdown(provider: ProviderId | string, now = Date.now(), db: RiskDb = riskDb(), extraIncidents: Incident[] = []): SecurityBreakdown {
  const rec: ProviderRiskRecord | null = db.providerRisk(provider);
  const baseline = BASELINE_SECURITY[provider as ProviderId] ?? 70;
  const seen = new Set<string>();
  const incidentList = [...(rec?.securityEvents ?? []), ...extraIncidents.filter((i) => i.provider === provider)].filter((i) => { const k = `${i.provider}|${i.date}|${i.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const incidents = -incidentList.reduce((s, i) => s + incidentPenalty(i, now), 0);
  const lastAudit = rec?.audits?.length ? rec.audits.map((a) => a.date).sort().at(-1)! : null;
  const auditAgeDays = lastAudit ? (now - Date.parse(lastAudit)) / DAY : null;
  const audit = auditAgeDays === null ? 0 : auditAgeDays <= 365 ? 1 : auditAgeDays <= 730 ? 0 : -3;
  const codeChange = rec?.lastCodeChange && (now - Date.parse(rec.lastCodeChange)) / DAY < 30 ? -1 : 0;
  const bugBounty = (rec?.bugBounty?.usdMax ?? 0) >= 100_000 ? 1 : 0;
  const tvl = (rec?.tvlUsd ?? 0) >= 100_000_000 ? 1 : 0;
  const upgradeability = rec?.upgradeability === "immutable" ? 2 : rec?.upgradeability === "multisig" ? -1 : rec?.upgradeability === "admin" ? -3 : 0;
  const total = Math.max(0, Math.min(100, Math.round(baseline + incidents + audit + codeChange + bugBounty + tvl + upgradeability)));
  return {
    provider, baseline, incidents: Math.round(incidents * 100) / 100, audit, codeChange, bugBounty, tvl, upgradeability, total,
    fields: {
      custody: rec?.custody, bridgeModel: rec?.bridgeModel, validatorModel: rec?.validatorModel, upgradeability: rec?.upgradeability,
      audits: rec?.audits?.length ?? 0, lastAudit, lastCodeChange: rec?.lastCodeChange ?? null, tvlUsd: rec?.tvlUsd ?? null, volume30dUsd: rec?.volume30dUsd ?? null, bugBountyUsd: rec?.bugBounty?.usdMax ?? null, lastReviewed: rec?.lastReviewed ?? null,
    },
    incidentList,
  };
}

/** Days since the provider's most recent incident, or null. */
export function daysSinceIncident(provider: string, now = Date.now(), db: RiskDb = riskDb(), extra: Incident[] = []): number | null {
  const dates = [...(db.providerRisk(provider)?.securityEvents ?? []), ...extra.filter((i) => i.provider === provider)].map((i) => Date.parse(i.date)).filter((d) => d <= now);
  if (!dates.length) return null;
  return (now - Math.max(...dates)) / DAY;
}
