// The scheduler's last failure for an operation, on its detail (a V7 follow-up; audit gap 59). A runner tick that threw is
// retried with a growing backoff (ten minutes, doubling, at most six hours) and used to say nothing on any screen: the first
// full local run of V7 found a campaign's step "committed" for ten minutes with nothing to say. The line names the failure
// in the catalog's words (the message itself under Advanced), the next attempt, and offers it now — the runners reconcile
// before they send anything, so the user's tap is safe (plan §86: never an automatic retry on money movement; this one is
// the user's word). An action waiting behind the scan the counters wait on (`waitsOnScan`; the twelfth review round, 12b2d) has no time of its
// own: its next attempt comes once the pool is read, and it offers no Try again now — a tap would only wait again (the scan's own notice offers
// one while the scan fails).
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
      {/* waiting behind the scan the counters wait on (the twelfth review round, 12b2d): its next attempt comes once the pool is read, and a
          tap would only wait again (ZV's critique: the line had kept no time and offered an attempt that attempted nothing) */}
      {a.waitsOnScan ? (
        <p data-testid={`${testId}-after-scan`}>{t("progress.attemptAfterScan")}</p>
      ) : a.nextAttemptAt ? (
        <p>{t("progress.attemptNext", { when: formatTime(a.nextAttemptAt), n: (a.attempts ?? 0) + 1 })}</p>
      ) : null}
      {advanced && a.error ? (
        <p className="ds-mono-break" data-testid={`${testId}-detail`}>
          {a.error}
        </p>
      ) : null}
      {a.waitsOnScan ? null : (
        <TextButton onClick={() => retryNow(a.id)} data-testid={`${testId}-retry`}>
          {t("progress.retryNow")}
        </TextButton>
      )}
    </div>
  );
}
