import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { publicBalanceViaInjectedWallet, type Deployment } from "../sdk/chain";
import { privacyAddress, scanNotes } from "../sdk/privateTx";
import { assetByVault, assetsOf, formatAmount } from "../sdk/assets";
import { useNotes } from "../wallet/notes";
import { useSettings } from "../wallet/settings";

// Consumer view (spec §72, plan §36): the private balance per asset (the sum of our unspent notes in
// that asset's vault — created here or discovered on chain, spec §12) and the public ETH balance of
// the connected account, read through that wallet's own provider so our RPC endpoints never see it.
export function PrivateBalance({ deployment, masterSeed, account }: { deployment: Deployment | null; masterSeed: Uint8Array; account: string | null }) {
  const notes = useNotes();
  const { advanced } = useSettings();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicWei, setPublicWei] = useState<bigint | null>(null);
  const assets = assetsOf(deployment);
  const address = privacyAddress(masterSeed);
  const balanceOf = (vault: string) => notes.filter((n) => !n.spent && n.note.vaultId === BigInt(vault)).reduce((s, n) => s + n.note.amount, 0n);
  const known = new Set(assets.map((a) => BigInt(a.vault)));
  const other = notes.filter((n) => !n.spent && !known.has(n.note.vaultId));
  const unspent = notes.filter((n) => !n.spent);

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
    <div className="panel">
      {assets.map((a) => (
        <div className="row" key={a.vault}>
          <span className="muted">Private {a.symbol}</span>
          <b>{formatAmount(a, balanceOf(a.vault))}</b>
        </div>
      ))}
      {other.length > 0 && <div className="row"><span className="muted">Notes in other vaults</span><b>{other.length}</b></div>}
      <div className="row">
        <span className="muted">Public ETH {account ? `(${account.slice(0, 6)}…${account.slice(-4)})` : ""}</span>
        <b>{account ? (publicWei === null ? "…" : formatEther(publicWei)) : "connect a wallet to see it"}</b>
      </div>
      <div className="row">
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
