// The Review (spec v2.0 §7.6, §7.9; doc §26, §31, §48, §51, §86–§87): nothing hidden — what you pay (USD and the
// asset), what you receive and the minimum, every fee and the total, the destination, the protection —, then the one
// confirmation: a tap below $50K, Hold to Confirm from $50K with the Protected execution checks (V7 Stage 13, spec v3.0 §4: one
// order by default — the card says so —, protected steps only when staged or asked). A cross-chain Review carries the one sentence on settlement not being atomic. A blocker
// found between the Review and the signature replaces it: "We stopped this transaction", the reason, "Your funds have
// not moved." Pure: the flows are wired under it in Stages 10–11 (V6 Stage 10: `hold` apart from `large` — a $60K send is
// held without a swap's protected-execution checks — and an `extra` slot the flow fills with what its band adds: the
// privacy lint, the typed-in destination re-confirmed; `confirmDisabled` until those are done).
import type { ReactNode } from "react";
import { Button, HoldButton, Page, ReviewLayout, StateScreen, TextButton, Card, formatAmount, formatUsdCents, type ReviewSection } from "@privacy-wallet/ui";
import type { BlockerCode } from "@privacy-wallet/protocol-types";
import { useT } from "../../app/i18n/useT";
import { durationText } from "../../app/i18n/duration";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { Amt, Usd, type Amount } from "../viewKit";

export type Level = "high" | "medium" | "low";
export interface ReviewFee {
  /** `merges`: the merges a spend of three notes or more needs first, each paying the relayer (audit round 2, r43) */
  kind: "privacy" | "relayer" | "provider" | "merges";
  /** how many merges; for `relayer`, the steps of a protected execution each paying F (V7 Stage 12: the row reads F × n) */
  count?: number;
  usdCents: bigint | null;
  amount?: Amount;
  /** a part in another asset, shown after the amount when no price joins them (V6 Stage 12: a same-chain swap's shield tip) */
  also?: Amount;
  /** words in place of an amount (the review round of 2026-11-03, W5: "Paid by your connected wallet") */
  note?: string;
  /** the amount is an estimate in part — a protected execution's steps each pay their own tip at their time (the third review round, 2026-11-03) */
  approx?: boolean;
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
  /** confirm by holding (default: `large`) — a send from $50K holds without the swap's checks */
  hold?: boolean;
  /** the band's own steps are not done yet (the lint acknowledged, the typed-in destination re-confirmed) */
  confirmDisabled?: boolean;
  blocked?: BlockerCode | null;
  /** why the blocker holds, when the screen knows more (the twelfth review round, W6 §2: a request its wallet app may still send, and until when) */
  blockedWhy?: string;
  /** V7 Stage 13 (spec v3.0 §4): the protected steps planned (the plan staged, or asked under Advanced); absent or 1 = one order */
  steps?: number | null;
  /** the eleventh review round (2026-11-04, E11-12): the route's health as the Review read it — the card ticks "Route health checked" only when true */
  routeHealthy?: boolean;
  /** the steps' time in all, from the plan (the eleventh review round, 2026-11-04, E11-15: the Review had stated no time for hours of steps) */
  stepsSeconds?: number | null;
  /** the fee section's statement when the default does not hold (W5: a send the connected wallet submits pays no privacy fee) */
  feeStatement?: string;
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
  merges: "screen.review.mergeFees",
};
/**
 * The fee section in words (the seventh review round, 2026-11-03): the V2–V4 Review from $100,000 renders text, and it had stated no fee,
 * no merge and no fee statement — though every Review states them before you confirm (docs/fee-policy.md).
 */
export interface FeeRowsText {
  rows: { id: ReviewFee["kind"]; label: string; value: string }[];
  total: string;
  statement: string;
}
export function feeRowsText(
  t: (key: MessageKey, vars?: Vars) => string,
  m: Pick<ReviewModel, "kind" | "fees" | "totalFeesUsdCents" | "feeStatement">,
): FeeRowsText {
  const amountText = (a: Amount, approx?: boolean) =>
    `${approx ? "≈ " : ""}${formatAmount(a.units, { decimals: a.decimals, displayDecimals: a.displayDecimals, rounding: approx ? undefined : "up", pad: a.displayDecimals <= 2 })} ${a.symbol}`;
  const value = (f: ReviewFee) =>
    f.note ??
    (f.usdCents !== null ? formatUsdCents(f.usdCents) : f.amount ? `${amountText(f.amount, f.approx)}${f.also ? ` + ${amountText(f.also)}` : ""}` : "—");
  return {
    rows: m.fees.map((f) => ({
      id: f.kind,
      label: f.kind === "relayer" && (f.count ?? 1) > 1 ? t("screen.review.relayerFeeSteps", { n: f.count ?? 1 }) : t(FEE[f.kind], { n: f.count ?? 1 }),
      value: value(f),
    })),
    total: m.totalFeesUsdCents !== null ? formatUsdCents(m.totalFeesUsdCents) : "—",
    statement: `${m.feeStatement ?? t("screen.review.feeStatement")}${!m.feeStatement && (m.kind === "swap" || m.kind === "cross-chain") ? ` ${t("screen.review.feeAgain")}` : ""}`,
  };
}

