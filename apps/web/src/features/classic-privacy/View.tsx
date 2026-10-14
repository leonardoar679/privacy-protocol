// Classic Privacy's Views (spec v2.0 §7.11, §11.3; V6 Stage 14): the pools, a pool's status, a deposit recovered from a
// pasted note, the relayer choice with its fee and status. Pure: ./ClassicPrivacyUI.tsx drives them over the service.
import { Button, Card, Field, Input, ListRow, Page, StatusBadge, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";

export interface ClassicPoolLine {
  id: string;
  amount: string;
  symbol: string;
  size: string;
  deposits: number;
  mine: number;
}
export interface ClassicHomeModel {
  /** false in a build without classic pools (a production build until the contracts and their review arrive) */
  available: boolean;
  pools: ClassicPoolLine[];
}
export interface ClassicHomeActions {
  onOpen: (poolId: string) => void;
  onRecover: () => void;
  onRelayers: () => void;
  onBack?: () => void;
}

export function ClassicHomeView({ model: m, actions: a }: { model: ClassicHomeModel; actions: ClassicHomeActions }) {
  const t = useT();
  return (
    <Page title={t("route.classic")} back={a.onBack} testId="classic">
      <div className="ds-stack">
        <Card>
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("classic.fixedPool")}</h2>
            <p className="ds-note">{t("classic.intro")}</p>
            <p className="ds-note" data-testid="classic-separate">
              {t("classic.disclosure.separate")}
            </p>
          </div>
        </Card>
        {!m.available ? (
          <Card testId="classic-unavailable">
            <p className="ds-note">{t("classic.unavailable")}</p>
          </Card>
        ) : null}
        {m.available ? (
          <Card testId="classic-pools">
            {m.pools.map((p) => (
              <ListRow
                key={p.id}
                title={t("classic.poolTitle", { amount: p.amount, symbol: p.symbol })}
                subtitle={t("classic.poolLine", { size: p.size, deposits: p.deposits.toLocaleString("en-US"), mine: p.mine })}
                onPress={() => a.onOpen(p.id)}
                trailing={<StatusBadge tone="ok">{t("classic.status.ready")}</StatusBadge>}
                testId={`classic-pool-${p.id}`}
              />
            ))}
          </Card>
        ) : null}
        {m.available ? (
          <Card>
            <ListRow title={t("classic.home.recover")} subtitle={t("classic.recover.intro")} onPress={a.onRecover} testId="classic-recover-open" />
            <ListRow title={t("classic.home.relayers")} subtitle={t("classic.relayers.intro")} onPress={a.onRelayers} testId="classic-relayers-open" />
          </Card>
        ) : null}
      </div>
    </Page>
  );
}

export interface ClassicPoolStatusModel {
  size: string;
  deposits: number;
  rootAgeSeconds: number;
  health: "ready" | "stale";
  relayer: string;
  relayerFeePercent: number;
  /** "2 × 1 ETH", or null */
  mine: string | null;
}

/** A pool's status: its size, its deposits, how fresh its root is, the relayer and its fee, this wallet's position. */
export function ClassicPoolStatusView({ model: m }: { model: ClassicPoolStatusModel }) {
  const t = useT();
  return (
    <div className="ds-stack-sm" data-testid="classic-pool-status" data-health={m.health}>
      <div className="ds-kv">
        <span className="ds-kv-label">{t("classic.poolSize")}</span>
        <b className="ds-kv-value">{m.size}</b>
      </div>
      <div className="ds-kv">
        <span className="ds-kv-label">{t("classic.deposits")}</span>
        <b className="ds-kv-value">{m.deposits.toLocaleString("en-US")}</b>
      </div>
      <div className="ds-kv">
        <span className="ds-kv-label">{t("classic.pool.lastUpdate")}</span>
        <StatusBadge tone={m.health === "ready" ? "ok" : "warn"}>
          {t(m.health === "ready" ? "classic.pool.health.ready" : "classic.pool.health.stale", { minutes: Math.max(1, Math.round(m.rootAgeSeconds / 60)) })}
        </StatusBadge>
      </div>
      <div className="ds-kv">
        <span className="ds-kv-label">{t("classic.adv.relayer")}</span>
        <b className="ds-kv-value">{t("classic.relayers.line", { name: m.relayer, fee: m.relayerFeePercent })}</b>
      </div>
      <div className="ds-kv">
        <span className="ds-kv-label">{t("classic.yourPosition")}</span>
        <b className="ds-kv-value" data-testid="classic-mine">
          {m.mine ?? t("classic.none")}
        </b>
      </div>
    </div>
  );
}

/** A pool's two actions, stacked: a full-width label is never cut, in any language. */
export function ClassicPoolActions({ onDeposit, onWithdraw }: { onDeposit: () => void; onWithdraw: () => void }) {
  const t = useT();
  return (
    <div className="ds-stack-sm">
      <Button full onClick={onDeposit} data-testid="classic-protect">
        {t("classic.protect")}
      </Button>
      <Button full variant="secondary" onClick={onWithdraw} data-testid="classic-withdraw">
        {t("classic.withdrawPrivately")}
      </Button>
    </div>
  );
}

