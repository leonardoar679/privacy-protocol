import { groupAddress } from "@privacy-wallet/protocol/wallet/destinations";

// The human-readable destination card (whale spec §21, plan V2 §58): Network, Asset, the address grouped in
// fours, the amount in the asset and in USD — shown wherever an address is confirmed (Swap, Withdraw,
// Guest, Receive). The QR alone is never the confirmation (plan §57).
export function DestinationCard({ network, asset, address, amount, usd, kind, title = "Destination", status }: {
  network: string; asset: string; address: string; amount?: string; usd?: string | null; kind?: "fresh" | "entered" | "privacy-address"; title?: string;
  /** High-Value Protection spec §12: what the address book says about this destination */
  status?: { text: string; ok: boolean } | null;
}) {
  return (
    <div className="panel" style={{ margin: "10px 0", padding: 14 }} data-testid="destination-card">
      <div className="muted small" style={{ marginBottom: 6 }}>{title}</div>
      <div className="row"><span className="muted">Network</span><b>{network}</b></div>
      <div className="row"><span className="muted">Asset</span><b>{asset}</b></div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="muted">Address</span>
        <code style={{ fontSize: 13, textAlign: "right", maxWidth: 420 }} data-testid="destination-grouped">{groupAddress(address)}</code>
      </div>
      {amount !== undefined && <div className="row"><span className="muted">Amount</span><b>{amount} {asset}{usd ? <span className="muted small"> · ≈ {usd}</span> : null}</b></div>}
      {kind && <div className="muted small" style={{ marginTop: 4 }}>{kind === "fresh" ? "A fresh address of this wallet, used once." : kind === "entered" ? "Entered by hand: check every group before you confirm." : "A privacy address: the payment stays inside the pool."}</div>}
      {status && <div className={status.ok ? "muted small" : "small level-Reduced"} data-testid="destination-card-status">{status.text}</div>}
    </div>
  );
}
