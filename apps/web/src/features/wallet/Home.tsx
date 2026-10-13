// Home (spec v2.0 §7.1): the route — the stores read here, the view-model built by ../home/model.ts and drawn by
// ../home/View.tsx. The USD read happens only once there are notes to value (never at first launch, sdk/prices.ts).
// After a return to the app an open swap that predates this session says it is still executing; the Advanced
// experience adds the maintenance and core lines.
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { DESKTOP_QUERY, useMediaQuery } from "@privacy-wallet/ui";
import { assetsOf } from "@privacy-wallet/sdk/assets";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { housekeepingPlan, housekeepingSummary, pendingHousekeeping, plannedSteps } from "@privacy-wallet/sdk/wallet/housekeeping";
import { isDraft, isOpen } from "@privacy-wallet/sdk/wallet/operationRecord";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useT } from "../../app/i18n/useT";
import { useDeployment } from "../../app/deployment";
import { useStatusLines } from "../more/statusLines";
import { HomeView } from "../home/View";
import { homeModel } from "../home/model";
import { titleOf } from "../amounts";
import { buildRows } from "../activity/rows";
import { useAllOperations, useNotes, usePosture, usePrices, useSession, useSettings } from "../../hooks";

/** When this app session began: an open swap older than it is one the user is returning to. */
const OPENED_AT = Date.now();

export function Home() {
  const t = useT();
  const navigate = useNavigate();
  const deployment = useDeployment();
  const notes = useNotes();
  const prices = usePrices();
  const posture = usePosture(deployment);
  const operations = useAllOperations();
  const { housekeeping, advanced } = useSettings();
  const { coreLine } = useStatusLines(deployment);
  const s = useSession(); // the journal's activity re-renders through it
  const wide = useMediaQuery(DESKTOP_QUERY);
  const hasNotes = notes.some((n) => !n.spent);
  useEffect(() => {
    if (hasNotes) void priceStore.refresh(deployment);
  }, [deployment, hasNotes]);

  // Activity's own rows (Simple): Home's cards and recent lines say exactly what Activity says
  const rows = buildRows(s.status === "unlocked" ? session.journal() : null, operations, false, t);
  const advancedLines = (() => {
    if (!advanced) return null;
    const lines: string[] = [];
    if (deployment && hasNotes) {
      const plans = housekeepingPlan(deployment);
      const steps = plannedSteps(plans);
      const pending = pendingHousekeeping();
      if (steps || pending) {
        if (!housekeeping.enabled) lines.push(t("home.maintenanceOff", { count: steps, unit: steps === 1 ? t("unit.step") : t("unit.steps") }));
        else {
          const next = pending
            ? t("home.maintenanceNext", { at: new Date(pending.dueAt).toLocaleString() }) +
              (pending.error ? t("home.maintenanceFailed", { error: pending.error }) : "")
            : "";
          lines.push(t("home.maintenance", { summary: housekeepingSummary(plans) + next }));
        }
      }
    }
    if (coreLine) lines.push(coreLine);
    return lines;
  })();
  const returningSwap = operations.find(
    (r) => isOpen(r.state) && !isDraft(r.state) && (r.kind === "swap" || r.kind === "cross-chain") && r.createdAt < OPENED_AT,
  );
  const model = homeModel(
    {
      assets: assetsOf(deployment),
      notes,
      prices,
      overall: posture.overall,
      rows,
      advanced: advancedLines,
      returning: returningSwap
        ? t("home.stillExecuting", { title: titleOf(returningSwap.kind, returningSwap.amounts.asset, returningSwap.amounts.outputAsset ?? null, t) })
        : null,
    },
    t,
  );
  return (
    <HomeView
      model={model}
      wide={wide}
      actions={{
        onProtect: () => navigate("/protect"),
        onSend: () => navigate("/send"),
        onSwap: () => navigate("/swap"),
        onPrivacy: () => navigate("/more/privacy"),
        onSettings: () => navigate("/more/security"),
        onOperation: (id) => navigate(`/activity/${encodeURIComponent(id)}`),
      }}
    />
  );
}
