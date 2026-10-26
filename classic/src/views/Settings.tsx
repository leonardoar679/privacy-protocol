// The Settings page (the original's Settings.vue, extended): the RPC endpoints the build names, the relayers it lists,
// the language; and the availability of the selected pool's functions — each fact apart (spec v3.0 §7.7).
import { t, type LocaleChoice, type MessageKey } from "../app/i18n/messages";
import { poolOf, type PoolId } from "../model/pools";
import type { Availability, Check, PoolFunctionLive, RelayerInfo } from "../model/types";
import { percentOf } from "./Withdraw";
import { Badge, Card, Row } from "./ui";

const toneOf = (c: Check): "ok" | "warn" | "off" | "danger" => (c.state === "ok" ? "ok" : c.state === "warn" ? "warn" : "off");

export function AvailabilityCard(props: { pool: PoolId; availability: Availability | null; live: PoolFunctionLive }) {
  const a = props.availability;
  const pool = poolOf(props.pool);
  const rows: [keyof Omit<Availability, "pool">, string][] = [
    ["contract", t("availability.contract")],
    ["router", t("availability.router")],
    ["relayers", t("availability.relayers")],
    ["history", t("availability.history")],
    ["prover", t("availability.prover")],
    ["wallet", t("availability.wallet")],
  ];
  return (
    <Card title={`${t("availability.title")} · ${pool.amount} ETH`} testId="classic-availability">
      <p className="tc-text tc-muted">{t("availability.intro")}</p>
      {a ? (
        <div className="tc-facts">
          {rows.map(([key, label]) => (
            <Row
              key={key}
              label={label}
              testId={`classic-availability-${key}`}
              value={<Badge tone={toneOf(a[key])}>{t(a[key].text as MessageKey, a[key].params)}</Badge>}
            />
          ))}
          <Row
            label={t("availability.deposit")}
            testId="classic-availability-deposit"
            value={<Badge tone={props.live.deposit ? "ok" : "off"}>{t(props.live.deposit ? "availability.on" : "availability.off")}</Badge>}
          />
          <Row
            label={t("availability.withdraw")}
            testId="classic-availability-withdraw"
            value={<Badge tone={props.live.withdraw ? "ok" : "off"}>{t(props.live.withdraw ? "availability.on" : "availability.off")}</Badge>}
          />
        </div>
      ) : (
        <p className="tc-text tc-muted" aria-busy="true">
          {t("stats.loading")}
        </p>
      )}
    </Card>
  );
}

export function SettingsPage(props: {
  rpcUrls: string[];
  relayers: RelayerInfo[];
  localeChoice: LocaleChoice;
  onLocale: (c: LocaleChoice) => void;
  pool: PoolId;
  availability: Availability | null;
  live: PoolFunctionLive;
}) {
  return (
    <>
      <Card title={t("settings.title")} testId="classic-settings">
        <h3 className="tc-label">{t("settings.rpc")}</h3>
        {props.rpcUrls.length ? (
          <ul className="tc-plain-list" data-testid="classic-rpc-list">
            {props.rpcUrls.map((u) => (
              <li key={u} className="tc-mono">
                {hostOf(u)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="tc-text tc-muted" data-testid="classic-rpc-none">
            {t("settings.rpcNone")}
          </p>
        )}
        <h3 className="tc-label">{t("settings.relayers")}</h3>
        <p className="tc-text tc-muted">{t("settings.relayersNote")}</p>
        <ul className="tc-plain-list" data-testid="classic-settings-relayers">
          {props.relayers.map((r) => (
            <li key={r.id} className="tc-relayer-line">
              <span>{r.name}</span>
              <span className="tc-muted">{percentOf(r.feePercentE4)} %</span>
              <Badge tone={r.status === "online" ? "ok" : r.status === "offline" ? "danger" : "off"}>
                {t(r.status === "online" ? "relayer.online" : r.status === "offline" ? "relayer.offline" : "relayer.unknown")}
              </Badge>
            </li>
          ))}
        </ul>
        <h3 className="tc-label" id="classic-language-label">
          {t("settings.language")}
        </h3>
        <div className="tc-segmented" role="radiogroup" aria-labelledby="classic-language-label">
          {(["auto", "en", "ko"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={props.localeChoice === c}
              className={`tc-segment${props.localeChoice === c ? " tc-segment-active" : ""}`}
              data-testid={`classic-language-${c}`}
              onClick={() => props.onLocale(c)}
            >
              {t(c === "auto" ? "settings.languageAuto" : c === "en" ? "settings.languageEn" : "settings.languageKo")}
            </button>
          ))}
        </div>
      </Card>
      <AvailabilityCard pool={props.pool} availability={props.availability} live={props.live} />
    </>
  );
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
