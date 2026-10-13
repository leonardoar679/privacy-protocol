// Send (spec v2.0 §7.4; doc §24–§25): the asset, the amount, the destination with its four checks, what the recipient
// receives — largest —, the privacy fee and the relayer fee, one action: Review. A privacy address sends privately
// inside the pool, an EVM address is a public exit, a Bitcoin address continues as a cross-chain send; an address of
// another chain asks before anything changes — the selected network never changes silently. "Recipient receives
// exactly this amount" turns the amount into the exact output. Pure: the engine is wired under it in Stage 10.
import { AddressInput, AmountInput, Button, Card, FeeLines, Page, Switch, WarningCard, type CheckState } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Amt, type Amount } from "../viewKit";

export type SendCheck = "valid" | "network" | "asset" | "format" | "btc-address" | "btc-network";
export interface SendModel {
  asset: { symbol: string; decimals: number };
  amount: string;
  to: string;
  checks: { kind: SendCheck; state: CheckState }[];
  /** what kind of transfer the destination makes */
  destination: "private" | "public" | "bitcoin" | null;
  exact: boolean;
  quote: { receive: Amount; privacyFee: Amount; relayerFee: Amount } | null;
  /** an address of another chain: the user confirms before the network changes */
  otherChain?: { chain: string } | null;
}
export interface SendActions {
  onAmount: (v: string) => void;
  onTo: (v: string) => void;
  onExact: (on: boolean) => void;
  onReview: () => void;
  onConfirmChain?: () => void;
  onBack?: () => void;
}

const CHECK: Record<SendCheck, MessageKey> = {
  valid: "screen.send.check.valid",
  network: "screen.send.check.network",
  asset: "screen.send.check.asset",
  format: "screen.send.check.format",
  "btc-address": "screen.send.check.btcAddress",
  "btc-network": "screen.send.check.btcNetwork",
};
const NOTE: Record<NonNullable<SendModel["destination"]>, MessageKey> = {
  private: "screen.send.private",
  public: "screen.send.public",
  bitcoin: "screen.send.bitcoin",
};

export function SendView({ model: m, actions: a }: { model: SendModel; actions: SendActions }) {
  const t = useT();
  const ok = !!m.quote && m.checks.every((c) => c.state === "ok") && !m.otherChain;
  return (
    <Page
      title={t("screen.send.title")}
      back={a.onBack}
      testId="send-view"
      primaryAction={
        <Button size="lg" full disabled={!ok} onClick={a.onReview} data-testid="send-review">
          {t("screen.send.review")}
        </Button>
      }
    >
      <Card padding="md">
        <div className="ds-stack">
          <AmountInput
            id="send-amount"
            label={t("screen.send.amount")}
            asset={{ symbol: m.asset.symbol, decimals: m.asset.decimals }}
            value={m.amount}
            onChange={a.onAmount}
            testId="amount"
          />
          <AddressInput
            id="send-to"
            label={t("screen.send.to")}
            value={m.to}
            onChange={a.onTo}
            placeholder={t("screen.send.toPlaceholder")}
            checks={m.checks.map((c) => ({ label: t(CHECK[c.kind]), state: c.state }))}
            testId="address"
          />
          {m.destination ? (
            <p className="ds-note" data-testid="send-kind">
              {t(NOTE[m.destination])}
            </p>
          ) : null}
          <Switch id="send-exact" checked={m.exact} onCheckedChange={a.onExact} label={t("screen.send.exact")} />
        </div>
      </Card>
      {m.otherChain ? (
        <WarningCard
          title={t("screen.send.otherChainTitle", { chain: m.otherChain.chain })}
          body={t("screen.send.otherChainBody")}
          action={
            a.onConfirmChain ? (
              <Button variant="secondary" onClick={a.onConfirmChain} data-testid="send-confirm-chain">
                {t("screen.send.otherChainConfirm", { chain: m.otherChain.chain })}
              </Button>
            ) : undefined
          }
          testId="send-other-chain"
        />
      ) : null}
      {m.quote ? (
        <Card padding="md">
          <FeeLines
            receive={{ label: t("screen.send.recipientReceives"), value: <Amt a={m.quote.receive} />, testId: "send-receive" }}
            lines={[
              {
                label: t("screen.send.privacyFee"),
                hint: t("screen.fee.percent"),
                value: <Amt a={m.quote.privacyFee} rounding="up" />,
                testId: "send-privacy-fee",
              },
              { label: t("screen.send.relayer"), value: <Amt a={m.quote.relayerFee} rounding="up" approx />, testId: "send-relayer-fee" },
            ]}
          />
        </Card>
      ) : null}
    </Page>
  );
}
