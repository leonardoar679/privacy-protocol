// Swap and cross-chain (spec v2.0 §7.5; doc §26, §29–§33): what you pay → what you receive, then the facts a beginner
// needs — the minimum, the protection, the fees, the time —, the "Best protected route" (the provider and the route
// are Advanced's), one action: Review Swap. A same-chain swap lands in the protected balance; a cross-chain one names
// its destination — typed, or the fresh address of this wallet — with three checks and leads with "You'll receive at
// least". The quote is fetched as the user types and shows how long it stays valid; an expired quote says so, and that
// the funds were not moved. The time is the quote's own estimate, never a constant. Right after a protect the
// protection reads Medium with the way to delay the funding for more privacy. Pure: ./SwapScreen.tsx (V6 Stage 11)
// wires the engine under it through ./model.ts. V6 Stage 16 (doc §54): from 1024 px the route details stand beside the
// swap card, open (still foldable: the phone's action exists there too, doc §88), instead of folded inside the quote.
import { useState, type ReactNode } from "react";
import {
  AddressInput,
  BottomSheet,
  Button,
  Card,
  Collapsible,
  DESKTOP_QUERY,
  FlowCard,
  Page,
  ProtectionBadge,
  StateScreen,
  Switch,
  TextButton,
  cleanAmount,
  useMediaQuery,
  type CheckState,
} from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { Amt, Usd, type Amount } from "../viewKit";

export type Level = "high" | "medium" | "low";
/** V6 Stage 14 (doc §35): a line of "Why?" under the protection indicator — from the assessment, a failed one with its reason */
export interface WhyLineView {
  ok: boolean;
  label: MessageKey;
  reason?: MessageKey;
}
export interface SwapModel {
  pay: { symbol: string; decimals: number; amount: string; balance: Amount | null; usd?: string | null };
  receive: { symbol: string; chain: string };
  /** V6 Stage 11: a cross-chain destination — typed, or the fresh address of this wallet — and its three checks */
  destination?: { value: string; fresh: boolean; checks: { valid: CheckState; network: CheckState; compatible: CheckState }; error?: string | null } | null;
  quote:
    | { kind: "same-chain"; expected: Amount; minimum: Amount; protection: Level; why?: WhyLineView[]; feesUsdCents: bigint; eta: [number, number] }
    | {
        kind: "cross-chain";
        expected: Amount;
        minimum: Amount;
        protection: Level;
        why?: WhyLineView[];
        fees: { privacyUsdCents: bigint; relayerUsdCents: bigint; providerUsdCents: bigint };
        eta: [number, number];
      }
    | null;
  /** seconds the quote stays valid (the countdown) */
  expiresIn?: number | null;
  expired?: boolean;
  /** a quote is being fetched */
  quoting?: boolean;
  /** why there is no quote, in words */
  noRoute?: string | null;
  /** the funds were protected recently (doc §35): the note and "Delay for more privacy" */
  privacy?: { recent: boolean; delay: boolean } | null;
  /** above the standard band: the notice */
  notice?: string | null;
  /** Advanced (doc §29): the route's facts */
  details?: { provider: string; route: string; expected: Amount; fee: string; time: string; risk: string; privacy: string } | null;
  /** whether Review Swap can be taken (absent: a quote) */
  canReview?: boolean;
}
export interface SwapActions {
  onAmount: (v: string) => void;
  onPayAsset: () => void;
  onReceiveAsset: () => void;
  onSwitch?: () => void;
  onReview: () => void;
  onNewQuote: () => void;
  onCompare?: () => void;
  onDestination?: (v: string) => void;
  onFreshDestination?: () => void;
  onDelay?: (on: boolean) => void;
  onMax?: () => void;
  onBack?: () => void;
}

const LEVEL: Record<Level, MessageKey> = { high: "screen.swap.protectionHigh", medium: "screen.swap.protectionMedium", low: "screen.swap.protectionLow" };

