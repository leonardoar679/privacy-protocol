// The scheduler's last failure for an operation, on its detail (a V7 follow-up; audit gap 59). A runner tick that threw is
// retried with a growing backoff (ten minutes, doubling, at most six hours) and used to say nothing on any screen: the first
// full local run of V7 found a campaign's step "committed" for ten minutes with nothing to say. The line names the failure
// in the catalog's words (the message itself under Advanced), the next attempt, and offers it now — the runners reconcile
// before they send anything, so the user's tap is safe (plan §86: never an automatic retry on money movement; this one is
// the user's word).
import { TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { formatTime } from "../../app/i18n/intl";
import type { MessageKey } from "../../app/i18n/en";
import { hasCode, reasonKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { retryNow } from "@privacy-wallet/sdk/wallet/schedule";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { useFailedAttempt, useSettings } from "../../hooks";

/** The scheduled action an operation's record waits on: its campaign's tick, else its order's. */
export const attemptIdOf = (record: Pick<OperationRecord, "id" | "refs">): string | null =>
  record.refs.campaignId ?? record.refs.orderId ?? (record.id.startsWith("swap:") ? record.id.slice("swap:".length) : null);

export function AttemptLine({ orderId, testId = "operation-attempt" }: { orderId: string | null | undefined; testId?: string }) {
  const t = useT();
  const a = useFailedAttempt(orderId);
  const { advanced } = useSettings();
  if (!a) return null;
  const code = a.errorCode && hasCode(a.errorCode) ? a.errorCode : "unknown";
  return (
    <div className="ds-note-warn" data-testid={testId} data-code={code} data-attempts={a.attempts ?? 0}>
      <p>{t("progress.attemptFailed", { reason: t(reasonKey(code) as MessageKey) })}</p>
      {a.nextAttemptAt ? <p>{t("progress.attemptNext", { when: formatTime(a.nextAttemptAt), n: (a.attempts ?? 0) + 1 })}</p> : null}
      {advanced && a.error ? (
        <p className="ds-mono-break" data-testid={`${testId}-detail`}>
          {a.error}
        </p>
      ) : null}
      <TextButton onClick={() => retryNow(a.id)} data-testid={`${testId}-retry`}>
        {t("progress.retryNow")}
      </TextButton>
    </div>
  );
}
