// The §3.8 interstitial before the Review at the `large-protected` band and above: "Because this transaction is
// large, we're using additional execution safeguards." with the four checks, then Continue. The checks are facts:
// the destination (fresh, or in the book and verified), the route (the provider's health and the strict quote),
// protected execution (the band's plan or the single hard quote), the limits (one in flight, the slippage cap).
import { Button, Card } from "../../design-system";
import { useT } from "../../app/i18n/useT";

export interface ProtectedChecks { destination: boolean; route: boolean; execution: boolean; limits: boolean }

export function ProtectedExecutionNotice({ checks, onContinue, onBack, testId = "protected-execution" }: { checks: ProtectedChecks; onContinue: () => void; onBack: () => void; testId?: string }) {
  const t = useT();
  const items: [keyof ProtectedChecks, string][] = [["destination", t("protectedExec.destination")], ["route", t("protectedExec.route")], ["execution", t("protectedExec.execution")], ["limits", t("protectedExec.limits")]];
  const allOk = items.every(([k]) => checks[k]);
  return (
    <Card testId={testId}>
      <div className="ds-stack-sm">
        <h2 className="ds-review-title">{t("protectedExec.title")}</h2>
        <p className="ds-note">{t("protectedExec.body")}</p>
        <div className="ds-checks-line" data-testid={`${testId}-checks`}>
          {items.map(([k, label]) => <span key={k} data-check={k} data-ok={checks[k] ? "1" : "0"}>{checks[k] ? "✓" : "⚠"} {label}</span>)}
        </div>
        {!allOk ? <p className="ds-note-warn">{t("protectedExec.notAllOk")}</p> : null}
        <div className="ds-actions">
          <Button size="lg" full onClick={onContinue} data-testid={`${testId}-continue`}>{t("protectedExec.continue")}</Button>
          <Button variant="ghost" onClick={onBack}>{t("campaign.back")}</Button>
        </div>
      </div>
    </Card>
  );
}
