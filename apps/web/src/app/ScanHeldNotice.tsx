// The scan the counters wait on, when it fails (the twelfth review round, W6 §5.4): over every screen while the counters are held and the last
// attempt to read the pool failed — which hold and why, that a Protect, a swap and most Sends (any that leaves change or first combines
// notes) cannot finish until then, then reading now, when the wallet tries again, or that it waits for the connection, and Try again now
// (`demandScan`) only while a tap reads the pool at once (ZO's critique: within a minute of the last attempt's start a tap had moved nothing,
// and offline nothing runs). The failing scan had said nothing anywhere: its one line was the scheduler's status, cleared in the same call,
// and a flow learned of it only by its refusal. Lazy beside the background runners: discovery.ts is not on the first route.
import { useEffect, useState } from "react";
import { TextButton, WarningCard } from "@privacy-wallet/ui";
import { demandScan } from "@privacy-wallet/sdk/wallet/discovery";
import { useScanHold } from "../features/operations/ScanHoldLine";
import { useConnectivity } from "../hooks/core";
import { formatTime } from "./i18n/intl";
import { useT } from "./i18n/useT";

/**
 * The scheduler's poll (hooks useScheduler): an attempt due sooner than this after a tap would run no sooner for it — Try again now is
 * offered only while a tap brings the attempt at least this much earlier (ZS's critique: after a quick first failure the window between a
 * minute past its start and its next attempt is the attempt's own length, and the button had flashed for a fraction of a second).
 */
const POLL_MS = 10_000;

export function ScanHeldNotice() {
  const t = useT();
  const h = useScanHold();
  const { online } = useConnectivity();
  const [, rerender] = useState(0);
  const now = Date.now();
  // the words change on their own when a tap can read at once, when it no longer brings the attempt a poll earlier and when the attempt
  // falls due: rendered again then (ZO's critique: a time gone by had stayed on screen while nothing ran — offline, the scheduler busy, a
  // hidden tab)
  const ahead = h?.failed && h.nextAt !== null ? [h.retryFrom, h.nextAt - POLL_MS, h.nextAt].filter((x) => x > now) : [];
  const wakeAt = ahead.length ? Math.min(...ahead) : null;
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = setTimeout(() => rerender((n) => n + 1), Math.max(0, wakeAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [wakeAt]);
  if (!h || !h.failed) return null;
  const when = h.nextAt !== null && h.nextAt > now ? h.nextAt : null; // an attempt already due reads "shortly", never a time gone by
  // a tap reads at once: online, a minute past the last attempt's start, the next attempt a poll away or more — never while one reads, whose
  // own attempt was due when the scheduler ran it, and a demand made meanwhile waits for a minute after its start
  const canRetry = online && now >= h.retryFrom && when !== null && when - now >= POLL_MS;
  return (
    <div role="status" aria-live="polite" className="notice" data-testid="scan-held-notice" data-hold={h.hold}>
      <WarningCard
        title={t("scan.held.title")}
        body={
          <>
            <p>
              {t(h.hold === "restore" ? "scan.held.restore" : "scan.held.unlock")} {t("scan.held.blocked")}
            </p>
            <p data-testid="scan-held-notice-state">
              {h.running
                ? t("scan.held.reading")
                : // why, when the failure tells it for certain (ZR's, ZS's critiques: W6 §5.4's "could not read the pool (…)"; the raw text never, an
                  // endpoint's URL may carry its key); offline the time is kept, with what it waits for: the attempt runs at it, or once the
                  // connection is back if that is later (ZP's critique)
                  `${t("scan.held.lastFailed")}${h.cause === "disagree" ? ` ${t("scan.held.causeDisagree")}` : ""} ${when !== null ? t(online ? "scan.held.next" : "scan.held.nextOffline", { when: formatTime(when) }) : t(online ? "scan.held.planned" : "scan.held.offline")}`}
            </p>
          </>
        }
        action={
          canRetry ? (
            <TextButton onClick={() => demandScan()} data-testid="scan-held-notice-retry">
              {t("scan.held.retry")}
            </TextButton>
          ) : null
        }
        testId="scan-held-notice-card"
      />
    </div>
  );
}