export interface ClassicRecoverModel {
  noteText: string;
  result:
    null | { ok: false; detail: string } | { ok: true; pool: string; status: "ready" | "withdrawn" | "not-found"; leaf: number | null; journaled: boolean };
}
export interface ClassicRecoverActions {
  onNote: (v: string) => void;
  onFind: () => void;
  onWithdraw?: () => void;
  onBack?: () => void;
}

const RECOVER_STATUS = {
  ready: "classic.recover.status.ready",
  withdrawn: "classic.recover.status.withdrawn",
  "not-found": "classic.recover.status.notFound",
} as const;

/** A deposit recovered from a pasted note (the note never leaves this device). */
export function ClassicRecoverView({ model: m, actions: a }: { model: ClassicRecoverModel; actions: ClassicRecoverActions }) {
  const t = useT();
  const r = m.result;
  return (
    <Page title={t("classic.recover.title")} back={a.onBack} testId="classic-recover">
      <div className="ds-stack">
        <Card>
          <div className="ds-stack-sm">
            <p className="ds-note">{t("classic.recover.intro")}</p>
            <Field label={t("classic.withdraw.note")} htmlFor="classic-recover-note">
              <Input
                id="classic-recover-note"
                value={m.noteText}
                onChange={(e) => a.onNote(e.target.value)}
                placeholder="tornado-eth-1-31337-0x…"
                autoComplete="off"
                spellCheck={false}
                data-testid="classic-recover-note"
              />
            </Field>
            <p className="ds-note">{t("classic.recover.local")}</p>
            {/* one primary per screen: once a withdrawable deposit is found, withdrawing is the next step */}
            <Button
              size="lg"
              full
              variant={r?.ok && r.status === "ready" && a.onWithdraw ? "secondary" : "primary"}
              onClick={a.onFind}
              disabled={!m.noteText.trim()}
              data-testid="classic-recover-find"
            >
              {t("classic.recover.find")}
            </Button>
          </div>
        </Card>
        {r && !r.ok ? (
          <p className="ds-field-error" data-testid="classic-recover-error">
            {r.detail}
          </p>
        ) : null}
        {r && r.ok ? (
          <Card testId="classic-recover-result" padding="md">
            <div className="ds-stack-sm" data-status={r.status}>
              <h2 className="ds-review-title">{r.pool}</h2>
              <div>
                <StatusBadge tone={r.status === "ready" ? "ok" : r.status === "withdrawn" ? "neutral" : "warn"}>{t(RECOVER_STATUS[r.status])}</StatusBadge>
              </div>
              {r.leaf !== null ? <p className="ds-note">{t("classic.recover.leaf", { leaf: r.leaf })}</p> : null}
              <p className="ds-note">{t(r.journaled ? "classic.recover.journaled" : "classic.recover.notJournaled")}</p>
              {r.status === "ready" && a.onWithdraw ? (
                <Button onClick={a.onWithdraw} data-testid="classic-recover-withdraw">
                  {t("classic.withdrawPrivately")}
                </Button>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}

export interface ClassicRelayerLine {
  id: string;
  name: string;
  feePercent: number;
  status: "online" | "offline" | "unknown";
}
export interface ClassicRelayersActions {
  onChoose: (id: string) => void;
  onBack?: () => void;
}

const RELAYER_STATUS = { online: "classic.relayers.online", offline: "classic.relayers.offline", unknown: "classic.relayers.unknown" } as const;

/** The relayer choice: each relayer's fee and whether it answers healthy; only an online one can be chosen. */
export function ClassicRelayersView({
  relayers,
  chosen,
  actions: a,
}: {
  relayers: ClassicRelayerLine[];
  chosen: string | null;
  actions: ClassicRelayersActions;
}) {
  const t = useT();
  return (
    <Page title={t("classic.relayers.title")} back={a.onBack} testId="classic-relayers">
      <div className="ds-stack">
        <p className="ds-note">{t("classic.relayers.intro")}</p>
        <Card testId="classic-relayer-list">
          {relayers.map((r) => (
            <ListRow
              key={r.id}
              title={r.name}
              subtitle={t("classic.relayers.fee", { fee: r.feePercent })}
              onPress={r.status === "online" ? () => a.onChoose(r.id) : undefined}
              trailing={
                <span className="ds-chips">
                  <StatusBadge tone={r.status === "online" ? "ok" : r.status === "offline" ? "warn" : "neutral"}>{t(RELAYER_STATUS[r.status])}</StatusBadge>
                  {chosen === r.id ? <StatusBadge tone="ok">{t("classic.relayers.chosen")}</StatusBadge> : null}
                </span>
              }
              testId={`classic-relayer-${r.id}`}
            />
          ))}
        </Card>
        {a.onBack ? (
          <TextButton onClick={a.onBack} data-testid="classic-relayers-done">
            {t("send.doneButton")}
          </TextButton>
        ) : null}
      </div>
    </Page>
  );
}
