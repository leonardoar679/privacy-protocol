// Swap and cross-chain (spec v2.0 §7.5; doc §26, §29–§33): what you pay → what you receive, then the facts a beginner
// needs — the minimum, the protection, the fees, the time —, the "Best protected route" (the provider and the route
// are Advanced's), one action: Review Swap. A same-chain swap lands in the protected balance; a cross-chain one names
// its destination with three checks and leads with "You'll receive at least". An expired quote says so, and that the
// funds were not moved. The time is the quote's own estimate, never a constant. Pure: wired in Stage 11.
import { AddressChip, Button, Card, FlowCard, Page, ProtectionBadge, StateScreen, TextButton, cleanAmount } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Amt, Usd, type Amount } from "../viewKit";

export type Level = "high" | "medium" | "low";
export interface SwapModel {
  pay: { symbol: string; decimals: number; amount: string; balance: Amount | null };
  receive: { symbol: string; chain: string };
  quote:
    | { kind: "same-chain"; expected: Amount; minimum: Amount; protection: Level; feesUsdCents: bigint; eta: [number, number] }
    | {
        kind: "cross-chain";
        expected: Amount;
        minimum: Amount;
        protection: Level;
        fees: { privacyUsdCents: bigint; relayerUsdCents: bigint; providerUsdCents: bigint };
        eta: [number, number];
        destination: { address: string; checks: { valid: boolean; network: boolean; compatible: boolean } };
      }
    | null;
  expired?: boolean;
}
export interface SwapActions {
  onAmount: (v: string) => void;
  onPayAsset: () => void;
  onReceiveAsset: () => void;
  onSwitch?: () => void;
  onReview: () => void;
  onNewQuote: () => void;
  onCompare?: () => void;
}

const LEVEL: Record<Level, MessageKey> = { high: "screen.swap.protectionHigh", medium: "screen.swap.protectionMedium", low: "screen.swap.protectionLow" };

/** "About 2 min", "2–5 min": the quote's own range, in minutes. */
function etaWords(eta: [number, number], t: ReturnType<typeof useT>): string {
  const [lo, hi] = eta.map((s) => Math.max(1, Math.round(s / 60)));
  return lo === hi ? t("screen.swap.etaAbout", { min: lo }) : t("screen.swap.etaRange", { lo, hi });
}

export function SwapView({ model: m, actions: a }: { model: SwapModel; actions: SwapActions }) {
  const t = useT();
  if (m.expired) {
    return (
      <Page title={t("screen.swap.title")} testId="swap-view">
        <Card>
          <StateScreen
            kind="error"
            title={t("screen.swap.expiredTitle")}
            body={t("screen.swap.expiredBody")}
            actions={
              <Button onClick={a.onNewQuote} data-testid="swap-new-quote">
                {t("screen.swap.newQuote")}
              </Button>
            }
            testId="swap-expired"
          />
        </Card>
      </Page>
    );
  }
  const q = m.quote;
  const cross = q?.kind === "cross-chain";
  const input = (
    <input
      className="ds-amount-input"
      inputMode="decimal"
      autoComplete="off"
      placeholder="0"
      aria-label={t("screen.swap.youPay")}
      value={m.pay.amount}
      onChange={(e) => {
        const v = cleanAmount(e.target.value, m.pay.decimals);
        if (v !== null) a.onAmount(v);
      }}
      data-testid="amount-input"
    />
  );
  return (
    <Page
      title={t("screen.swap.title")}
      testId="swap-view"
      primaryAction={
        <Button size="lg" full disabled={!q} onClick={a.onReview} data-testid="swap-review">
          {t("screen.swap.review")}
        </Button>
      }
    >
      <FlowCard
        testId="swap-flow"
        onSwitch={a.onSwitch}
        from={{
          label: t("screen.swap.youPay"),
          asset: { symbol: m.pay.symbol },
          onAsset: a.onPayAsset,
          assetLabel: t("screen.swap.choosePay"),
          children: input,
          sub: m.pay.balance ? (
            <span>
              {t("screen.protect.balance")} <Amt a={m.pay.balance} />
            </span>
          ) : undefined,
          testId: "swap-from",
        }}
        to={{
          label: cross ? t("screen.swap.atLeast") : t("swap.receive"),
          asset: { symbol: m.receive.symbol },
          network: cross ? m.receive.chain : t("screen.swap.protectedBalance"),
          onAsset: a.onReceiveAsset,
          assetLabel: t("screen.swap.chooseReceive"),
          children: q ? cross ? <Amt a={q.minimum} bare /> : <Amt a={q.expected} approx bare /> : "—",
          testId: "swap-to",
        }}
      />
      {q ? (
        <Card padding="md" testId="swap-quote">
          <div className="ds-quote-head">
            <span>{t("screen.swap.bestRoute")}</span>
            <ProtectionBadge level={q.protection === "high" ? "High" : "Reduced"} label={t(LEVEL[q.protection])} />
          </div>
          <dl className="ds-review-rows">
            {q.kind === "same-chain" ? (
              <>
                <div className="ds-review-row" data-testid="swap-minimum">
                  <dt>{t("swap.minimumReceive")}</dt>
                  <dd>
                    <Amt a={q.minimum} rounding="down" />
                  </dd>
                </div>
                <div className="ds-review-row" data-testid="swap-fees">
                  <dt>{t("screen.swap.fees")}</dt>
                  <dd>
                    <Usd cents={q.feesUsdCents} />
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div className="ds-review-row" data-testid="swap-privacy-fee">
                  <dt>{t("swap.privacyFee")}</dt>
                  <dd>
                    <Usd cents={q.fees.privacyUsdCents} />
                  </dd>
                </div>
                <div className="ds-review-row" data-testid="swap-relayer-fee">
                  <dt>{t("swap.relayerFee")}</dt>
                  <dd>
                    <Usd cents={q.fees.relayerUsdCents} />
                  </dd>
                </div>
                <div className="ds-review-row" data-testid="swap-provider-fee">
                  <dt>{t("screen.swap.providerFee")}</dt>
                  <dd>
                    <Usd cents={q.fees.providerUsdCents} />
                  </dd>
                </div>
              </>
            )}
            <div className="ds-review-row" data-testid="swap-eta">
              <dt>{t("screen.swap.estimatedTime")}</dt>
              <dd>{etaWords(q.eta, t)}</dd>
            </div>
          </dl>
          {a.onCompare ? (
            <TextButton icon="chevron-right" onClick={a.onCompare} data-testid="swap-compare">
              {t("screen.swap.compare")}
            </TextButton>
          ) : null}
        </Card>
      ) : null}
      {q?.kind === "cross-chain" ? (
        <Card padding="md" testId="swap-destination">
          <h2 className="ds-card-title">{t("screen.swap.destinationTitle", { symbol: m.receive.symbol })}</h2>
          <AddressChip address={q.destination.address} />
          <ul className="ds-checks ds-checks-block">
            <li data-state={q.destination.checks.valid ? "ok" : "fail"}>
              {q.destination.checks.valid ? "✓" : "×"} {t("screen.swap.check.valid", { symbol: m.receive.symbol })}
            </li>
            <li data-state={q.destination.checks.network ? "ok" : "fail"}>
              {q.destination.checks.network ? "✓" : "×"} {t("screen.swap.check.network")}
            </li>
            <li data-state={q.destination.checks.compatible ? "ok" : "fail"}>
              {q.destination.checks.compatible ? "✓" : "×"} {t("screen.swap.check.compatible")}
            </li>
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}
