// Send (spec v2.0 §7.4; doc §24–§25): the asset, the amount, the destination with its four checks, what the recipient
// receives — largest —, the privacy fee and the relayer fee, one action: Review. A privacy address sends privately
// inside the pool, an EVM address is a public exit, a Bitcoin address continues as a cross-chain send; an address of
// another chain asks before anything changes — the selected network never changes silently. "Recipient receives
// exactly this amount" turns the amount into the exact output. Pure: the engine is wired under it by ./SendScreen.tsx
// (V6 Stage 10) through ./model.ts.
import type { ReactNode } from "react";
import { AddressInput, AmountInput, Button, Card, FeeLines, Page, Switch, TextButton, WarningCard, type CheckState } from "@privacy-wallet/ui";
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
  /**
   * `total`: exact output only — what leaves the balance for the typed amount to arrive; `relayerPaidByWallet`: submitted
   * through the connected wallet (Advanced), which pays the network itself — no fee note
   */
  quote: { receive: Amount; privacyFee: Amount; relayerFee: Amount; total?: Amount; relayerPaidByWallet?: boolean } | null;
  /** an address of another chain: the user confirms before the network changes */
  otherChain?: { chain: string } | null;
  /** V6 Stage 10: the address book's entries (a fresh address of this wallet first) */
  book?: { id: string; label: string; address: string }[];
  /** why the typed address is refused, in words */
  addressError?: string | null;
  /** whether the action can be taken (the screen's facts decide); absent: a quote and every check passing */
  canReview?: boolean;
  /** a Bitcoin or a confirmed other-chain destination continues as a cross-chain send */
  action?: "review" | "continue";
  /** the protected balance of the asset, when known */
  balance?: Amount | null;
  /** the amount in USD, when priced */
  amountUsd?: string | null;
  /** the amount is more than the protected balance */
  amountError?: string | null;
  /** a note under the destination (the connected wallet's own address) */
  destinationNote?: string | null;
  /** above the standard band: the transfer is reviewed before it is sent (or no price: treated as large) */
  notice?: string | null;
}
export interface SendActions {
  onAmount: (v: string) => void;
  onTo: (v: string) => void;
  onExact: (on: boolean) => void;
  onReview: () => void;
  onConfirmChain?: () => void;
  onPickEntry?: (id: string) => void;
  onAsset?: () => void;
  onMax?: () => void;
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

/** `addressStatus`: what the screen adds under the destination (the address book's status where it locks the destination). */
export function SendView({ model: m, actions: a, addressStatus }: { model: SendModel; actions: SendActions; addressStatus?: ReactNode }) {
  const t = useT();
  const ok = m.canReview ?? (!!m.quote && m.checks.every((c) => c.state === "ok") && !m.otherChain);
  return (
    <Page
      title={t("screen.send.title")}
      back={a.onBack}
      testId="send-view"
      primaryAction={
        <Button size="lg" full disabled={!ok} onClick={a.onReview} data-testid="send-review">
          {m.action === "continue" ? t("screen.send.continue") : t("screen.send.review")}
        </Button>
      }
    >
      <Card padding="md">
        <div className="ds-stack">
          <div className="ds-kv" data-testid="send-asset">
            <span className="ds-kv-label">{t("send.asset")}</span>
            <span className="ds-kv-value">
              {m.asset.symbol}
              {m.balance ? (
                <>
                  {" · "}
                  <Amt a={m.balance} rounding="down" />
                </>
              ) : null}
              {a.onAsset ? (
                <TextButton onClick={a.onAsset} data-testid="send-asset-change">
                  {t("protect.change")}
                </TextButton>
              ) : null}
            </span>
          </div>
          <AmountInput
            id="send-amount"
            label={t("screen.send.amount")}
            asset={{ symbol: m.asset.symbol, decimals: m.asset.decimals }}
            value={m.amount}
            onChange={a.onAmount}
            usd={m.amountUsd ?? null}
            onMax={a.onMax}
            maxLabel={t("protect.max")}
            error={m.amountError ? <span data-testid="send-amount-error">{m.amountError}</span> : undefined}
            testId="amount"
          />
          <AddressInput
            id="send-to"
            label={t("screen.send.to")}
            value={m.to}
            onChange={a.onTo}
            placeholder={t("screen.send.toPlaceholder")}
            checks={m.checks.map((c) => ({ label: t(CHECK[c.kind]), state: c.state }))}
            book={m.book}
            onPickEntry={a.onPickEntry}
            bookLabel={t("send.book")}
            error={m.addressError ? <span data-testid="send-address-error">{m.addressError}</span> : undefined}
            status={addressStatus}
            testId="address"
          />
          {m.destination ? (
            <p className="ds-note" role="status" data-testid="send-kind">
              {t(NOTE[m.destination])}
            </p>
          ) : null}
          {m.destinationNote ? (
            <p className="ds-note-warn" role="status" data-testid="send-destination-note">
              {m.destinationNote}
            </p>
          ) : null}
          {m.action === "continue" || m.otherChain ? null : (
            <Switch id="send-exact" checked={m.exact} onCheckedChange={a.onExact} label={t("screen.send.exact")} testId="send-exact" />
          )}
        </div>
      </Card>
      {m.notice ? (
        <p className="ds-note-warn" data-testid="send-large">
          {m.notice}
        </p>
      ) : null}
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
            receive={{ label: t("screen.send.recipientReceives"), value: <Amt a={m.quote.receive} rounding="down" />, testId: "send-receive" }}
            lines={[
              ...(m.quote.privacyFee.units > 0n
                ? [
                    {
                      label: t("screen.send.privacyFee"),
                      hint: t("screen.fee.percent"),
                      value: <Amt a={m.quote.privacyFee} rounding="up" />,
                      testId: "send-privacy-fee",
                    },
                  ]
                : []),
              {
                label: t("screen.send.relayer"),
                value: m.quote.relayerPaidByWallet ? t("screen.send.paidByWallet") : <Amt a={m.quote.relayerFee} rounding="up" approx />,
                testId: "send-relayer-fee",
              },
            ]}
            {...(m.quote.total ? { total: { label: t("fees.youSend"), value: <Amt a={m.quote.total} rounding="up" />, testId: "send-total" } } : {})}
          />
        </Card>
      ) : null}
    </Page>
  );
}
