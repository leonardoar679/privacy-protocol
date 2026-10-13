import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { availablePrice, formatUsd, usdOf } from "@privacy-wallet/protocol/wallet/valuation";
import { publicBalanceViaInjectedWallet, type Deployment } from "@privacy-wallet/sdk/chain";
import { privacyAddress, scanNotes } from "@privacy-wallet/sdk/privateTx";
import { assetByVault, assetsOf, formatAmount } from "@privacy-wallet/sdk/assets";
import { useNotes, usePrices, useSettings } from "../hooks";

// The per-asset view behind Home's "Details" (spec §72, plan §36, plan V2 §43): the private balance per
// asset (the sum of our unspent notes in that asset's vault — created here or discovered on chain, spec
// §12) with its USD value when a price is known, the public ETH balance of the connected account read
// through that wallet's own provider (our RPC endpoints never see it), the privacy address, the notes
// (Advanced) and the rescan. The USD read itself is triggered by Home (never at first launch).
export function PrivateBalance({ deployment, masterSeed, account }: { deployment: Deployment | null; masterSeed: Uint8Array; account: string | null }) {
  const notes = useNotes();
  const { advanced } = useSettings();
  const prices = usePrices();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicWei, setPublicWei] = useState<bigint | null>(null);
  const assets = assetsOf(deployment);
  const address = privacyAddress(masterSeed);
  const balanceOf = (vault: string) => notes.filter((n) => !n.spent && n.note.vaultId === BigInt(vault)).reduce((s, n) => s + n.note.amount, 0n);
  const known = new Set(assets.map((a) => BigInt(a.vault)));
  const other = notes.filter((n) => !n.spent && !known.has(n.note.vaultId));
  const unspent = notes.filter((n) => !n.spent);
  const usdLine = (a: { symbol: string; decimals: number }, bal: bigint): string | null => {
    const p = availablePrice(prices.prices, a.symbol);
    return p && bal > 0n ? formatUsd(usdOf(bal, a.decimals, p.usd1e8)) : null;
  };

  useEffect(() => {
    if (!account) { setPublicWei(null); return; }
    publicBalanceViaInjectedWallet(account).then(setPublicWei).catch(() => setPublicWei(null));
  }, [account]);

  async function rescan() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    setBusy(true);
    try {
      const r = await scanNotes({ masterSeed, deployment, onStatus: setStatus });
      setStatus(`Scanned ${r.scanned} payloads: ${r.found} ours, ${r.added} new, ${r.spent} spent.`);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="private-assets">
      <h3>Private assets</h3>
      {assets.map((a) => {
        const bal = balanceOf(a.vault);
        const usd = usdLine(a, bal);
        return (
          <div className="row" key={a.vault}>
            <span className="muted">Private {a.symbol}</span>
            <b>{formatAmount(a, bal)}{usd ? <span className="muted small"> · ≈ {usd}</span> : null}</b>
          </div>
        );
      })}
      {other.length > 0 && <div className="row"><span className="muted">Notes in other vaults</span><b>{other.length}</b></div>}
      <div className="row">
        <span className="muted">Public ETH {account ? `(${account.slice(0, 6)}…${account.slice(-4)})` : ""}</span>
        <b>{account ? (publicWei === null ? "…" : formatEther(publicWei)) : "connect a wallet under Add funds to see it"}</b>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Your privacy address (give this to senders)</span>
        <button className="tab" onClick={() => navigator.clipboard?.writeText(address)}>Copy</button>
      </div>
      <code style={{ fontSize: 11, wordBreak: "break-all" }}>{address}</code>
      {notes.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {advanced
            ? notes.map((n) => {
                const a = assetByVault(deployment, n.note.vaultId);
                return (
                  <div key={`${n.leafIndex}-${n.txHash ?? ""}`} className="row">
                    <span>leaf {n.leafIndex} · {n.label ?? "note"}{n.spent ? " · spent" : ""}</span>
                    <span>{a ? `${formatAmount(a, n.note.amount)} ${a.symbol}` : `${n.note.amount} units (vault ${n.note.vaultId.toString(16).slice(0, 8)}…)`}</span>
                  </div>
                );
              })
            : <div>{unspent.length} spendable note{unspent.length === 1 ? "" : "s"}{notes.length > unspent.length ? ` · ${notes.length - unspent.length} spent` : ""}</div>}
        </div>
      )}
      <div className="tabs" style={{ marginTop: 8 }}>
        <button className="tab" onClick={rescan} disabled={busy}>Rescan the chain for my notes</button>
      </div>
      {status && <p className="muted" style={{ fontSize: 12 }}>{status}</p>}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Notes are recovered from chain with the view key (payloads are encrypted to it) and kept in your encrypted journal.{advanced ? " Merkle roots, nullifiers and the proof system stay hidden by design." : ""}
      </p>
    </div>
  );
}
