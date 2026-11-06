// "Fees & refunds" (spec v3.0 §3; doc §6; V7 Stage 12): the published policy's statements, in the app and in the user's
// language — docs/fee-policy.md's statements in a Simple screen's words: the page had said escrow, gas, nullifier and proof (the
// eleventh review round, 2026-11-04, E11-3). Reached from the Privacy Center and from Settings. Nothing here is
// computed: the Review carries the figures; this page says the rules.
import { Card, Page } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";

/** the policy's statements, in the order of docs/fee-policy.md §1–§4 */
export const FEE_POLICY_SECTIONS: { title: MessageKey; lines: MessageKey[]; testId: string }[] = [
  {
    title: "feePolicy.privacyTitle",
    lines: ["feePolicy.onePercent", "feePolicy.oncePerOperation", "feePolicy.protectedExecution", "feePolicy.noFeeOnHousekeeping", "feePolicy.protectThenSwap"],
    testId: "fee-policy-privacy",
  },
  {
    title: "feePolicy.relayerTitle",
    lines: ["feePolicy.relayerCost", "feePolicy.bound", "feePolicy.boundSteps", "feePolicy.oneFeeNote", "feePolicy.executorTip"],
    testId: "fee-policy-relayer",
  },
  { title: "feePolicy.nothingTitle", lines: ["feePolicy.nothingReview", "feePolicy.nothingStopped", "feePolicy.neverTwice"], testId: "fee-policy-nothing" },
  { title: "feePolicy.refundsTitle", lines: ["feePolicy.earnedAtFunding", "feePolicy.undelivered", "feePolicy.pieceAgain"], testId: "fee-policy-refunds" },
];

export function FeesAndRefunds({ onBack }: { onBack?: () => void }) {
  const t = useT();
  return (
    <Page title={t("feePolicy.title")} back={onBack} testId="fees-and-refunds">
      <div className="ds-stack">
        <Card>
          <p className="ds-note">{t("feePolicy.intro")}</p>
        </Card>
        {FEE_POLICY_SECTIONS.map((s) => (
          <Card key={s.testId} testId={s.testId}>
            <div className="ds-stack-sm">
              <h2 className="ds-review-title">{t(s.title)}</h2>
              <ul className="ds-plain-list ds-note">
                {s.lines.map((k) => (
                  <li key={k}>{t(k)}</li>
                ))}
              </ul>
            </div>
          </Card>
        ))}
        <Card testId="fee-policy-classic">
          <p className="ds-note">{t("feePolicy.classic")}</p>
        </Card>
      </div>
    </Page>
  );
}