/** "About 2 min", "2–5 min": the quote's own range, in minutes. */
function etaWords(eta: [number, number], t: ReturnType<typeof useT>): string {
  const [lo, hi] = eta.map((s) => Math.max(1, Math.round(s / 60)));
  return lo === hi ? t("screen.swap.etaAbout", { min: lo }) : t("screen.swap.etaRange", { lo, hi });
}

/**
 * `addressStatus`: what the screen adds under the destination (the address book's status where it locks the destination);
 * `footer`: what follows the page's own content (the protected swaps still running).
 */
export function SwapView({
  model: m,
  actions: a,
  addressStatus,
  footer,
}: {
  model: SwapModel;
  actions: SwapActions;
  addressStatus?: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const [why, setWhy] = useState(false);
  const wide = useMediaQuery(DESKTOP_QUERY);
  if (m.expired) {
    return (
      <Page title={t("screen.swap.title")} back={a.onBack} testId="swap-view">
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
  const cross = q?.kind === "cross-chain" || (!q && !!m.destination);
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
  const d = m.destination;
  const routeRows = m.details ? (
    <dl className="ds-review-rows">
      {(
        [
          ["screen.swap.detail.provider", m.details.provider],
          ["screen.swap.detail.route", m.details.route],
          ["screen.swap.detail.fee", m.details.fee],
          ["screen.swap.detail.time", m.details.time],
          ["screen.swap.detail.risk", m.details.risk],
          ["screen.swap.detail.privacy", m.details.privacy],
        ] as [MessageKey, string][]
      ).map(([k, v]) => (
        <div key={k} className="ds-review-row">
          <dt>{t(k)}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      <div className="ds-review-row">
        <dt>{t("screen.swap.detail.expected")}</dt>
        <dd>
          <Amt a={m.details.expected} approx />
        </dd>
      </div>
    </dl>
  ) : null;
  const layout = (body: ReactNode) =>
    wide && routeRows ? (
      <div className="ds-columns">
        <div className="ds-column">{body}</div>
        <div className="ds-column">
          <Card padding="md">
            <Collapsible summary={t("screen.swap.routeDetails")} defaultOpen testId="swap-route-details">
              {routeRows}
            </Collapsible>
          </Card>
        </div>
      </div>
    ) : (
      body
    );
  return (
    <Page
      title={t("screen.swap.title")}
      back={a.onBack}
      width={wide && routeRows ? "wide" : "phone"}
      testId="swap-view"
      primaryAction={
        <Button size="lg" full disabled={!(m.canReview ?? !!q)} onClick={a.onReview} data-testid="swap-review">
          {t("screen.swap.review")}
        </Button>
      }
    >
      {layout(
        <>
          <FlowCard
            testId="swap-flow"
            onSwitch={a.onSwitch}
            from={{
              label: t("screen.swap.youPay"),
              asset: { symbol: m.pay.symbol },
              onAsset: a.onPayAsset,
              assetLabel: t("screen.swap.choosePay"),
              children: input,
              sub:
                m.pay.balance || m.pay.usd ? (
                  <span className="ds-flow-source">
                    {m.pay.usd ? <span data-testid="swap-amount-usd">{m.pay.usd}</span> : null}
                    {m.pay.balance ? (
                      <span>
                        {t("screen.protect.balance")} <Amt a={m.pay.balance} />
                      </span>
                    ) : null}
                    {a.onMax && m.pay.balance ? (
                      <TextButton onClick={a.onMax} data-testid="swap-max">
                        {t("common.max")}
                      </TextButton>
                    ) : null}
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
              children: q ? q.kind === "cross-chain" ? <Amt a={q.minimum} bare /> : <Amt a={q.expected} approx bare /> : "—",
              testId: "swap-to",
            }}
          />
          {m.notice ? (
            <p className="ds-note-warn" data-testid="swap-large">
              {m.notice}
            </p>
          ) : null}
          {d ? (
            <Card padding="md" testId="swap-destination">
              <AddressInput
                id="swap-destination"
                label={t("screen.swap.destinationTitle", { symbol: m.receive.symbol })}
                value={d.value}
                onChange={(v) => a.onDestination?.(v)}
                placeholder={t("screen.send.toPlaceholder")}
                checks={[
                  { label: t("screen.swap.check.valid", { symbol: m.receive.symbol }), state: d.checks.valid },
                  { label: t("screen.swap.check.network"), state: d.checks.network },
                  { label: t("screen.swap.check.compatible"), state: d.checks.compatible },
                ]}
                book={a.onFreshDestination && !d.fresh ? [{ id: "fresh", label: t("send.freshEntry"), address: "" }] : undefined}
                onPickEntry={() => a.onFreshDestination?.()}
                bookLabel={t("send.book")}
                error={d.error ? <span data-testid="swap-destination-error">{d.error}</span> : undefined}
                status={addressStatus}
                testId="destination"
              />
              {d.fresh ? (
                <p className="ds-note" data-testid="swap-destination-fresh">
                  {t("screen.swap.freshNote")}
                </p>
              ) : null}
            </Card>
          ) : null}
          {m.quoting && !q ? (
            <p className="ds-note" role="status" data-testid="swap-quoting">
              {t("screen.swap.quoting")}
            </p>
          ) : null}
          {m.noRoute && !q ? (
            <p className="ds-note-warn" role="status" data-testid="swap-no-route">
              {m.noRoute}
            </p>
          ) : null}
          {q ? (
            <Card padding="md" testId="swap-quote">
              <div className="ds-quote-head">
                <span>{t("screen.swap.bestRoute")}</span>
                <ProtectionBadge
                  level={q.protection === "high" ? "High" : "Reduced"}
                  label={t(LEVEL[q.protection])}
                  onPress={q.why ? () => setWhy(true) : undefined}
                  testId="swap-protection"
                />
              </div>
              {/* V6 Stage 16 (doc §77): a new quote's figures are announced; the countdown below is not */}
              <dl className="ds-review-rows" aria-live="polite" data-testid="swap-quote-rows">
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
              {m.expiresIn !== undefined && m.expiresIn !== null ? (
                <p className="ds-note" data-testid="swap-expires">
                  {t("screen.swap.expiresIn", { seconds: Math.max(0, m.expiresIn) })}
                </p>
              ) : null}
              {routeRows && !wide ? (
                <Collapsible summary={t("screen.swap.routeDetails")} testId="swap-route-details">
                  {routeRows}
                </Collapsible>
              ) : null}
              {a.onCompare ? (
                <TextButton icon="chevron-right" onClick={a.onCompare} data-testid="swap-compare">
                  {t("screen.swap.compare")}
                </TextButton>
              ) : null}
            </Card>
          ) : null}
          {q?.why ? (
            <BottomSheet open={why} onClose={() => setWhy(false)} title={t("privacyCenter.why.title")} testId="swap-why" id="swap-why">
              <ul className="ds-plain-list" data-testid="swap-why-lines">
                {q.why.map((l) => (
                  <li key={l.label} data-ok={l.ok ? "1" : "0"}>
                    {l.ok ? "✓" : "⚠"} {t(l.label)}
                    {l.reason ? <p className="ds-note">{t(l.reason)}</p> : null}
                  </li>
                ))}
              </ul>
              <p className="ds-note">{t("privacyCenter.metadataPublic")}</p>
            </BottomSheet>
          ) : null}
          {m.privacy?.recent ? (
            <Card padding="md" testId="swap-recent">
              <p className="ds-note">{t("screen.swap.recent")}</p>
              {a.onDelay ? (
                <Switch id="swap-delay" checked={m.privacy.delay} onCheckedChange={a.onDelay} label={t("screen.swap.delay")} testId="swap-delay" />
              ) : null}
              {m.privacy.delay ? (
                <p className="ds-note" data-testid="swap-delay-note">
                  {t("screen.swap.delayNote")}
                </p>
              ) : null}
            </Card>
          ) : null}
          {footer}
        </>,
      )}
    </Page>
  );
}
