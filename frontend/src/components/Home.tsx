import { useEffect, useState } from "react";
import { formatUsd } from "@ref/wallet/valuation";
import type { Level } from "@ref/wallet/privacyCenter";
import type { Deployment } from "../sdk/chain";
import { assetsOf } from "../sdk/assets";
import { priceStore, usePrices, valueOfBalances } from "../sdk/prices";
import { useNotes } from "../wallet/notes";
import { useSchedulerStatus } from "../wallet/schedule";
import { useSettings } from "../wallet/settings";
import { useSession } from "../wallet/session";
import { housekeepingPlan, housekeepingSummary, pendingHousekeeping, plannedSteps } from "../wallet/housekeeping";
import { activeCampaigns, progressLine } from "../wallet/campaigns";
import { campaignStatus } from "./protection/CampaignProgress";
import { settings } from "../wallet/settings";
import { PrivateBalance } from "./PrivateBalance";

export type HomeSheet = "add-funds" | "receive" | "privacy" | "settings" | "ai";

// Home (plan V2 §43, §90–§92; whale spec §23): the private balance in USD as one large number, Send and
// Swap, the privacy badge that opens the Privacy Center, Add funds and Receive, the private services and
// Settings behind one gear. The per-asset lines, the notes and the rescan live behind "Details". The USD
// read happens only once there are notes to value (never at first launch, sdk/prices.ts).
export function Home({ masterSeed, deployment, account, privacyLevel, detailsOpen, onOpen, onTab }: {
  masterSeed: Uint8Array; deployment: Deployment | null; account: string | null; privacyLevel: Level | null; detailsOpen?: boolean;
  onOpen: (sheet: HomeSheet) => void; onTab: (tab: "swap" | "send") => void;
}) {
  const notes = useNotes();
  const prices = usePrices();
  const running = useSchedulerStatus();
  const { housekeeping, protection } = useSettings();
  useSession(); // the pending maintenance step lives in the journal
  const [details, setDetails] = useState(!!detailsOpen);
  useEffect(() => { if (detailsOpen) setDetails(true); }, [detailsOpen]);
  const assets = assetsOf(deployment);
  const unspent = notes.filter((n) => !n.spent);
  const hasNotes = unspent.length > 0;
  const lines = assets.map((a) => ({ symbol: a.symbol, decimals: a.decimals, units: unspent.filter((n) => n.note.vaultId === BigInt(a.vault)).reduce((s, n) => s + n.note.amount, 0n) }));
  // the price read: only with a deployment whose chain has feeds and unspent notes to value (the store checks both)
  useEffect(() => { if (hasNotes) void priceStore.refresh(deployment); }, [deployment, hasNotes]);

  const headline = (() => {
    if (!hasNotes) return { big: "—", small: "No private balance yet. Add funds to start." };
    if (prices.status === "not-configured" || prices.status === "idle") return { big: "—", small: "Balance in USD unavailable on this network; see Details for the amounts." };
    const v = valueOfBalances(prices, lines);
    if (prices.status === "loading" && !v.valued) return { big: "≈ …", small: "Reading prices through your RPC endpoints…" };
    if (!v.valued) return { big: "—", small: `Price unavailable${prices.reason ? ` (${prices.reason})` : ""}: large-transfer checks apply to every action.` };
    return { big: `≈ ${formatUsd(v.usd)}`, small: v.unpriced.length ? `Some assets are unpriced (${v.unpriced.join(", ")}); see Details.` : "Your private balance, valued through your own RPC endpoints." };
  })();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div data-testid="home">
      <div className="row" style={{ alignItems: "center" }}>
        <h1>{greeting}</h1>
        <button className="tab" onClick={() => onOpen("settings")} aria-label="Settings" title="Settings">⚙ Settings</button>
      </div>
      <div className="panel">
        <div className="muted small">Private balance</div>
        <div className="numeral" data-testid="private-usd">{headline.big}</div>
        <div className="muted small" style={{ marginTop: 4 }}>{headline.small}</div>
        <div className="home-actions">
          <button className="primary" onClick={() => onTab("send")}>Send</button>
          <button className="primary" onClick={() => onTab("swap")}>Swap</button>
        </div>
        <div className="quiet-actions">
          <button className="tab" onClick={() => onOpen("add-funds")}>Add funds</button>
          <button className="tab" onClick={() => onOpen("receive")}>Receive</button>
          <button className="badge shield" onClick={() => onOpen("privacy")} title="Privacy Center" data-testid="privacy-badge">🛡 Privacy: {privacyLevel ?? "—"}</button>
          <button className="tab" onClick={() => setDetails((v) => !v)}>{details ? "Hide details" : "Details"}</button>
        </div>
        {running.running && <p className="notice" style={{ marginTop: 10 }}>{running.running.line}</p>}
        {activeCampaigns().map((c) => { const st = campaignStatus(c); return (
          <div key={c.id} className="notice" style={{ marginTop: 10 }} data-testid="campaign-line">
            <b className={st.mark === "✓" ? "level-Excellent" : st.mark === "⚠" ? "level-Reduced" : "level-Good"}>{st.mark} {st.word}</b> · Protected swap {c.request.from.symbol} → {c.request.to.symbol}: {progressLine(c)}.
            <label style={{ display: "block", color: "var(--fg)", marginTop: 6 }}><input type="checkbox" checked={protection.pauseLargeOperations} onChange={(e: any) => settings.set({ protection: { ...protection, pauseLargeOperations: e.target.checked } })} data-testid="pause-large-operations" /> Pause large operations (the wallet's automation only; steps already handed over finish)</label>
          </div>
        ); })}
        {hasNotes && deployment && (() => {
          const plans = housekeepingPlan(deployment);
          const steps = plannedSteps(plans);
          const pending = pendingHousekeeping();
          if (!steps && !pending) return null;
          return (
            <p className="muted small" style={{ marginTop: 10 }} data-testid="maintenance">
              Private balance maintenance: {housekeeping.enabled ? `${housekeepingSummary(plans)}${pending ? ` Next step ${new Date(pending.dueAt).toLocaleString()}${pending.error ? ` (the last attempt failed: ${pending.error})` : ""}.` : ""}` : `${steps} step${steps === 1 ? "" : "s"} would help; maintenance is off under Settings.`}
            </p>
          );
        })()}
      </div>
      {details && (
        <>
          <PrivateBalance deployment={deployment} masterSeed={masterSeed} account={account} />
          <div className="panel">
            <h3>Private services</h3>
            <p className="muted small">Pay for inference from a private credit account; the AI never holds keys and never signs anything.</p>
            <button className="tab" onClick={() => onOpen("ai")}>Private AI</button>
          </div>
        </>
      )}
    </div>
  );
}
