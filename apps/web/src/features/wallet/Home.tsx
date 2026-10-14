// Home (spec v2.0 §7.1): the route — the stores read here, the view-model built by ../home/model.ts and drawn by
// ../home/View.tsx. The USD read happens only once there are notes to value (never at first launch, sdk/prices.ts).
// After a return to the app an open swap that predates this session says it is still executing; the Advanced
// experience adds the maintenance and core lines.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DESKTOP_QUERY, useMediaQuery } from "@privacy-wallet/ui";
import { assetsOf } from "@privacy-wallet/sdk/assets";
import { isDraft, isOpen } from "@privacy-wallet/sdk/wallet/operationRecord";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { campaignById } from "@privacy-wallet/sdk/wallet/campaigns";
import { useT } from "../../app/i18n/useT";
import { useDeployment } from "../../app/deployment";
import { HomeView } from "../home/View";
import { homeModel } from "../home/model";
import { titleOf } from "../amounts";
import { buildRows } from "../activity/rows";
import { useSession, useSettings } from "../../hooks/core";
import { useAllOperations, useNotes, usePosture, usePrices } from "../../hooks/wallet";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { formatDateTime } from "../../app/i18n/intl";

/**
 * Home's Advanced lines — the maintenance plan and the crypto core — computed after their modules load (V6 Stage 16,
 * spec v2.0 §19's budget: the planner reaches the spend pipeline, which is no part of Home's first paint).
 */
function useAdvancedLines(
  deployment: Deployment | null,
  on: boolean,
  hasNotes: boolean,
  maintenance: boolean,
  t: (k: MessageKey, v?: Vars) => string,
): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  const notes = useNotes();
  useEffect(() => {
    if (!on) {
      setLines(null);
      return;
    }
    let alive = true;
    let off = () => {};
    void Promise.all([import("@privacy-wallet/sdk/wallet/housekeeping"), import("@privacy-wallet/sdk/core"), import("../more/statusLines")]).then(
      ([hk, core, status]) => {
        const compute = () => {
          if (!alive) return;
          const out: string[] = [];
          if (deployment && hasNotes) {
            const plans = hk.housekeepingPlan(deployment);
            const steps = hk.plannedSteps(plans);
            const pending = hk.pendingHousekeeping();
            if (steps || pending) {
              if (!maintenance) out.push(t("home.maintenanceOff", { count: steps, unit: steps === 1 ? t("unit.step") : t("unit.steps") }));
              else {
                const next = pending
                  ? t("home.maintenanceNext", { at: formatDateTime(pending.dueAt) }) +
                    (pending.error ? t("home.maintenanceFailed", { error: pending.error }) : "")
                  : "";
                out.push(t("home.maintenance", { summary: hk.housekeepingSummary(plans) + next }));
              }
            }
          }
          out.push(status.coreLineOf(core.coreStatus()));
          setLines(out);
        };
        compute();
        off = core.subscribeCore(compute);
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, [deployment, on, hasNotes, maintenance, t, notes]);
  return lines;
}

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
  const s = useSession(); // the journal's activity re-renders through it
  const wide = useMediaQuery(DESKTOP_QUERY);
  const hasNotes = notes.some((n) => !n.spent);
  useEffect(() => {
    // the price reader (the chain client) loads with the first refresh, after Home renders
    if (hasNotes) void import("@privacy-wallet/sdk/prices").then((m) => m.priceStore.refresh(deployment));
  }, [deployment, hasNotes]);

  // Activity's own rows (Simple): Home's cards and recent lines say exactly what Activity says
  const rows = buildRows(s.status === "unlocked" ? session.journal() : null, operations, false, t);
  const advancedLines = useAdvancedLines(deployment, advanced, hasNotes, housekeeping.enabled, t);
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
        // V6 Stage 11: a swap's card opens its progress — where a paused order's choice is made; the rest open their detail
        onOperation: (id) =>
          navigate(
            /^swap:0x[0-9a-f]{64}$/i.test(id)
              ? `/swap/progress/${id.toLowerCase()}`
              : /^campaign:0x[0-9a-f]{64}$/i.test(id) && campaignById(id.slice("campaign:".length).toLowerCase())?.tier === "large-protected"
                ? `/swap/steps/${id.slice("campaign:".length).toLowerCase()}` // V6 Stage 13: the band's protected execution, in amounts
                : `/activity/${encodeURIComponent(id)}`,
          ),
      }}
    />
  );
}
