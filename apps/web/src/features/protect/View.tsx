// Protect (spec v2.0 §7.3; doc §22–§23): one page before confirmation — from the external wallet (its account and
// balance) into the protected balance, the amount typed once, then what the user receives, the 1 % privacy fee and the
// relayer / network estimate, and one action: Review. Pure: a view-model in, callbacks out; the engine is wired under
// it in Stage 10 (the V5 screen stays in ./Protect.tsx until then).
import { AddressChip, Button, Card, FeeLines, FlowCard, Page, TextButton, cleanAmount } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { Amt, Usd, type Amount } from "../viewKit";

export interface ProtectModel {
  /** the connected external wallet: its account and its balance of the asset */
  source: { account: string | null; balance: Amount | null };
  asset: { symbol: string; decimals: number };
  /** the amount as typed */
  amount: string;
  quote: { receive: Amount; privacyFee: Amount; networkUsdCents: bigint | null } | null;
  error: "insufficient" | "too-small" | null;
}
export interface ProtectActions {
  onAmount: (v: string) => void;
  onAsset: () => void;
  onMax?: () => void;
  onReview: () => void;
  onBack?: () => void;
}

export function ProtectView({ model: m, actions: a }: { model: ProtectModel; actions: ProtectActions }) {
  const t = useT();
  const input = (
    <input
      className="ds-amount-input"
      inputMode="decimal"
      autoComplete="off"
      placeholder="0"
      aria-label={t("screen.protect.amount")}
      aria-invalid={m.error ? true : undefined}
      value={m.amount}
      onChange={(e) => {
        const v = cleanAmount(e.target.value, m.asset.decimals);
        if (v !== null) a.onAmount(v);
      }}
      data-testid="amount-input"
    />
  );
  return (
    <Page
      title={t("protect.title")}
      back={a.onBack}
      testId="protect-view"
      primaryAction={
        <Button size="lg" full disabled={!m.quote || !!m.error} onClick={a.onReview} data-testid="protect-review">
          {t("screen.protect.review")}
        </Button>
      }
    >
      <FlowCard
        testId="protect-flow"
        from={{
          label: t("screen.protect.from"),
          asset: { symbol: m.asset.symbol },
          network: t("screen.protect.externalWallet"),
          onAsset: a.onAsset,
          assetLabel: t("screen.protect.chooseAsset"),
          children: input,
          sub: (
            <span className="ds-flow-source">
              {m.source.account ? <AddressChip address={m.source.account} /> : null}
              {m.source.balance ? (
                <span>
                  {t("screen.protect.balance")} <Amt a={m.source.balance} />
                </span>
              ) : null}
              {a.onMax && m.source.balance ? (
                <TextButton onClick={a.onMax} data-testid="protect-max">
                  {t("common.max")}
                </TextButton>
              ) : null}
            </span>
          ),
          testId: "protect-from",
        }}
        to={{
          label: t("screen.protect.to"),
          asset: { symbol: m.asset.symbol },
          network: t("screen.protect.protected"),
          children: m.quote ? <Amt a={m.quote.receive} bare /> : "—",
          testId: "protect-to",
        }}
      />
      {m.error ? (
        <p className="ds-field-error" role="alert" data-testid="protect-error">
          {t(m.error === "insufficient" ? "screen.protect.insufficient" : "screen.protect.tooSmall")}
        </p>
      ) : null}
      {m.quote ? (
        <Card padding="md">
          <FeeLines
            receive={{ label: t("screen.protect.youReceive"), value: <Amt a={m.quote.receive} />, testId: "protect-receive" }}
            lines={[
              {
                label: t("screen.protect.privacyFee"),
                hint: t("screen.fee.percent"),
                value: <Amt a={m.quote.privacyFee} rounding="up" />,
                testId: "protect-privacy-fee",
              },
              {
                label: t("screen.protect.network"),
                value: m.quote.networkUsdCents !== null ? <Usd cents={m.quote.networkUsdCents} approx /> : "—",
                testId: "protect-network-fee",
              },
            ]}
          />
        </Card>
      ) : null}
    </Page>
  );
}