const LEVEL: Record<Level, MessageKey> = { high: "screen.swap.protectionHigh", medium: "screen.swap.protectionMedium", low: "screen.swap.protectionLow" };
/** The second line of "We stopped this transaction": the blocker in words (spec v2.0 §7.9). */
export const BLOCKER_WORDS: Record<BlockerCode, MessageKey> = {
  quote_expired: "screen.review.blocker.quoteExpired",
  asset_unsupported: "screen.review.blocker.assetUnsupported",
  destination_invalid: "screen.review.blocker.destinationInvalid",
  provider_unhealthy: "screen.review.blocker.providerUnhealthy",
  minimum_below_limit: "screen.review.blocker.minimumBelowLimit",
  parameters_changed: "screen.review.blocker.parametersChanged",
  network_mismatch: "screen.review.blocker.networkMismatch",
  unsafe_contract_call: "screen.review.blocker.unsafeContractCall",
  in_flight_limit: "screen.review.blocker.inFlightLimit",
  route_not_qualified: "screen.review.blocker.routeNotQualified",
  one_at_a_time: "screen.review.blocker.oneAtATime",
};
const LARGE_CHECKS: MessageKey[] = ["screen.review.large.destination", "screen.review.large.quote", "screen.review.large.route", "screen.review.large.limits"];
/**
 * A protected execution check as the Review's own facts have it (the eleventh review round, 2026-11-04, E11-12): the card had drawn its four
 * ✓ whatever they said — "Destination verified" over a typed-in address not yet re-confirmed (its row without the ✓, the hold disabled),
 * "Route health checked" over the Review's own warning that the route is not healthy. The destination check follows the row, the route
 * check the health read (not read is not passed); the quote is locked and the limits are on at every Review of the band.
 */
function largeCheck(k: MessageKey, m: ReviewModel): { words: MessageKey; state: "ok" | "open" | "fail"; mark: string } {
  if (k === "screen.review.large.destination" && !m.destination.verified) return { words: "screen.review.large.destinationOpen", state: "open", mark: "○" };
  if (k === "screen.review.large.route" && m.routeHealthy !== true) return { words: "screen.review.large.routeOpen", state: "fail", mark: "⚠" };
  return { words: k, state: "ok", mark: "✓" };
}

export function ReviewView({
  model: m,
  actions: a,
  holdMs = 1500,
  extra,
}: {
  model: ReviewModel;
  actions: ReviewActions;
  holdMs?: number;
  /** the band's own notices, in the flow's words */ extra?: ReactNode;
}) {
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
                <p className="ds-callout-body">{t(BLOCKER_WORDS[m.blocked])}</p>
                {m.blockedWhy ? (
                  <p className="ds-callout-body" data-testid="review-blocked-why">
                    {m.blockedWhy}
                  </p>
                ) : null}
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
  const fee = (f: ReviewFee) =>
    f.note ? (
      f.note
    ) : f.usdCents !== null ? (
      <Usd cents={f.usdCents} />
    ) : f.amount ? (
      f.also ? (
        <>
          <Amt a={f.amount} approx={f.approx} rounding={f.approx ? undefined : "up"} /> + <Amt a={f.also} rounding="up" />
        </>
      ) : (
        <Amt a={f.amount} approx={f.approx} rounding={f.approx ? undefined : "up"} />
      )
    ) : (
      "—"
    );
  const sections: ReviewSection[] = [
    {
      testId: "review-receive",
      rows: [
        {
          label: t("screen.review.youReceive"),
          value: <Amt a={m.receive.amount} approx={m.receive.approx} rounding={m.receive.approx ? undefined : "down"} />,
          testId: "review-expected",
        },
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
        ...m.fees.map((f) => ({
          label: f.kind === "relayer" && (f.count ?? 1) > 1 ? t("screen.review.relayerFeeSteps", { n: f.count ?? 1 }) : t(FEE[f.kind], { n: f.count ?? 1 }),
          value: fee(f),
          testId: `review-fee-${f.kind}`,
        })),
        { label: t("screen.review.totalFees"), value: m.totalFeesUsdCents !== null ? <Usd cents={m.totalFeesUsdCents} /> : "—", testId: "review-total-fees" },
      ],
      // the fee policy's statement (spec v3.0 §3, doc §6; V7 Stage 12): once per operation — and a swap of protected funds pays again
      note: (
        <span data-testid="review-fee-statement">
          {m.feeStatement ?? t("screen.review.feeStatement")}
          {!m.feeStatement && (m.kind === "swap" || m.kind === "cross-chain") ? ` ${t("screen.review.feeAgain")}` : ""}
        </span>
      ),
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
                  {(m.steps && m.steps > 1
                    ? LARGE_CHECKS.map((k) => (k === "screen.review.large.quote" ? ("screen.review.large.quoteSteps" as MessageKey) : k))
                    : LARGE_CHECKS
                  ).map((k) => {
                    const c = largeCheck(k, m);
                    return (
                      <li key={k} data-state={c.state}>
                        {c.mark} {t(c.words)}
                      </li>
                    );
                  })}
                  <li data-state="ok" data-testid="review-large-order">
                    ✓ {m.steps && m.steps > 1 ? t("screen.review.large.steps", { n: m.steps }) : t("screen.review.large.oneOrder")}
                  </li>
                </ul>
              </Card>
            ) : null}
            {m.large && m.steps && m.steps > 1 && m.stepsSeconds ? (
              <p className="ds-note" data-testid="review-steps-time">
                {t("screen.review.large.stepsTime", { duration: durationText(t, m.stepsSeconds) })}
              </p>
            ) : null}
            {m.kind === "cross-chain" ? (
              <p className="ds-note" data-testid="review-not-atomic">
                {t("screen.review.notAtomic")}
              </p>
            ) : null}
            {extra}
          </>
        }
        action={
          (m.hold ?? m.large) ? (
            <HoldButton label={t("screen.review.hold")} holdMs={holdMs} onConfirm={a.onConfirm} disabled={m.confirmDisabled} testId="hold-to-confirm" />
          ) : (
            <Button size="lg" full onClick={a.onConfirm} disabled={m.confirmDisabled} data-testid="review-confirm">
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
