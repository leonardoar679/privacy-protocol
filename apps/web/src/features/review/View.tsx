// The Review (spec v2.0 §7.6, §7.9; doc §26, §31, §48, §51, §86–§87): nothing hidden — what you pay (USD and the
// asset), what you receive and the minimum, every fee and the total, the destination, the protection —, then the one
// confirmation: a tap below $50K, Hold to Confirm from $50K with the Protected execution checks (protection is automatic
// there: no mode to choose). A cross-chain Review carries the one sentence on settlement not being atomic. A blocker
// found between the Review and the signature replaces it: "We stopped this transaction", the reason, "Your funds have
// not moved." Pure: the flows are wired under it in Stages 10–11.
import { Button, HoldButton, Page, ReviewLayout, StateScreen, TextButton, Card, type ReviewSection } from "@privacy-wallet/ui";
import type { BlockerCode } from "@privacy-wallet/protocol-types";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Amt, Usd, type Amount } from "../viewKit";

export type Level = "high" | "medium" | "low";
export interface ReviewFee {
  kind: "privacy" | "relayer" | "provider";
  usdCents: bigint | null;
  amount?: Amount;
}
export interface ReviewModel {
  kind: "protect" | "send" | "swap" | "cross-chain";
  pay: { usdCents: bigint | null; amount: Amount };
  receive: { amount: Amount; approx: boolean };
  minimum?: Amount | null;
  fees: ReviewFee[];
  totalFeesUsdCents: bigint | null;
  destination: { label: string; verified: boolean };
  protection: Level;
  /** $50K and above (doc §49): the protected execution, a hold to confirm */
  large: boolean;
  blocked?: BlockerCode | null;
}
export interface ReviewActions {
  onConfirm: () => void;
  onEdit: () => void;
  onReviewAgain?: () => void;
}

const FEE: Record<ReviewFee["kind"], MessageKey> = {
  privacy: "screen.review.privacyFee",
  relayer: "screen.review.relayerFee",
  provider: "screen.review.providerFee",
};
const LEVEL: Record<Level, MessageKey> = { high: "screen.swap.protectionHigh", medium: "screen.swap.protectionMedium", low: "screen.swap.protectionLow" };
const BLOCKER: Record<BlockerCode, MessageKey> = {
  quote_expired: "screen.review.blocker.quoteExpired",
  asset_unsupported: "screen.review.blocker.assetUnsupported",
  destination_invalid: "screen.review.blocker.destinationInvalid",
  provider_unhealthy: "screen.review.blocker.providerUnhealthy",
  minimum_below_limit: "screen.review.blocker.minimumBelowLimit",
  parameters_changed: "screen.review.blocker.parametersChanged",
  network_mismatch: "screen.review.blocker.networkMismatch",
  unsafe_contract_call: "screen.review.blocker.unsafeContractCall",
};
const LARGE_CHECKS: MessageKey[] = ["screen.review.large.destination", "screen.review.large.quote", "screen.review.large.route", "screen.review.large.limits"];

export function ReviewView({ model: m, actions: a, holdMs = 1500 }: { model: ReviewModel; actions: ReviewActions; holdMs?: number }) {
  const t = useT();
  if (m.blocked) {
    return (
      <Page title={t("screen.review.title")} testId="review-view">
        <Card>
          <StateScreen
            kind="error"
            title={t("screen.review.blocked.title")}
            body={
              <>
                <p className="ds-callout-body">{t(BLOCKER[m.blocked])}</p>
                <p className="ds-callout-body" data-testid="review-not-moved">
                  {t("screen.review.blocked.notMoved")}
                </p>
              </>
            }
            actions={
              <Button onClick={a.onReviewAgain ?? a.onEdit} data-testid="review-again">
                {t("screen.review.blocked.again")}
              </Button>
            }
            testId="review-blocked"
          />
        </Card>
      </Page>
    );
  }
  const fee = (f: ReviewFee) => (f.usdCents !== null ? <Usd cents={f.usdCents} /> : f.amount ? <Amt a={f.amount} rounding="up" /> : "—");
  const sections: ReviewSection[] = [
    {
      testId: "review-receive",
      rows: [
        { label: t("screen.review.youReceive"), value: <Amt a={m.receive.amount} approx={m.receive.approx} />, testId: "review-expected" },
        ...(m.minimum ? [{ label: t("screen.review.minimum"), value: <Amt a={m.minimum} rounding="down" />, testId: "review-minimum" }] : []),
        {
          label: t("screen.review.destination"),
          value: m.destination.verified ? `${m.destination.label} ✓` : m.destination.label,
          tone: "positive" as const,
          testId: "review-destination",
        },
        {
          label: t("screen.review.protection"),
          value: t(LEVEL[m.protection]),
          tone: m.protection === "high" ? ("positive" as const) : ("warn" as const),
          testId: "review-protection",
        },
      ],
    },
    {
      title: t("screen.review.fees"),
      testId: "review-fees",
      rows: [
        ...m.fees.map((f) => ({ label: t(FEE[f.kind]), value: fee(f), testId: `review-fee-${f.kind}` })),
        { label: t("screen.review.totalFees"), value: m.totalFeesUsdCents !== null ? <Usd cents={m.totalFeesUsdCents} /> : "—", testId: "review-total-fees" },
      ],
    },
  ];
  return (
    <Page title={t("screen.review.title")} back={a.onEdit} testId="review-view">
      <ReviewLayout
        testId="review"
        amount={{
          label: t("screen.review.youPay"),
          primary: m.pay.usdCents !== null ? <Usd cents={m.pay.usdCents} /> : <Amt a={m.pay.amount} />,
          secondary: m.pay.usdCents !== null ? <Amt a={m.pay.amount} /> : undefined,
        }}
        sections={sections}
        notices={
          <>
            {m.large ? (
              <Card padding="md" testId="review-protected-execution">
                <h2 className="ds-card-title">{t("screen.review.large.title")}</h2>
                <p className="ds-callout-body">{t("screen.review.large.body")}</p>
                <ul className="ds-checks ds-checks-block">
                  {LARGE_CHECKS.map((k) => (
                    <li key={k} data-state="ok">
                      ✓ {t(k)}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {m.kind === "cross-chain" ? (
              <p className="ds-note" data-testid="review-not-atomic">
                {t("screen.review.notAtomic")}
              </p>
            ) : null}
          </>
        }
        action={
          m.large ? (
            <HoldButton label={t("screen.review.hold")} holdMs={holdMs} onConfirm={a.onConfirm} testId="hold-to-confirm" />
          ) : (
            <Button size="lg" full onClick={a.onConfirm} data-testid="review-confirm">
              {t("screen.review.confirm")}
            </Button>
          )
        }
        secondaryAction={
          <TextButton onClick={a.onEdit} data-testid="review-edit">
            {t("screen.review.edit")}
          </TextButton>
        }
      />
    </Page>
  );
}
