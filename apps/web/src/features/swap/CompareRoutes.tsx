// Compare routes (spec §3.6; plan §37): the table Route | Receive | Time | Risk | Privacy from the competition record,
// under Advanced only — the provider's name appears only here; elsewhere the word is "Best route". A route that
// quoted can be chosen over the winner ("Use this route"); the ones that refused, timed out or were filtered say so.
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { BottomSheet, Button } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { fmtUnits } from "@privacy-wallet/sdk/format";
import type { AssetRef, QuoteSet, RouteScore } from "@privacy-wallet/sdk/swapService";
import { hours, riskWord, settlementWords } from "./targets";

export function CompareRoutes({ open, onClose, quotes, to, advanced, onUse, busy }: { open: boolean; onClose: () => void; quotes: QuoteSet; to: AssetRef; advanced: boolean; onUse: (provider: string) => void; busy?: boolean }) {
  const t = useT();
  const chosen = quotes.chosen?.provider;
  return (
    <BottomSheet open={open} onClose={onClose} title={t("swap.compareTitle")} testId="compare-routes" id="compare-routes">
      <table className="ds-route-table" data-testid="route-table">
        <thead><tr><th>{t("swap.col.route")}</th><th>{t("swap.col.receive")}</th><th>{t("swap.col.time")}</th><th>{t("swap.col.risk")}</th><th>{t("swap.col.privacy")}</th><th /></tr></thead>
        <tbody>
          {quotes.scores.map((s: RouteScore) => {
            const q = quotes.quotes.find((x) => x.provider === s.provider);
            if (!q) return null;
            return (
              <tr key={s.provider} data-provider={s.provider} data-filtered={s.filtered ? "1" : "0"} data-testid="route-row">
                <td>
                  <b>{s.provider}</b>{chosen === s.provider ? ` · ${t("swap.bestRoute")}` : ""}
                  <div className="ds-note">
                    {t("swap.routeLine", { settlement: settlementWords(s.provider), bridge: q.nativeAssets ? t("swap.bridgeNone") : t("swap.bridgeWrapped") })}
                    {q.plan && q.plan.mode !== "single" ? ` · ${t("swap.planParts", { parts: q.plan.parts, time: hours(q.plan.expectedSeconds) })}` : ""}
                    {q.refundTarget === "destination" ? ` · ${t("swap.refundAtDestination")}` : ""}
                    {quotes.links?.[s.provider]?.public ? ` · ${t("swap.linkPublic")}` : ""}
                    {advanced && quotes.links?.[s.provider] ? ` · ${t("swap.linkEvidence", { evidence: quotes.links[s.provider].evidence })}` : ""}
                    {s.filtered ? ` · ${t("swap.notSelectable", { reason: s.filtered })}` : ""}
                    {advanced ? ` · ${t("swap.scoreLine", { total: s.total, price: s.components.price, security: s.components.security, latency: s.components.latency, reliability: s.components.reliability, liquidity: s.components.liquidity })}` : ""}
                  </div>
                </td>
                <td className="ds-tabular">{fmtUnits(q.toAmount, to.decimals)} {to.symbol}<div className="ds-note">{t("swap.atLeast", { amount: `${fmtUnits(q.toAmountMin, to.decimals)} ${to.symbol}` })}</div></td>
                <td>~{hours(q.etaSeconds)}</td>
                <td>{riskWord(s.components.security)}</td>
                <td>{levelOf(s.components.privacy)}</td>
                <td>{!s.filtered && chosen !== s.provider ? <Button variant="secondary" onClick={() => { onUse(s.provider); onClose(); }} disabled={busy} data-testid="use-route">{t("swap.useRoute")}</Button> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {quotes.competition?.filter((c) => c.outcome !== "quoted").map((c) => <div key={c.provider} className="ds-note" data-testid="route-outcome">{c.provider}: {c.outcome}{c.reason ? ` (${c.reason})` : ""}</div>)}
      {!quotes.competition ? Object.entries(quotes.errors).map(([p, e]) => <div key={p} className="ds-note">{p}: {e}</div>) : null}
    </BottomSheet>
  );
}
