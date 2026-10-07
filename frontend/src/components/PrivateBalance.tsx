import { useState } from "react";
import { formatEther } from "viem";
import type { Deployment } from "../sdk/chain";
import { privacyAddress, scanNotes } from "../sdk/privateTx";
import { useNotes } from "../wallet/notes";

// Consumer view (spec §72): the shielded balance is the sum of our unspent notes — those this
// session created plus those discovered on chain (payloads encrypted to our view key, spec §12).
export function PrivateBalance({ deployment, masterSeed }: { deployment: Deployment | null; masterSeed: Uint8Array }) {
  const notes = useNotes();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const vault = deployment ? BigInt(deployment.ethVault) : null;
  const mine = notes.filter((n) => vault === null || n.note.vaultId === vault);
  const unspent = mine.filter((n) => !n.spent);
  const total = unspent.reduce((s, n) => s + n.note.amount, 0n);
  const address = privacyAddress(masterSeed);

  async function rescan() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URL / VITE_CORE / VITE_ETH_VAULT)."); return; }
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
      <div className="row">
        <span className="muted">Private ETH</span>
        <b>{formatEther(total)}</b>
      </div>
      <div className="row">
        <span className="muted">Your privacy address (give this to senders)</span>
        <button className="tab" onClick={() => navigator.clipboard?.writeText(address)}>Copy</button>
      </div>
      <code style={{ fontSize: 11, wordBreak: "break-all" }}>{address}</code>
      {mine.length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {mine.map((n) => (
            <div key={`${n.leafIndex}-${n.txHash ?? ""}`} className="row">
              <span>leaf {n.leafIndex} · {n.label ?? "note"}{n.spent ? " · spent" : ""}</span>
              <span>{formatEther(n.note.amount)} ETH</span>
            </div>
          ))}
        </div>
      )}
      <div className="tabs" style={{ marginTop: 8 }}>
        <button className="tab" onClick={rescan} disabled={busy}>Rescan the chain for my notes</button>
      </div>
      {status && <p className="muted" style={{ fontSize: 12 }}>{status}</p>}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Notes are recovered from chain with the view key (payloads are encrypted to it); nothing is persisted to this site's storage. Merkle roots, nullifiers and the proof system stay hidden by design.
      </p>
    </div>
  );
}
