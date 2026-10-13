// Home (spec v2.0 §7.1; doc §13–§14, §38): how much, whether it is protected, what the user can do — the protection
// badge and the gear, the protected balance, the assets, an open operation's card (executing, or action needed: an old
// failure never blocks Home), the "Protect your assets" card as the one primary action, Send and Swap as two
// secondary tiles, the recent activity. Pure: a view-model in, callbacks out (./model.ts builds it, ./fixtures.ts
// feeds the screenshots). The technical lines (maintenance, the core) show only in the Advanced experience.
import { AssetRow, Button, Card, Collapsible, IconButton, ListRow, Page, ProtectionBadge, StatusBadge, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Amt, STATUS_TONE, STATUS_WORD, Usd, type Amount, type Status } from "../viewKit";

export type ProtectionLevel = "high" | "medium" | "low";
export interface HomeAsset {
  amount: Amount;
  name: string;
  usdCents: bigint | null;
}
export interface HomeOperation {
  id: string;
  /** "ETH → BTC", "Private Send", "Protected USDC" */
  title: string;
  amount: Amount;
  usdCents: bigint | null;
  status: Extract<Status, "executing" | "action-needed" | "preparing">;
  /** the funds class allows "Your funds are safe." (spec §12.4); otherwise "We're checking on your funds." */
  fundsSafe: boolean;
}
export interface HomeRecent {
  id: string;
  title: string;
  amount: Amount;
  usdCents: bigint | null;
  status: Status;
}
export interface HomeModel {
  protection: ProtectionLevel;
  balance: { usdCents: bigint | null; state: "valued" | "loading" | "unavailable" };
  assets: HomeAsset[];
  /** open operations only, the newest first */
  operations: HomeOperation[];
  recent: HomeRecent[];
  /** after a return to the app: "Your ETH → BTC swap is still executing." */
  returning?: string | null;
  /** the Advanced experience's technical lines (maintenance, the core); absent in Simple */
  advanced?: string[] | null;
}
export interface HomeActions {
  onProtect: () => void;
  onSend: () => void;
  onSwap: () => void;
  onPrivacy: () => void;
  onSettings: () => void;
  onOperation: (id: string) => void;
}

const BADGE: Record<ProtectionLevel, MessageKey> = { high: "home.badge.high", medium: "home.badge.medium", low: "home.badge.low" };

export function HomeView({ model: m, actions: a, wide }: { model: HomeModel; actions: HomeActions; wide?: boolean }) {
  const t = useT();
  const empty = m.assets.length === 0;
  const balance =
    m.balance.state === "valued" && m.balance.usdCents !== null ? (
      m.balance.usdCents === 0n ? (
        "$0"
      ) : (
        <Usd cents={m.balance.usdCents} />
      )
    ) : m.balance.state === "loading" ? (
      "…"
    ) : (
      "—"
    );
  const money = (
    <>
      <Card padding="lg" testId="balance">
        <div className="ds-balance">
          <span className="ds-balance-amount" data-testid="private-usd" aria-live="polite">
            {balance}
          </span>
          <span className="ds-balance-label">{t("home.protectedBalance")}</span>
          {m.balance.state === "unavailable" && !empty ? <span className="ds-balance-sub">{t("home.usdUnavailable")}</span> : null}
        </div>
      </Card>
      {empty ? null : (
        <Card padding="md" testId="assets">
          {m.assets.map((x) => (
            <AssetRow
              key={x.amount.symbol}
              asset={{ symbol: x.amount.symbol, name: x.name }}
              amount={<Amt a={x.amount} />}
              usd={x.usdCents !== null ? <Usd cents={x.usdCents} /> : null}
              testId="asset-row"
            />
          ))}
        </Card>
      )}
    </>
  );
  const operations = m.operations.map((o) => (
    <Card key={o.id} padding="md" testId="operation-card">
      <div className="ds-op-card">
        <StatusBadge tone={STATUS_TONE[o.status]}>{t(o.status === "action-needed" ? "operation.actionNeeded" : "operation.executing")}</StatusBadge>
        <span className="ds-op-title">{o.title}</span>
        <span className="ds-op-amount">{o.usdCents !== null ? <Usd cents={o.usdCents} /> : <Amt a={o.amount} />}</span>
        {o.status === "action-needed" ? <span className="ds-op-funds">{t(o.fundsSafe ? "operation.fundsSafe" : "operation.checkingFunds")}</span> : null}
        <TextButton icon="chevron-right" onClick={() => a.onOperation(o.id)} data-testid="operation-open">
          {t(o.status === "action-needed" ? "operation.viewOperation" : "operation.viewProgress")}
        </TextButton>
      </div>
    </Card>
  ));
  const act = (
    <>
      <Card padding="md" testId="protect-card">
        <div className="ds-callout-text">
          <h2 className="ds-callout-title">{t("home.protectTitle")}</h2>
          <p className="ds-callout-body">{t("home.protectBody")}</p>
        </div>
        <div className="ds-card-action">
          <Button full icon="shield-plus" onClick={a.onProtect} data-testid="protect-cta">
            {t("home.protectCta")}
          </Button>
        </div>
      </Card>
      <div className="ds-actions">
        <Button variant="secondary" size="lg" icon="send" onClick={a.onSend} data-testid="home-send">
          {t("home.send")}
        </Button>
        <Button variant="secondary" size="lg" icon="swap" onClick={a.onSwap} data-testid="home-swap">
          {t("home.swap")}
        </Button>
      </div>
    </>
  );
  const recent = m.recent.length ? (
    <Card padding="md" testId="recent">
      <h2 className="ds-card-title">{t("home.recent")}</h2>
      {m.recent.map((r) => (
        <ListRow
          key={r.id}
          title={r.title}
          trailing={
            <span className="ds-row-end">
              <span className="ds-numeral">{r.usdCents !== null ? <Usd cents={r.usdCents} /> : <Amt a={r.amount} />}</span>
              <StatusBadge tone={STATUS_TONE[r.status]}>{t(STATUS_WORD[r.status])}</StatusBadge>
            </span>
          }
          onPress={() => a.onOperation(r.id)}
          testId="recent-row"
        />
      ))}
    </Card>
  ) : null;
  const advanced = m.advanced?.length ? (
    <Collapsible summary={t("home.advanced")} testId="home-advanced">
      {m.advanced.map((l) => (
        <p key={l} className="ds-note" data-testid="advanced-line">
          {l}
        </p>
      ))}
    </Collapsible>
  ) : null;
  return (
    <Page
      title={t("nav.home")}
      titleHidden
      width={wide ? "wide" : "phone"}
      testId="home"
      leading={
        <ProtectionBadge level={m.protection === "high" ? "High" : "Reduced"} label={t(BADGE[m.protection])} onPress={a.onPrivacy} testId="privacy-badge" />
      }
      actions={<IconButton label={t("home.settings")} icon="gear" onClick={a.onSettings} data-testid="home-settings" />}
    >
      {m.returning ? (
        <p className="ds-note" role="status" data-testid="home-returning">
          {m.returning}
        </p>
      ) : null}
      {wide ? (
        <div className="ds-columns">
          <div className="ds-column">
            {money}
            {act}
          </div>
          <div className="ds-column">
            {operations}
            {recent}
            {advanced}
          </div>
        </div>
      ) : (
        <>
          {money}
          {operations}
          {act}
          {recent}
          {advanced}
        </>
      )}
    </Page>
  );
}
