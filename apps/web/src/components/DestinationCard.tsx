import { groupAddress } from "@privacy-wallet/protocol/wallet/destinations";
import { useT } from "../app/i18n/useT";

// The human-readable destination card (whale spec §21, plan V2 §58): Network, Asset, the address grouped in
// fours, the amount in the asset and in USD — shown wherever an address is confirmed (Swap, Withdraw,
// Guest, Receive). The QR alone is never the confirmation (plan §57). Its words are the catalog's (audit round 2, r55);
// the address is never translated.
export function DestinationCard({ network, asset, address, amount, usd, kind, title, status, label }: {
  network: string; asset: string; address: string; amount?: string; usd?: string | null; kind?: "fresh" | "entered" | "privacy-address"; title?: string;
  /** V6 Stage 12: in place of an address (a same-chain swap into the protected balance: "Your protected balance") */
  label?: string;
  /** High-Value Protection spec §12: what the address book says about this destination */
  status?: { text: string; ok: boolean } | null;
}) {
  const t = useT();
  return (
    <div className="panel" style={{ margin: "10px 0", padding: 14 }} data-testid="destination-card">
      <div className="muted small" style={{ marginBottom: 6 }}>{title ?? t("destCard.title")}</div>
      <div className="row"><span className="muted">{t("destCard.network")}</span><b>{network}</b></div>
      <div className="row"><span className="muted">{t("destCard.asset")}</span><b>{asset}</b></div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="muted">{t("destCard.address")}</span>
        {address ? <code style={{ fontSize: 13, textAlign: "right", maxWidth: 420 }} translate="no" data-testid="destination-grouped">{groupAddress(address)}</code> : <b data-testid="destination-label">{label ?? "—"}</b>}
      </div>
      {amount !== undefined && <div className="row"><span className="muted">{t("destCard.amount")}</span><b>{amount} {asset}{usd ? <span className="muted small"> · ≈ {usd}</span> : null}</b></div>}
      {kind && <div className="muted small" style={{ marginTop: 4 }}>{t(kind === "fresh" ? "destCard.fresh" : kind === "entered" ? "destCard.entered" : "destCard.privacy")}</div>}
      {status && <div className={status.ok ? "muted small" : "small level-Reduced"} data-testid="destination-card-status">{status.text}</div>}
    </div>
  );
}
