// Home (spec §3.3; plan §5–§6, §83): money first — the protected balance in USD and the asset rows —, then the
// actions — Protect, Send, Swap —, then what is happening now — a running job, a protected swap, maintenance —,
// then the recent activity, and the technical detail behind "View details". The privacy status and the gear sit in
// the top bar. The USD read happens only once there are notes to value (never at first launch, sdk/prices.ts).
import { useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { formatUnits } from "viem";
import { availablePrice, formatUsd, usdOf } from "@ref/wallet/valuation";
import { AssetRow, BalanceCard, Button, Card, Collapsible, Icon, IconButton, ListRow, Page, ProtectionBadge, SecurityCard, StatusBadge, type StatusTone } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { useStatusLines } from "../more/statusLines";
import { assetsOf } from "../../sdk/assets";
import { priceStore, usePrices, valueOfBalances } from "../../sdk/prices";
import { activityOf, activityStatusLabel, KIND_LABELS } from "../../wallet/activity";
import { activeCampaigns, progressLine } from "../../wallet/campaigns";
import { housekeepingPlan, housekeepingSummary, pendingHousekeeping, plannedSteps } from "../../wallet/housekeeping";
import { useNotes } from "../../wallet/notes";
import { usePosture } from "../../wallet/posture";
import { useSchedulerStatus } from "../../wallet/schedule";
import { session, useSession } from "../../wallet/session";
import { PROTECTION_DEFAULTS, settings, useSettings } from "../../wallet/settings";
import { campaignStatus } from "../swap/protected/CampaignProgress";
import { PrivateBalance } from "../../components/PrivateBalance";
import { useConnection } from "./connection";

const toneOf = (status: string): StatusTone => (/completed|settled|refunded/i.test(status) ? (/refunded/i.test(status) ? "neutral" : "ok") : /fail|attention|cancel/i.test(status) ? "warn" : "pending");

export function Home() {
  const t = useT();
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  const notes = useNotes();
  const prices = usePrices();
  const running = useSchedulerStatus();
  const { housekeeping, protection, advanced } = useSettings();
  const posture = usePosture(deployment);
  const { coreLine } = useStatusLines(deployment);
  const s = useSession(); // the journal's activity, maintenance and campaigns re-render through it
  const [details, setDetails] = useState(false);
  const assets = assetsOf(deployment);
  const unspent = notes.filter((n) => !n.spent);
  const hasNotes = unspent.length > 0;
  const lines = assets.map((a) => ({ symbol: a.symbol, decimals: a.decimals, units: unspent.filter((n) => n.note.vaultId === BigInt(a.vault)).reduce((sum, n) => sum + n.note.amount, 0n) }));
  useEffect(() => { if (hasNotes) void priceStore.refresh(deployment); }, [deployment, hasNotes]);

  const headline = (() => {
    if (!hasNotes) return { big: "—", small: t("home.noBalance"), status: "unavailable" as const };
    if (prices.status === "not-configured" || prices.status === "idle") return { big: "—", small: t("home.usdUnavailable"), status: "unavailable" as const };
    const v = valueOfBalances(prices, lines);
    if (prices.status === "loading" && !v.valued) return { big: "≈ …", small: t("home.readingPrices"), status: "loading" as const };
    if (!v.valued) return { big: "—", small: t("home.priceUnavailable", { reason: prices.reason ? ` (${prices.reason})` : "" }), status: "unavailable" as const };
    return { big: `≈ ${formatUsd(v.usd)}`, small: v.unpriced.length ? t("home.unpriced", { assets: v.unpriced.join(", ") }) : t("home.valuedThrough"), status: "protected" as const };
  })();
  const rowUsd = (symbol: string, decimals: number, units: bigint): string | null => {
    const p = availablePrice(prices.prices, symbol);
    return p && units > 0n ? formatUsd(usdOf(units, decimals, p.usd1e8)) : null;
  };
  const campaigns = activeCampaigns();
  const recent = s.status === "unlocked" ? [...activityOf(session.journal())].sort((a, b) => b.at - a.at).slice(0, 3) : [];
  const maintenance = (() => {
    if (!hasNotes || !deployment) return null;
    const plans = housekeepingPlan(deployment);
    const steps = plannedSteps(plans);
    const pending = pendingHousekeeping();
    if (!steps && !pending) return null;
    if (!housekeeping.enabled) return t("home.maintenanceOff", { count: steps, unit: steps === 1 ? t("unit.step") : t("unit.steps") });
    const next = pending ? t("home.maintenanceNext", { at: new Date(pending.dueAt).toLocaleString() }) + (pending.error ? t("home.maintenanceFailed", { error: pending.error }) : "") : "";
    return t("home.maintenance", { summary: housekeepingSummary(plans) + next });
  })();
  const pauseLarge = (e: ChangeEvent<HTMLInputElement>) => settings.set({ protection: { ...protection, pauseLargeOperations: e.target.checked } });

  return (
    <Page title={t("app.name")} testId="home"
      status={<ProtectionBadge level={posture.overall === "Reduced" ? "Reduced" : "High"} label={t("privacy.badge")} onPress={() => navigate("/more/privacy")} testId="privacy-badge" />}
      actions={<IconButton label={t("home.settings")} icon="gear" onClick={() => navigate("/more/security")} />}>
      <BalanceCard label={t("home.protectedBalance")} amountUsd={headline.big} subline={headline.small} status={headline.status} amountTestId="private-usd" />
      {lines.some((l) => l.units > 0n) ? (
        <Card padding="md" testId="assets">
          {lines.filter((l) => l.units > 0n).map((l) => <AssetRow key={l.symbol} asset={{ symbol: l.symbol, name: t("chain.ethereum") }} amount={formatUnits(l.units, l.decimals)} usd={rowUsd(l.symbol, l.decimals, l.units)} testId="asset-row" />)}
        </Card>
      ) : null}
      {!hasNotes ? <SecurityCard icon="shield-plus" title={t("home.protectTitle")} body={t("home.protectBody")} action={<Button icon="shield-plus" onClick={() => navigate("/protect")} data-testid="protect-cta">{t("home.protectCta")}</Button>} testId="protect-card" /> : null}
      <div className="ds-actions">
        <Button size="lg" icon="send" onClick={() => navigate("/send")}>{t("home.send")}</Button>
        <Button size="lg" icon="swap" onClick={() => navigate("/swap")}>{t("home.swap")}</Button>
      </div>
      <Card padding="md">
        {hasNotes ? <ListRow title={t("home.addFunds")} leading={<Icon name="shield-plus" />} onPress={() => navigate("/protect")} testId="add-funds" /> : null}
        <ListRow title={t("home.receive")} leading={<Icon name="receive" />} onPress={() => navigate("/receive")} testId="receive" />
        <ListRow title={protection.enabled ? t("home.protection", { mode: PROTECTION_DEFAULTS[protection.mode].label }) : t("home.protectionOff")} subtitle={t("home.protectionWhy")} leading={<Icon name="shield-check" />} onPress={() => navigate("/more/advanced")} testId="protection-badge" />
      </Card>
      {running.running ? <p className="notice" role="status" data-testid="running-line">{running.running.line}</p> : null}
      {campaigns.map((c) => {
        const st = campaignStatus(c);
        return (
          <Card key={c.id} padding="md" testId="campaign-line">
            <p><b>{st.mark} {st.word}</b> · {t("home.protectedSwap", { from: c.request.from.symbol, to: c.request.to.symbol, line: progressLine(c, advanced) })}</p>
            <label className="ds-switch-row"><input type="checkbox" checked={protection.pauseLargeOperations} onChange={pauseLarge} data-testid="pause-large-operations" /><span>{t("home.pauseLarge")}</span></label>
          </Card>
        );
      })}
      {maintenance ? <p className="ds-field-hint" data-testid="maintenance">{maintenance}</p> : null}
      {recent.length ? (
        <Card padding="md" testId="recent">
          <h2 className="ds-security-title">{t("home.recent")}</h2>
          {recent.map((r) => <ListRow key={r.id} title={KIND_LABELS[r.kind]} subtitle={`${formatUnits(BigInt(r.amount), r.decimals)} ${r.asset}${r.note ? ` ${r.note}` : ""}`} trailing={<StatusBadge tone={toneOf(r.status)}>{activityStatusLabel(r)}</StatusBadge>} onPress={() => navigate("/activity")} testId="recent-row" />)}
        </Card>
      ) : null}
      <Collapsible summary={t("home.details")} testId="details" defaultOpen={details}>
        <PrivateBalance deployment={deployment} masterSeed={seed} account={account} />
        {advanced ? <p className="ds-field-hint" data-testid="core-line">{coreLine}</p> : null}
        <SecurityCard icon="globe" title={t("home.privateServices")} body={t("home.privateServicesWhy")} action={<Button variant="secondary" onClick={() => { setDetails(true); navigate("/more/ai"); }}>{t("home.privateAI")}</Button>} />
      </Collapsible>
    </Page>
  );
}
